/**
 * 把 vendor/ 里的预编译 node-pty 软链进 node_modules。
 *
 * 存在的理由：开发机所处网络下 npm registry 不可达，而 M0 外壳必须要 PTY。
 * vendor 的是 @lydell/node-pty@1.1.0 的 darwin-arm64 预编译产物（MIT）。
 * 如果 node_modules 里已经有真货（网络恢复后 npm install 装的），就不动它。
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = join(root, 'node_modules', '@lydell');

const links = [
  ['node-pty', '../../vendor/node-pty'],
  [`node-pty-${process.platform}-${process.arch}`, `../../vendor/node-pty-${process.platform}-${process.arch}`],
];

mkdirSync(scope, { recursive: true });

for (const [name, target] of links) {
  const linkPath = join(scope, name);
  const targetAbs = resolve(scope, target);

  if (!existsSync(targetAbs)) {
    console.warn(`[link-vendor] 跳过 ${name}：vendor 里没有 ${target}（本平台无预编译产物，需要 npm install）`);
    continue;
  }
  let existing = null;
  try { existing = lstatSync(linkPath); } catch { /* 不存在 */ }
  if (existing !== null) {
    if (!existing.isSymbolicLink()) {
      console.log(`[link-vendor] ${name} 已由 npm 安装，保留不动`);
      continue;
    }
    unlinkSync(linkPath);
  }
  symlinkSync(target, linkPath, 'dir');
  console.log(`[link-vendor] ${name} -> ${target}`);
}
