/** 前端导出的统一入口：带 BOM 的 CSV，Excel 直接可读 */

const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function downloadCsv(filename: string, head: string[], rows: unknown[][]): void {
  const body = rows.map((r) => r.map(cell).join(','));
  const csv = `\ufeff${[head.map(cell).join(','), ...body].join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 文件名里的项目名可能含点号，这里统一规整 */
export function csvName(prefix: string, project: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${prefix}_${project || 'project'}_${day}.csv`;
}
