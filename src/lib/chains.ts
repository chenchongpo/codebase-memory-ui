import type { CallChain, ChainStep, ChainVia, ChainViaKind } from '../types';

/* ------------------------------------------------------------- 解析溯源展示 */
/**
 * 三档溯源在界面上的呈现。
 *
 * 设计原则：**不隐藏不准确的跳，只把它标出来让用户核对**。
 * 所以 suspect 用 --danger 描边（而不是过滤/删除），inferred 用淡虚线（提示"无类型依据"），
 * exact 不做任何额外修饰 —— 正常链路保持干净，异常才跳出来。
 */
export const VIA_META: Record<ChainViaKind, { short: string; label: string; tone: string; color: string }> = {
  exact: { short: '确', label: '有类型依据', tone: 'ok', color: 'var(--fg-mid)' },
  inferred: { short: '推', label: '项目内唯一同名推断', tone: 'warn', color: 'var(--warn)' },
  suspect: { short: '疑', label: '推断不可靠', tone: 'danger', color: 'var(--danger)' },
};

/** 一步的溯源说明，用于 tooltip：讲清「它是怎么被解出来的」和「为什么要核对」 */
export function viaHint(via: ChainVia | null | undefined): string {
  if (!via) return '';
  const head = `解析方式：${via.strategy}`;
  if (via.kind === 'exact') return `${head} · 有类型依据，可信`;
  if (via.kind === 'inferred') {
    return `${head} · 全项目只有这一个同名方法，按名字认定；没有类型依据，通常正确但请留意`;
  }
  const bits = [head];
  if (via.callee) bits.push(`源码写作 ${via.callee}`);
  if (via.candidates > 1) bits.push(`${via.candidates} 个同名候选里挑了一个`);
  if (via.external) bits.push(`「${via.callee.split('.').pop()}」是常见 JDK/库方法名，很可能是外部调用被错接到项目内同名方法`);
  bits.push('这一步不可靠，请对照源码核对');
  return bits.join(' · ');
}

/* --------------------------------------------------------------- 反向调用树 */

export interface TreeRow {
  /** `${depth}:${nodeId}`，同层同节点合并 */
  key: string;
  depth: number;
  parentKey: string | null;
  step: ChainStep;
  /** 经过该节点的链路条数 */
  chains: number;
  /** 该节点调用其父节点（= 上一层被调方）的行号 */
  callLine: number;
}

export interface CallTreeModel {
  rows: TreeRow[];
  byKey: Map<string, TreeRow>;
  /** 根 = 被调用节点（可能有多个：类展开成多个方法时） */
  roots: TreeRow[];
  /** 从根算起的最大层数 */
  maxDepth: number;
  /** 节点数超上限被截断 */
  truncated: boolean;
  children: Map<string, TreeRow[]>;
}

/**
 * 把「反向链路」折成以被调用节点为根的树。
 *
 * 链路方向是 最外层调用方 → … → 目标，所以从尾部往前读：目标当根，上一层是它的调用方。
 * 同层同节点只保留一份（多个调用方调到同一个上层方法时不会重复画），
 * 因此最终形状更接近「带合并的调用树」而不是严格的树。
 */
export function buildCallTree(chains: CallChain[], maxNodes = 900): CallTreeModel {
  const byKey = new Map<string, TreeRow>();
  const rows: TreeRow[] = [];
  const roots: TreeRow[] = [];
  let truncated = false;

  for (const c of chains) {
    let parent: TreeRow | null = null;
    for (let i = c.steps.length - 1; i >= 0; i -= 1) {
      const s = c.steps[i];
      const depth = c.steps.length - 1 - i;
      const key = `${depth}:${s.id}`;
      let row = byKey.get(key);
      if (!row) {
        if (rows.length >= maxNodes) {
          truncated = true;
          break;
        }
        row = {
          key,
          depth,
          parentKey: parent ? parent.key : null,
          step: s,
          chains: 0,
          callLine: s.callLine,
        };
        byKey.set(key, row);
        rows.push(row);
        if (depth === 0) roots.push(row);
      }
      row.chains += 1;
      parent = row;
    }
  }

  const children = new Map<string, TreeRow[]>();
  for (const r of rows) {
    if (!r.parentKey) continue;
    const list = children.get(r.parentKey);
    if (list) list.push(r);
    else children.set(r.parentKey, [r]);
  }

  const maxDepth = rows.reduce((m, r) => Math.max(m, r.depth), 0);
  return { rows, byKey, roots, maxDepth, truncated, children };
}

/** 溯源在 CSV 里的文字口径：导出后可在 Excel 里筛出所有「疑」逐条核对 */
export function viaCsvText(via: ChainVia | null | undefined): string {
  if (!via) return '';
  if (via.kind === 'exact') return '可信';
  if (via.kind === 'inferred') return '推断(唯一同名)';
  return via.external ? '疑(疑似外部调用)' : '疑(多候选后缀匹配)';
}

/** 树表：一行一个节点，父节点即「它调用了谁」 */
export function treeCsvRows(model: CallTreeModel): (string | number)[][] {
  return model.rows.map((r) => [
    r.depth,
    r.step.cls || '—',
    r.step.name,
    r.parentKey ? `${r.parentKey.split(':')[1]}` : '',
    r.parentKey ? `${model.byKey.get(r.parentKey)?.step.cls ?? ''}.${model.byKey.get(r.parentKey)?.step.name ?? ''}` : '（根·被调用节点）',
    r.callLine || '',
    r.chains,
    r.step.isEntry ? '是' : '',
    r.step.virtual ? '是' : '',
    r.step.file,
    r.step.line,
    viaCsvText(r.step.via),
    r.step.via?.strategy ?? '',
    r.step.via?.callee ?? '',
    r.step.via?.candidates || '',
  ]);
}

export const TREE_CSV_HEAD = [
  '层级(0=根)',
  '所属类',
  '节点方法',
  '父节点ID',
  '它调用了(父节点)',
  '调用行号',
  '经过链路数',
  '是否入口',
  '是否接口派发',
  '文件',
  '起始行',
  '解析溯源',
  '解析策略',
  '源码调用形式',
  '候选数',
];

/* ----------------------------------------------------------------- 正向时序 */

export interface SeqParticipant {
  key: string;
  cls: string;
  name: string;
  /** 参与的消息序号（从 1 起） */
  first: number;
  last: number;
  /** 参与的链路条数（表头展示 ×n） */
  freq: number;
}

export interface SeqMessage {
  /** 第几条消息（从 1 起）；等于调用深度：L1 = 入口的直接调用 */
  i: number;
  from: number;
  to: number;
  fromStep: ChainStep;
  toStep: ChainStep;
  /** 发起调用的行号 */
  line: number;
  virtual: boolean;
}

export const SEQ_CSV_HEAD = [
  '序号',
  '调用方类',
  '调用方方法',
  '被调类',
  '被调方法',
  '调用行号',
  '是否接口派发',
  '被调是否入口',
  '调用方文件',
  '位置行',
  '解析溯源',
  '解析策略',
  '源码调用形式',
  '候选数',
];

/* ------------------------------------------------------- 合并时序画布（全部链路） */

/**
 * 合并画布的一个链路带：一条完整链路的时序消息。
 *
 * 为什么不画成一张单链时序图再翻页：一次查询动辄几百条链路
 * （RuoYi 实测 SysUserServiceImpl 280 条、SysUserController 500 条），
 * 逐条翻页没法横向比较，也看不到链路之间的共性。
 * 合并画布把所有链路竖着堆在一张画布里，并且**让同一个类始终落在同一列**，
 * 于是纵向扫一列就能看出「谁总在这一步被调用」。
 */
export interface SeqBand {
  /** 该链在 chains 中的序号（0 基），与明细表行号一致 */
  index: number;
  hops: number;
  suspect: number;
  /** 起点方法名，画在左侧 gutter */
  head: string;
  entryStep: ChainStep;
  messages: SeqMessage[];
}

export interface SeqCanvasModel {
  /**
   * 跨所有链路合并的参与者列，**按调用时序排序**：
   * 沿链路扫描的首次出现顺序 = 入口类最左，越靠右被调得越晚（近似调用深度递增方向）。
   * 单条链的参与者从左到右正好是调用顺序；多链合并时同类始终同列，纵向可比。
   */
  participants: SeqParticipant[];
  bands: SeqBand[];
  /** 全部消息行数，决定画布高度 */
  totalRows: number;
  /** 因行数超上限被跳过的链路数（0 表示全部画出） */
  droppedChains: number;
}

/**
 * 把多条链路折成一张合并画布。
 *
 * @param maxRows 消息行上限，防止几百条链路把浏览器画卡；超出部分不画并回报 droppedChains
 */
export function buildSequenceCanvas(chains: CallChain[], maxRows = 4000): SeqCanvasModel {
  const keyOf = (s: ChainStep) => s.cls || s.label || s.name;

  /* 1. 参与者列序 = 调用时序（首次出现顺序）；频次只用于表头的 ×n 展示 */
  const freq = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let seen = 0;
  for (const c of chains) {
    for (const s of c.steps) {
      const k = keyOf(s);
      freq.set(k, (freq.get(k) ?? 0) + 1);
      if (!firstSeen.has(k)) firstSeen.set(k, seen++);
    }
  }
  const ordered = [...freq.keys()].sort(
    (a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0) || a.localeCompare(b)
  );
  const col = new Map(ordered.map((k, i) => [k, i]));

  const participants: SeqParticipant[] = ordered.map((k) => {
    const sample = chains.flatMap((c) => c.steps).find((s) => keyOf(s) === k);
    return { key: k, cls: sample?.cls ?? '', name: sample?.cls || k, first: 0, last: 0, freq: freq.get(k) ?? 0 };
  });

  /* 2. 逐链生成消息，列号用全局表，保证同类同列 */
  const bands: SeqBand[] = [];
  let totalRows = 0;
  let droppedChains = 0;
  for (let i = 0; i < chains.length; i += 1) {
    const c = chains[i];
    const msgs: SeqMessage[] = [];
    for (let k = 1; k < c.steps.length; k += 1) {
      const prev = c.steps[k - 1];
      const cur = c.steps[k];
      msgs.push({
        i: k,
        from: col.get(keyOf(prev)) ?? 0,
        to: col.get(keyOf(cur)) ?? 0,
        fromStep: prev,
        toStep: cur,
        line: prev.callLine,
        virtual: cur.virtual,
      });
    }
    if (!msgs.length) continue;
    if (totalRows + msgs.length > maxRows) {
      droppedChains = chains.length - i;
      break;
    }
    totalRows += msgs.length;
    bands.push({
      index: i,
      hops: c.hops,
      suspect: c.suspect ?? 0,
      head: c.steps[0] ? `${c.steps[0].cls ? `${c.steps[0].cls}.` : ''}${c.steps[0].name}` : `#${i + 1}`,
      entryStep: c.steps[0],
      messages: msgs,
    });
  }

  return { participants, bands, totalRows, droppedChains };
}

/** 合并画布导出：每行一次调用，前面加「链路#」列便于回到画布定位 */
export const CANVAS_CSV_HEAD = ['链路#', ...SEQ_CSV_HEAD];

export function canvasCsvRows(model: SeqCanvasModel): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const b of model.bands) {
    for (const m of b.messages) {
      rows.push([
        b.index + 1,
        m.i,
        m.fromStep.cls || '—',
        m.fromStep.name,
        m.toStep.cls || '—',
        m.toStep.name,
        m.line || '',
        m.virtual ? '是' : '',
        m.toStep.isEntry ? '是' : '',
        m.fromStep.file,
        m.line || m.fromStep.line,
        viaCsvText(m.toStep.via),
        m.toStep.via?.strategy ?? '',
        m.toStep.via?.callee ?? '',
        m.toStep.via?.candidates || '',
      ]);
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ 链路明细 */

export const CHAIN_CSV_HEAD = ['序号', '层数', '起点是否入口', '是否触及深度上限', '不可靠跳数', '推断跳数', '链路', '起点', '终点'];

export function chainCsvRows(chains: CallChain[]): (string | number)[][] {
  return chains.map((c, i) => {
    const first = c.steps[0];
    const last = c.steps[c.steps.length - 1];
    return [
      i + 1,
      c.hops,
      c.entry ? '是' : '',
      c.cut ? '是' : '',
      c.suspect || '',
      c.inferred || '',
      c.steps.map((s) => `${s.cls ? `${s.cls}.` : ''}${s.name}`).join(' → '),
      first ? `${first.cls ? `${first.cls}.` : ''}${first.name} (${first.file}:${first.line})` : '',
      last ? `${last.cls ? `${last.cls}.` : ''}${last.name} (${last.file}:${last.line})` : '',
    ];
  });
}
