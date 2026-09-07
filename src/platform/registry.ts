import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { BUILTIN_GAMES } from './arcade.ts';
import type { GameManifest, GameModule } from './types.ts';

const MANIFEST = 'moyu.game.json';
function root(): string { return path.join(process.env.MOYU_HOME ?? path.join(homedir(), '.moyu'), 'games'); }

export function validateManifest(value: unknown): GameManifest {
  if (typeof value !== 'object' || value === null) throw new Error('manifest 必须是 JSON 对象');
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(m.id)) throw new Error('id 只能使用小写字母、数字和连字符');
  for (const key of ['name', 'version', 'author', 'description', 'entry']) if (typeof m[key] !== 'string' || m[key] === '') throw new Error(`${key} 不能为空`);
  if (m.apiVersion !== 1) throw new Error(`只支持 apiVersion 1，得到 ${String(m.apiVersion)}`);
  const viewport = m.viewport as Record<string, unknown> | undefined;
  if (typeof viewport?.width !== 'number' || typeof viewport.height !== 'number'
    || viewport.width < 8 || viewport.width > 320 || viewport.height < 8 || viewport.height > 200) throw new Error('viewport 必须在 8×8 到 320×200 之间');
  const micro = m.microViewport as Record<string, unknown> | undefined;
  if (micro !== undefined && (typeof micro.width !== 'number' || typeof micro.height !== 'number'
    || micro.width < 8 || micro.width > 160 || micro.height < 8 || micro.height > 32)) throw new Error('microViewport 必须在 8×8 到 160×32 之间');
  if (!Array.isArray(m.palette) || m.palette.length < 2 || m.palette.length > 16
    || !m.palette.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))) throw new Error('palette 必须包含 2–16 个 #RRGGBB 颜色');
  if (!Array.isArray(m.controls)) throw new Error('controls 必须是数组');
  const display = m.display as Record<string, unknown> | undefined;
  if (display !== undefined && (display === null || typeof display !== 'object'
    || typeof display.micro !== 'boolean' || !Number.isInteger(display.minRows)
    || Number(display.minRows) < 4 || Number(display.minRows) > 24)) throw new Error('display 需要 micro 布尔值和 4–24 的整数 minRows');
  if (display?.glyphs !== undefined && display.glyphs !== 'dots' && display.glyphs !== 'blocks') throw new Error('display.glyphs 只能是 dots 或 blocks');
  for (const control of m.controls) {
    if (typeof control !== 'object' || control === null || typeof control.action !== 'string'
      || typeof control.label !== 'string' || !Array.isArray(control.keys)
      || !control.keys.every((key: unknown) => typeof key === 'string')) throw new Error('controls 每项需要 action、label 和 keys 字符串数组');
  }
  const entry = m.entry as string;
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw new Error('entry 必须是游戏目录内的相对路径');
  return value as GameManifest;
}

function readManifest(dir: string): GameManifest {
  return validateManifest(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as unknown);
}

function installed(): Array<{ dir: string; manifest: GameManifest }> {
  let names: string[];
  try { names = fs.readdirSync(root()); } catch { return []; }
  const out: Array<{ dir: string; manifest: GameManifest }> = [];
  for (const name of names.sort()) try {
    const dir = path.join(root(), name);
    if (fs.statSync(dir).isDirectory()) out.push({ dir, manifest: readManifest(dir) });
  } catch { /* invalid packages are reported by doctor/list instead of breaking startup */ }
  return out;
}

export async function loadGameModules(): Promise<GameModule[]> {
  const modules = [...BUILTIN_GAMES];
  for (const item of installed()) try {
    if (modules.some((m) => m.manifest.id === item.manifest.id)) continue;
    const entry = path.resolve(item.dir, item.manifest.entry);
    if (!entry.startsWith(`${path.resolve(item.dir)}${path.sep}`)) continue;
    const loaded = await import(pathToFileURL(entry).href);
    const candidate = (loaded.default ?? loaded) as Partial<GameModule>;
    if (typeof candidate.create !== 'function') continue;
    modules.push({ manifest: item.manifest, create: candidate.create });
  } catch { /* one cartridge must never prevent the coding shell from starting */ }
  return modules;
}

export async function cmdGames(args: string[]): Promise<number> {
  const action = args[0] ?? 'list';
  if (action === 'list') {
    for (const game of BUILTIN_GAMES) process.stdout.write(`${game.manifest.id.padEnd(16)} ${game.manifest.name}  内置\n`);
    for (const game of installed()) process.stdout.write(`${game.manifest.id.padEnd(16)} ${game.manifest.name}  本地\n`);
    return 0;
  }
  if (action === 'add') {
    const source = args[1] === undefined ? '' : path.resolve(args[1]);
    let manifest: GameManifest;
    try { manifest = readManifest(source); } catch (e) {
      process.stderr.write(`moyu games add: ${e instanceof Error ? e.message : String(e)}\n`); return 2;
    }
    if (BUILTIN_GAMES.some((g) => g.manifest.id === manifest.id)) {
      process.stderr.write(`${manifest.id} 是内置游戏 id，不能覆盖\n`); return 2;
    }
    if (!args.includes('--yes')) {
      process.stdout.write([
        `将安装 ${manifest.name} (${manifest.id})`,
        `来源：${source}`,
        '本地 JavaScript Cartridge 是受信任代码，可读取当前用户能访问的文件和网络。',
        `确认信任后运行：moyu games add ${JSON.stringify(source)} --yes`,
      ].join('\n') + '\n');
      return 2;
    }
    const dest = path.join(root(), manifest.id);
    if (fs.existsSync(dest)) { process.stderr.write(`已存在 ${manifest.id}，请先 remove\n`); return 2; }
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    fs.cpSync(source, dest, { recursive: true, errorOnExist: true, force: false });
    process.stdout.write(`已安装 ${manifest.name} → ${dest}\n`); return 0;
  }
  if (action === 'remove') {
    const id = args[1] ?? '';
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) { process.stderr.write('请指定合法的游戏 id\n'); return 2; }
    const dest = path.join(root(), id);
    if (!fs.existsSync(dest)) { process.stderr.write(`没有安装 ${id}\n`); return 2; }
    if (!args.includes('--yes')) { process.stdout.write(`将删除 ${dest}\n确认后运行：moyu games remove ${id} --yes\n`); return 2; }
    fs.rmSync(dest, { recursive: true }); process.stdout.write(`已移除 ${id}\n`); return 0;
  }
  process.stderr.write('用法：moyu games list | add <目录> [--yes] | remove <id> [--yes]\n'); return 2;
}
