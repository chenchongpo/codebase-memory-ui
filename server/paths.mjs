/**
 * 路径解析：以 server/ 所在位置为锚点推导 dist/ 与 config/。
 *
 * 仓库布局（server/ 与 dist/ 同级）→ 取上一级；
 * 离线包布局（dist 就在当前目录）→ 取当前目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** server/ 与 dist/ 同级（仓库布局）时取上一级；dist 就在当前目录（离线包布局）时取当前目录 */
export const APP_ROOT = fs.existsSync(path.join(HERE, 'dist')) ? HERE : path.resolve(HERE, '..');

export const DIST_DIR = path.join(APP_ROOT, 'dist');
export const CONFIG_DIR = path.join(APP_ROOT, 'config');

export { HERE };
