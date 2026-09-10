#!/usr/bin/env node
/**
 * Moyu host: one quiet standby row, one-key access to a responsive handheld,
 * and byte-exact ownership of everything that belongs to the wrapped CLI.
 *
 * The inner PTY always starts at physical row 1. Standby owns the bottom row; while playing
 * Codex, a two-row cartridge can temporarily overlay the rows immediately above its composer.
 * Absolute cursor coordinates still need no translation and terminal scrollback survives.
 * A rendered frame is emitted as one write and always ends by restoring the CLI cursor.
 */

import { computeLayout, scrollRegionSeq, fullScrollRegionSeq, assertLayout, fieldColsFor, MICRO_GAME_ROWS, type Focus, type Layout } from '../shell/regions.ts';
import { Passthrough } from '../shell/passthrough.ts';
import { VtCursor } from '../shell/vtcursor.ts';
import { PtyHost } from '../shell/pty.ts';
import { Teardown, doctorResetSeq, writeAllSync, type RestoreOptions } from '../shell/teardown.ts';
import { ScreenArbiter } from '../shell/altscreen.ts';
import { InputRouter, hotkeyHint } from '../shell/focus.ts';
import { Canvas } from '../render/canvas.ts';
import { BrailleTarget } from '../render/braille.ts';
import { GraphicsTarget, deleteImageSeq } from '../render/graphics.ts';
import { probeCaps, knownGraphicsTerm, DEFAULT_CELL } from '../render/caps.ts';
import { stripPainter, type Painter } from '../render/painter.ts';
import type { PixelTarget, Tier } from '../render/target.ts';
import { paintWorld } from '../render/scene.ts';
import { fitRow } from '../render/text.ts';
import { PlaySurface } from '../platform/surface.ts';
import { paintScene, paintStress } from './scene0.ts';
import { Arcade } from '../platform/arcade.ts';
import { cmdPlay } from '../platform/play.ts';
import { cmdGames, loadGameModules } from '../platform/registry.ts';
import type { GameModule } from '../platform/types.ts';
import { cmdDemo } from './demo.ts';
import { appendSignal, eventsPath, type Signal } from '../bridge/signal.ts';
import { hookSnippet, plan, apply, status, detected, eventSignals, homeVar, TARGET_NAME, type Target } from '../bridge/install.ts';
import { World } from '../core/world.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

const FPS = 30;
const FRAME_MS = 1000 / FPS;

/**
 * stdout 积压超过这个字节数就跳过这一帧。
 *
 * 内层的吞吐**永远**优先于游戏：内层刷屏时丢几帧游戏没人在意，反过来让 CLI 的输出
 * 卡在我们的队列后面则是不可接受的 —— 那时候用户正在看的就是 CLI。
 */
const BACKPRESSURE = 48 * 1024;

/**
 * HUD 和收起条共用的三套配色。
 *
 * 提出来是因为它们必须**一模一样** —— 收起条就是 HUD 塌成一行的样子，两处各写一份
 * 迟早会漂移成"收起之后颜色突然变了"。等待权限那档故意用刺眼的琥珀底：那是唯一一种
 * 你不看一眼就会一直卡着的状态。
 */
// 候场行故意不用色块背景。它应该融进 coding CLI，只在用户主动看向右下角时被发现。
const SGR_URGENT = '\x1b[38;2;226;190;96m\x1b[49m';
const SGR_IDLE = '\x1b[38;2;112;118;134m\x1b[49m';

/**
 * 焦点切换的最小间隔。
 *
 * 焦点变化会 resize PTY，而 resize 让内层 TUI 全量重绘 —— 连按会把它抖成一片。
 */
const FOCUS_DEBOUNCE_MS = 180;
/** A repaint may span several PTY reads; choose its anchor only after output has gone quiet. */
const COMPOSER_SETTLE_MS = 60;
/** Repaint authorization is causally useful only near the resize/refresh/control that created it. */
const COMPOSER_PERMIT_MS = 750;

function usage(): string {
  return [
    '摸鱼 —— Agent 在干活，你在掌机里',
    '',
    '用法：',
    '  moyu play [游戏id]       独立打开终端掌机，Tab 切换游戏',
    '  moyu games list          查看内置和本地 Cartridge',
    '  moyu setup               安装可选任务联动 hook',
    '  moyu -- <命令...>        包住 coding CLI，底部一行待机（例：moyu -- codex）',
    '  moyu demo                整屏跑游戏本身（调手感用）',
    '  moyu install             把任务信号 hook 装进 Claude Code / Codex（默认干跑，加 --write 才写）',
    '  moyu install --uninstall 摘掉它们（同样默认干跑）',
    '  moyu hook [--codex]      只打印配置片段，自己手动并进去',
    '  moyu signal start|done   手动喂一个任务信号（给别的 CLI 做集成）',
    '  moyu doctor              体检：hook 装没装、事件文件、PTY、node 版本',
    '  moyu bench [帧数] [--stress|--game|--strip] [--tier=graphics|braille|half]  无头跑渲染',
    '  moyu doctor --caps       打印渲染档位探测结果（只有在真终端里跑才有意义）',
    '  moyu doctor --gfx        严格发送 Kitty 图片，只用于诊断协议链路',
    '  moyu doctor --visual     原生像素动作对比，Tab 新旧、空格暂停、Esc 退出',
    '  moyu doctor --reset      终端被搞坏之后无条件还原',
    '',
    '游戏内：方向键/WASD 移动 · J 动作 · 空格 跳/直落 · Tab 换游戏 · Esc/q 返回',
    `外壳：${hotkeyHint('cli')} · F12 备用 · Ctrl+G/Ctrl+C 始终属于 coding CLI`,
  ].join('\n');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'doctor') {
    if (argv.includes('--visual')) return (await import('../platform/pixel-demo.ts')).cmdPixelDemo();
    if (argv.includes('--caps') || argv.includes('--gfx')) return cmdCaps(argv.includes('--gfx'));
    if (argv.includes('--reset')) { writeAllSync(1, doctorResetSeq()); return 0; }
    return cmdDoctor();
  }
  if (cmd === 'install') return cmdInstall(argv.slice(1));
  if (cmd === 'demo') return cmdDemo(argv[1] === undefined ? undefined : Number(argv[1]));
  if (cmd === 'setup') return cmdInstall(['--write', ...argv.slice(1)]);
  if (cmd === 'games') return cmdGames(argv.slice(1));
  if (cmd === 'hook') {
    const t: Target = argv.includes('--codex') ? 'codex' : 'claude';
    process.stdout.write(`${hookSnippet(eventsPath(), t)}\n`);
    return 0;
  }
  if (cmd === 'signal') {
    const k = argv[1];
    if (k !== 'start' && k !== 'done' && k !== 'notify') {
      process.stderr.write('用法：moyu signal start|done|notify\n');
      return 2;
    }
    appendSignal(k as Signal);
    process.stdout.write(`${k} → ${eventsPath()}\n`);
    return 0;
  }
  if (cmd === 'bench') {
    const tier = tierArg(argv);
    if (tier === 'bad') { process.stderr.write('--tier= 只认 graphics、braille 或 half\n'); return 2; }
    return cmdBench(Number(argv[1] ?? 300), argv.includes('--stress'), argv.includes('--game'), argv.includes('--strip'), tier);
  }
  if (cmd === 'play') return cmdPlay(argv[1]);
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) { process.stdout.write(`${usage()}\n`); return cmd === undefined ? 2 : 0; }

  const dd = argv.indexOf('--');
  const inner = dd >= 0 ? argv.slice(dd + 1) : argv;
  if (inner.length === 0) { process.stderr.write(`${usage()}\n`); return 2; }
  return cmdWrap(inner);
}

/* ── moyu install / moyu doctor ─────────────────────────────────────────
 *
 * 这两条命令是别人第一次接触摸鱼的地方，所以刻意话多：install **默认干跑**、
 * 把要改的文件和要写的每一条都摆出来，doctor 只读。改用户的配置这件事不该有一步是猜的。
 */

const INSTALL_FLAGS = new Set(['--write', '--uninstall', '--remove', '--print', '--claude', '--codex', '--dry-run', '--events']);
const BOTH: readonly Target[] = ['claude', 'codex'];

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - [...s].length));
}

function cmdInstall(args: string[]): number {
  const bad = args.find((a) => a.startsWith('-') && !INSTALL_FLAGS.has(a.split('=')[0] ?? a));
  if (bad !== undefined) {
    process.stderr.write(`moyu install: 不认识的选项 ${bad}\n用法：moyu install [--claude] [--codex] [--uninstall] [--print] [--write]\n`);
    return 2;
  }
  const write = args.includes('--write');
  const un = args.includes('--uninstall') || args.includes('--remove');
  const ev = args.find((a) => a.startsWith('--events='));
  const file = ev === undefined ? eventsPath() : ev.slice('--events='.length);
  const asked = BOTH.filter((t) => args.includes(`--${t}`));

  if (args.includes('--print')) {
    const list = asked.length > 0 ? asked : BOTH;
    process.stdout.write(`${list.map((t) => hookSnippet(file, t)).join('\n\n')}\n`);
    return 0;
  }

  // 没点名就装"这台机器上真的有的"那些。装到一个没有的 CLI 上只会留下一个没人读的文件。
  const targets = asked.length > 0 ? asked : BOTH.filter((t) => detected(t));
  if (targets.length === 0) {
    process.stderr.write(
      '没找到 Claude Code 或 Codex（~/.claude 和 ~/.codex 都不存在，PATH 上也没有）。\n' +
      '要强制装：moyu install --claude --write（或 --codex）。\n');
    return 1;
  }

  const plans = targets.map((t) => plan(t, { file, uninstall: un }));
  const out: string[] = [un ? '摸鱼 hook 卸载' : '摸鱼 hook 安装', ''];
  let failed = false;

  for (const p of plans) {
    const name = pad(TARGET_NAME[p.target], 11);
    if (p.action === 'error') {
      failed = true;
      out.push(`✗ ${name}  ${p.error ?? '未知错误'}`, `  手动版：moyu install --${p.target} --print`, '');
      continue;
    }
    if (write) {
      let backup: string | null = null;
      try { backup = apply(p); } catch (e) {
        failed = true;
        out.push(`✗ ${name}  写不进 ${homeVar(p.path)}：${e instanceof Error ? e.message : String(e)}`, '');
        continue;
      }
      const what = p.action === 'unchanged' ? '本来就是这样，没动' : p.action === 'remove' ? '已删掉' : p.action === 'create' ? '已新建' : '已更新';
      out.push(`✓ ${name}  ${what} ${homeVar(p.path)}${backup === null ? '' : `（备份 ${homeVar(backup)}）`}`);
    } else {
      const what = p.action === 'unchanged' ? '不用改（已经是想要的样子）' : p.action === 'remove' ? `会删掉整个文件（摘掉 ${p.removed} 条之后它就空了）` : p.action === 'create' ? '会新建' : `会更新${p.removed > 0 ? `（先摘掉 ${p.removed} 条旧的）` : ''}`;
      out.push(`${name}  ${homeVar(p.path)}`, `  ${what}`);
      const mark = p.action === 'unchanged' ? '·' : '+';
      for (const [event, kind] of eventSignals(p.target)) {
        if (p.added.includes(event)) out.push(`  ${mark} ${pad(event, 17)}→ ${kind}`);
      }
    }
    if (p.target === 'codex' && !un && p.action !== 'unchanged') {
      out.push('  ! Codex 下次启动会问 "Hooks need review" —— 选 "Trust all and continue"，不然 hook 不会跑');
    }
    out.push('');
  }

  out.push(`事件文件：${homeVar(file)}`);
  if (!write) out.push('', '以上是干跑，什么都没改。真要写：' + (un ? 'moyu install --uninstall --write' : 'moyu install --write'));
  else if (!un && !failed) out.push('可以了：moyu -- claude（或 moyu -- codex）。不装 hook 也能玩：游戏里按 t / y 手动喂信号。');
  process.stdout.write(`${out.join('\n')}\n`);
  return failed ? 1 : 0;
}

/** 事件文件的最后一条信号。只读尾部 4KB —— 这文件是只追加的，可能很长。 */
function lastSignal(file: string): string {
  let fd = -1;
  try {
    const size = fs.statSync(file).size;
    const n = Math.min(size, 4096);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').trim().split('\n');
    const last = lines[lines.length - 1]?.trim() ?? '';
    if (last === '') return '空的（还没有任何事件）';
    const parts = last.split(/\s+/);
    const kind = parts[parts.length - 1] ?? '?';
    const ts = Number(parts[0]);
    if (!Number.isFinite(ts) || parts.length < 2) return `最后一条 ${kind}`;
    const age = Math.max(0, Math.round(Date.now() / 1000 - ts));
    const when = age < 60 ? `${age} 秒前` : age < 3600 ? `${Math.round(age / 60)} 分钟前` : `${Math.round(age / 3600)} 小时前`;
    return `最后一条 ${kind}（${when}）`;
  } catch { return '读不出来'; }
  finally { if (fd >= 0) { try { fs.closeSync(fd); } catch { /* 关不掉也没别的办法 */ } } }
}

/** `moyu doctor`：只读的体检。装出问题的时候第一件该跑的事。 */
async function cmdDoctor(): Promise<number> {
  const out: string[] = ['摸鱼体检', ''];
  const major = Number(process.versions.node.split('.')[0] ?? 0);
  out.push(`node        ${process.version}${major >= 20 ? '' : '  ← 太旧了，要 >= 20'}`);

  // PTY 是 `moyu -- <cmd>` 的硬依赖，但 `moyu demo` 不需要它 —— 所以坏了也不是致命的。
  let pty: string;
  try { await import('@lydell/node-pty'); pty = '可用'; } catch (e) {
    pty = `加载失败（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）—— moyu -- <cmd> 用不了，moyu demo 照样能玩`;
  }
  out.push(`PTY         ${pty}`);

  const file = eventsPath();
  out.push(`事件文件    ${homeVar(file)}：${fs.existsSync(file) ? lastSignal(file) : '还不存在（装了 hook 或按过 t/y 之后才有）'}`);

  for (const t of BOTH) {
    const st = status(t, { file });
    const name = pad(TARGET_NAME[t], 11);
    if (st.broken !== null) { out.push(`${name} ${homeVar(st.path)} 不是合法 JSON：${st.broken}`); continue; }
    if (st.events.length === 0) {
      out.push(`${name} 没装${detected(t) ? `（moyu install --${t} --write）` : '（这台机器上也没装这个 CLI）'}`);
      continue;
    }
    out.push(`${name} 已装 ${st.events.join(' / ')}${st.stale ? '  ← 命令和现在的事件文件路径不一致，重跑 moyu install --write' : ''}`);
    if (t === 'codex') out.push('            （Codex 那边还要在启动时点过一次 "Trust all and continue" 才真的会跑）');
  }

  out.push('', '渲染档位：moyu doctor --caps（要在真终端里跑）；只验证 Kitty 图片链路：moyu doctor --gfx',
    '终端被搞坏了：moyu doctor --reset');
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

/**
 * 无头 bench。不需要终端，所以 CI 里也能跑，性能回归会变成一个数字而不是一种感觉。
 *
 * `--stress` 换成病态场景（全宽彩带每帧平移一列）。两个数都要看：
 * 常规场景是**基线**（回归看它），stress 是**上界**（知道离带宽墙还有多远）。
 *
 * `--strip` 是**真正出货的那个尺寸**（40 列 × 2 个字符行的条 + 真实战斗）。160×45 那两个数
 * 现在只是画布本身的回归基线 —— 装进外壳之后没人会看到一个 45 行的画布，
 * 所以性能看门狗必须有一档量的是条形，不然它守的是一个不存在的配置。
 */
function cmdBench(frames: number, stress: boolean, game: boolean, strip: boolean, tier: Tier): number {
  const n = Number.isFinite(frames) && frames > 0 ? Math.floor(frames) : 300;
  const paint = stress ? paintStress : game || strip ? benchGame() : paintScene;
  const [cols, rows] = strip ? [fieldColsFor(100), MICRO_GAME_ROWS] : [160, 45];
  const t: PixelTarget = tier === 'graphics' ? new GraphicsTarget(cols, rows, BENCH_CELL.w, BENCH_CELL.h)
    : tier === 'braille' ? new BrailleTarget(cols, rows) : new Canvas(cols, rows);
  let bytes = 0;
  let peak = 0;
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < n; f++) {
    paint(t, f);
    const s = t.encode(1);
    bytes += s.length > 0 ? t.lastBytes : 0;
    if (t.lastBytes > peak) peak = t.lastBytes;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write([
    `画布 ${t.pixelW}×${t.pixelH} 像素（${t.cols}×${t.rows} 字符格，${tier} 档`
      + `${tier === 'graphics' ? `，格像素 ${BENCH_CELL.w}×${BENCH_CELL.h}` : ''}），${n} 帧`
      + `，场景 ${stress ? 'stress（病态上界）' : strip ? 'strip（出货尺寸 + 真实战斗）' : game ? 'game（真实战斗）' : 'scene0（常规基线）'}`,
    `平均 ${(bytes / n / 1024).toFixed(2)} KB/帧   最差 ${(peak / 1024).toFixed(2)} KB/帧`,
    `CPU ${(ms / n).toFixed(3)} ms/帧   ${FPS}fps 下带宽 ${((bytes / n) * FPS / 1024).toFixed(0)} KB/s`,
  ].join('\n') + '\n');
  return 0;
}

/**
 * bench 的像素档格尺寸：**视网膜 16×34**，不是 `DEFAULT_CELL` 的 8×17。
 *
 * 故意取贵的那一头 —— 像素数（也就是 deflate 的输入）是它的 4 倍。看门狗守的必须是最坏
 * 的那个真实配置，守一个 8×17 的数字等于把视网膜用户的回归全放过去。
 */
const BENCH_CELL = { w: 16, h: 34 } as const;

/** `--tier=` 的解析。写错了要报错而不是静默退档 —— bench 打出来的数字必须知道自己量的是哪一档。 */
function tierArg(argv: string[]): Tier | 'bad' {
  const a = argv.find((x) => x.startsWith('--tier='));
  if (a === undefined) return 'braille';
  const v = a.slice('--tier='.length);
  return v === 'graphics' || v === 'braille' || v === 'half' ? v : 'bad';
}

/**
 * `bench --game` 用的无头驱动：真实的战斗世界 + 一段脚本化的操作。
 *
 * 意义在于它测的是**会真正发生的**帧，而不是一个人造场景 —— 断肢乱飞 + 血 + 刀光同时在动
 * 是这个游戏字节数最高的时刻，那才是该盯着的数字。种子固定，所以两次跑出来的字节数可比。
 */
function benchGame(): (t: PixelTarget, f: number) => void {
  let w: World | null = null;
  let p: Painter | null = null;
  return (t, f) => {
    if (w === null || p === null) {
      // 画笔先建：世界的尺寸是**虚拟**的（`p.vw × p.vh`），不是设备像素的。
      // 直接把设备像素喂给 `resize` 就等于让视网膜用户的世界高一倍，bench 也就不可比了。
      p = stripPainter(t);
      w = new World(0x1234abcd);
      w.resize(p.vw, p.vh);
      w.taskStart();
    }
    // 一直在动、一直在砍：每 11 帧一刀，每 37 帧换向，每 53 帧跳一次。
    const move: -1 | 0 | 1 = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
    const first = { move, jump: f % 53 === 0, slash: f % 11 === 0 };
    w.step(1 / 60, first);
    w.step(1 / 60, { move, jump: false, slash: false });
    if (f === 900) w.taskDone();
    paintWorld(p, w);
  };
}

/**
 * `moyu doctor --caps`：在**真终端**里跑一次能力探测，把结果打成人能读的一页。
 *
 * 为什么必须有这个命令：探测的三条回复只有真终端会给。CI、管道、没有控制终端的 session
 * 里永远探不到 graphics，所以"这台机器上到底选了哪一档、格像素问出来是多少"这件事
 * **只能**靠人在自己的终端里跑一次确认。选错档的症状（图溢进上半屏、糊一档）
 * 在这里是一行数字，在游戏里是"看起来坏了"。
 *
 * `--gfx` 再往前一步：**不看探测结果**，直接把出货那条 40×2 的图送出去。
 * 探测是个**双向**握手（我们问、终端答、答案要原路回到我们的 stdin），SSH / mosh /
 * 某些 web 终端上"没探到"经常只是回程那一半断了；而出图是**单向**的，只要终端认
 * APC 就成立。所以当 `--caps` 说"没问出来"时，这条命令才是那个能定论的实验 ——
 * 顺带还回答了"认不认得出是人"，那件事只有人眼能判。
 */
async function cmdCaps(gfx: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
  const t = termSize();
  // 回复必须在 raw 下读：行缓冲会把它扣到用户按回车，那时候早超时了。
  let raw = false;
  if (tty) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    raw = true;
  }
  let caps;
  try {
    caps = await probeCaps({
      stdin: process.stdin,
      write: (x) => { process.stdout.write(x); },
      env: process.env,
      cols: t.cols, rows: t.rows, tty,
    });
  } finally {
    if (raw) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }

  const envOr = (k: string): string => {
    const v = process.env[k];
    return v === undefined || v === '' ? '（没设）' : v;
  };
  const known = knownGraphicsTerm(process.env);
  const ssh = process.env.SSH_CONNECTION !== undefined && process.env.SSH_CONNECTION !== '';
  const mux = process.env.TMUX !== undefined && process.env.TMUX !== '' ? 'tmux'
    : process.env.STY !== undefined && process.env.STY !== '' ? 'screen' : null;

  // 使用和 Ctrl+] 游戏条完全相同的两行几何，doctor 报出来的就是实际出货尺寸。
  const l = computeLayout({
    cols: t.cols,
    rows: t.rows,
    manualGameRows: MICRO_GAME_ROWS,
  });
  const cols = l.kind === 'split' ? l.layout.fieldCols : fieldColsFor(t.cols);
  const rows = l.kind === 'split' ? l.layout.gameRows : MICRO_GAME_ROWS;
  const target: PixelTarget = caps.tier === 'graphics' ? new GraphicsTarget(cols, rows, caps.cellW, caps.cellH)
    : caps.tier === 'braille' ? new BrailleTarget(cols, rows) : new Canvas(cols, rows);

  process.stdout.write([
    `终端       ${t.cols}×${t.rows} 字符格${tty ? '' : '（不是 TTY —— 下面的探测结果没有意义）'}`,
    `档位       ${caps.tier}`,
    `理由       ${caps.why}`,
    // 终端身份是"为什么没探到"最常见的答案，尤其在 SSH 上：ssh 默认只把 TERM 带过去，
    // TERM_PROGRAM / GHOSTTY_RESOURCES_DIR / KITTY_WINDOW_ID 这些**本地**变量一个都不过来，
    // 于是 env 兜底在远端天然失效。不打出来的话这件事从输出里完全看不见。
    //
    // 只打 TERM / TERM_PROGRAM 的**值**：SSH_CONNECTION 带客户端 IP、TMUX 带 socket 路径
    // （里面有用户名），而这一页是会被贴到 issue 里的，所以那两个只报有没有。
    `终端身份   TERM=${envOr('TERM')}，TERM_PROGRAM=${envOr('TERM_PROGRAM')}`
      + `${known === null ? '（env 认不出是哪个终端）' : ` → 认得出是 ${known}`}`,
    `连接       ${ssh ? 'SSH（所以 15fps；本地的 TERM_PROGRAM 之类传不过来）' : '本地'}`
      + `${mux === null ? '' : `，在 ${mux} 里`}`,
    caps.tier === 'graphics'
      ? `终端格像素 ${caps.cellW}×${caps.cellH}`
        + `${caps.cellW === DEFAULT_CELL.w && caps.cellH === DEFAULT_CELL.h ? '（= 默认值）' : ''}`
      : `字符密度   ${caps.tier === 'braille' ? '2×4' : '1×2'} 逻辑像素/格（不依赖设备像素查询）`,
    `帧率       ${caps.fps}fps`,
    `候场       ${t.cols}×1 字符格（静止状态栏）`,
    `两行游戏条 ${cols}×${rows} 字符格 → ${target.pixelW}×${target.pixelH} 逻辑像素`,
    '微型画布   80×8（为两行重新构图，不缩小完整场景）',
    '角色绘制   文本档使用原生 8 像素高微型动作帧；图形档独立构图，E 展开更多细节',
    caps.leftover.length > 0 ? `抢跑的输入 ${caps.leftover.length} 字节（已丢弃 —— 这个命令不转发给谁）` : '',
    '',
    caps.tier === 'braille'
      ? '当前是通用文本档：每字符 2×4 逻辑像素，实际清晰度受字体影响。Termius、SSH、tmux/screen 得到这一档是正常结果。'
      : caps.tier === 'half'
        ? '当前是最低兼容档；可用 MOYU_TIER=braille 检查终端字体是否支持 Unicode Braille。'
        : '当前终端完整支持 Kitty Graphics，已使用 RGB 像素增强档。',
    '',
    '环境变量：MOYU_TIER=braille|half 明确选文本档；MOYU_TIER=graphics 安全尝试图形档；MOYU_CELL=16x34 指定格像素。',
    'MOYU_FORCE_GRAPHICS=1 会跳过保护严格强制，只应用于协议调试；在 Termius 上可能空白或乱码。',
    gfx ? '' : '想单独验证 Kitty 图片链路：moyu doctor --gfx（不会改变日常自动选择）。',
  ].filter((x) => x !== '').join('\n') + '\n');
  // 协议自检刻意保持一条小图，避免 doctor 一次向 SSH 灌入整屏 RGB 数据。
  if (gfx) drawGfxSelfTest(fieldColsFor(t.cols), 2, caps.cellW, caps.cellH);
  return 0;
}

/**
 * `--gfx` 的那张图：**绕开探测**，用真的 `GraphicsTarget` + 真的 `World` 画一帧出货尺寸
 * 的条，印在普通输出流里。
 *
 * 三种结果各自指向一个不同的下一步，所以先把三种都写出来再发字节 —— 用户看到乱码那一刻
 * 需要的是"这就是答案"，而不是"是不是装坏了"。
 *
 * 定位全用**相对**移动：这里不知道自己在第几行（前面刚打了十几行文字，还可能滚过屏）。
 * 先 `\n` 占出 rows 行（不够就让终端自己滚），再 `CUU` 回到那块的顶上把图放下去，
 * 最后 `CUD` 回到图下面继续打字。`C=1` 保证图本身不动光标。
 */
function drawGfxSelfTest(cols: number, rows: number, cellW: number, cellH: number): void {
  const t = new GraphicsTarget(cols, rows, cellW, cellH);
  const p = stripPainter(t);
  const w = new World(0x5eed);
  w.resize(p.vw, p.vh);
  w.taskStart();
  // 走几步再挥一刀：静止的 idle 姿势最不像人，而"看不出是人"正是要判的那件事。
  for (let f = 0; f < 30; f++) w.step(1 / 60, { move: 1, jump: false, slash: f === 24 });
  paintWorld(p, w);
  const img = t.encode(0);   // 0 = 画在光标处，不发绝对定位

  process.stdout.write([
    '',
    `下面这一段**不看探测结果**，直接送一张 ${cols}×${rows} 字符格（${t.pixelW}×${t.pixelH} 设备像素）的图。`,
    '三种结果，三个不一样的下一步：',
    '',
    '  看到一个火柴人   → 这条链路能过 kitty graphics。不管 --caps 说什么，直接',
    '                     MOYU_TIER=graphics moyu -- codex    # 或 claude',
    '  什么都没有       → 终端认 APC 但不支持 kitty graphics —— 正常的"不支持"就长这样',
    `  一堆 base64 乱码 → 连 APC 都不认，也是不支持（约 ${Math.ceil(img.length / 1024)} KB，clear 一下就干净）`,
    '',
  ].join('\n') + '\n');
  // 一次 write 写完：中间被别的输出（比如内层的字节）切开的话，图和定位就错位了。
  process.stdout.write('\n'.repeat(rows) + `\x1b[${rows}A` + img + `\x1b[${rows}B`);
  process.stdout.write(
    `\n↑ 这就是游戏条的真实尺寸。图还留在屏幕上，clear 或 moyu doctor --reset 清掉。\n`,
  );
}

/* ────────────────────────────── 外壳 spike ────────────────────────────── */

type PtyBoundary =
  | { kind: 'alt-screen'; on: boolean; offset: number }
  | { kind: 'display-erase'; offset: number };

type ComposerBaseline = {
  row: number;
  cols: number;
  innerRows: number;
  screen: number;
};

type ComposerPermit = {
  generation: number;
  screen: number;
  mode: 'verify' | 'repaint' | 'draft' | 'draft-verify';
  preserveRow: boolean;
  cols: number;
  innerRows: number;
  expectedRow: number;
  minRow: number;
  maxRow: number;
  bestRow: number | null;
  bestDistance: number;
};

type ComposerProposal = {
  generation: number;
  screen: number;
  row: number;
  cols: number;
  innerRows: number;
};

async function cmdWrap(inner: string[]): Promise<number> {
  // 没有 TTY 就没有"分屏"可言（管道、CI、被别的程序调用）。这时候唯一正确的行为是
  // 完全退化成一层透明的转发 —— 装作外壳不存在，别把转义序列灌进人家的管道里。
  if (!process.stdout.isTTY || !process.stdin.isTTY) return runBare(inner);
  return new Shell(inner, shellEvents(), await loadGameModules()).run();
}

/** 每个外壳一条事件文件，避免多个 Codex/Claude 窗口互相触发。显式 MOYU_EVENTS 仍然优先。 */
function shellEvents(): { file: string; owned: boolean } {
  if (process.env.MOYU_EVENTS !== undefined && process.env.MOYU_EVENTS !== '') {
    return { file: eventsPath(), owned: false };
  }
  return {
    file: path.join(path.dirname(eventsPath()), 'sessions', `${process.pid}-${randomUUID()}.log`),
    owned: true,
  };
}

/** 无 TTY 的退化路径：直接继承 stdio 跑内层，退出码原样传出去。 */
async function runBare(inner: string[]): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise<number>((resolve) => {
    const child = spawn(inner[0]!, inner.slice(1), { stdio: 'inherit' });
    child.on('error', (e) => { process.stderr.write(`moyu: 起不来 ${inner[0]}：${e.message}\n`); resolve(127); });
    child.on('exit', (code, signal) => {
      const signo = signal === null ? null : osConstants.signals[signal];
      resolve(signo === null || signo === undefined ? (code ?? 0) : 128 + signo);
    });
  });
}

/** 真实终端尺寸。拿不到就给一个保守的默认值，而不是崩。 */
function termSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

class Shell {
  private readonly argv: string[];

  private focus: Focus = 'cli';
  /** Standby occupies one row; play expands without discarding cartridge state. */
  private collapsed = true;
  private expanded = false;
  private readonly surface = new PlaySurface();
  /** 已确认的 Codex 输入提示行；完整匹配 prompt 签名后才设置。 */
  private composerRow: number | null = null;
  /** 一次确认后持续有效；坐标失效不等于签名的来源不再可信。 */
  private composerTrusted = false;
  private composerCandidate: { row: number; col: number; index: number; generation: number } | null = null;
  private composerProposal: ComposerProposal | null = null;
  private composerBaseline: ComposerBaseline | null = null;
  private composerPermit: ComposerPermit | null = null;
  private composerGeneration = 0;
  private composerSettleTimer: NodeJS.Timeout | null = null;
  private composerExpiryTimer: NodeJS.Timeout | null = null;
  /** 主屏/备用屏各自有一份坐标空间；切换一次就换一代。 */
  private composerScreen = 0;
  /** Passthrough 在一次 push 内按输出偏移排好的逻辑边界。 */
  private readonly ptyBoundaries: PtyBoundary[] = [];
  private inlinePlay = false;
  private inlineTop: number | null = null;
  /** 用户缩回两行后，即使坐标要等重绘确认，也应继续回到 inline。 */
  private wantInline = false;
  private readonly preferComposerOverlay: boolean;
  /** 收起那一行上一次写出去的字节，用来做“没变就不发”。 */
  private lastBar = '';
  private layout: Layout | null = null;

  private readonly arbiter: ScreenArbiter;
  private readonly pass: Passthrough;
  private readonly vt: VtCursor;
  /**
   * 画布。**不是 `readonly`** —— 启动探测之后才知道是哪一档，换档要换一个实例。
   * 构造时先给最小文本画布；能力探测结束后换成 Graphics、Braille 或 half。
   */
  private target: PixelTarget;
  private readonly router = new InputRouter();
  private readonly teardown: Teardown;
  /** Cartridge runtime shared by every renderer. */
  private readonly game: Arcade;
  private readonly events: { file: string; owned: boolean };

  private pty: PtyHost | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tee: number | null = null;
  private ptyPaused = false;

  /** 帧间隔。探测到 SSH 会把它翻倍（15fps），所以不能直接用 `FRAME_MS`。 */
  private frameMs = FRAME_MS;
  private frames = 0;
  private skipped = 0;
  private lastToggle = 0;
  private resolve: ((code: number) => void) | null = null;
  private finished = false;

  constructor(argv: string[], events: { file: string; owned: boolean }, modules: GameModule[]) {
    this.argv = argv;
    this.events = events;
    this.game = new Arcade(events.file, modules);
    this.game.pause();
    const executable = path.basename(argv[0] ?? '');
    const overlay = process.env.MOYU_OVERLAY;
    this.preferComposerOverlay = overlay === '1' || (overlay !== '0' && /^codex(?:$|[-.])/.test(executable));

    const t = termSize();
    const first = computeLayout({ cols: t.cols, rows: t.rows });
    const innerRows = first.kind === 'split' ? first.layout.innerRows : t.rows;

    // 两个回调都同步做。让屏原因只剩用户按键和 resize 两条，它们都来自我们自己的
    // 事件处理，此刻活动屏幕是哪个不存在歧义（备用屏切换以前是第三个原因，需要延后
    // 到字节写出去之后才能动屏幕，现在那条逻辑搬去了 onScreenSwap）。
    this.arbiter = new ScreenArbiter({
      onYield: () => { this.onYield(); },
      onResume: () => { this.onResume(); },
    });
    this.pass = new Passthrough({
      region: { top: 1, bottom: innerRows },
      cols: t.cols,
      // 内层问尺寸（`CSI 14/16/18/19 t`）时我们自己回答，不让终端回 —— 终端会说
      // "你有整个窗口"，内层照那个数排版就会算错，按窗口高度算的图还会溢进游戏区。
      // 回复要写进内层的 **stdin**，所以走 pty.write 而不是 this.write。
      onSizeQuery: (reply) => { this.pty?.write(reply); },
      // 回调只记录**改写输出里的有序边界**。状态变化要等 VtCursor 吃完边界前的字节再做，
      // 否则同一 chunk 里的「旧 prompt → ED/切屏 → 新 prompt」会被倒序解释。
      onAltScreen: (on, offset) => { this.ptyBoundaries.push({ kind: 'alt-screen', on, offset }); },
      onDisplayErase: (offset) => { this.ptyBoundaries.push({ kind: 'display-erase', offset }); },
    });
    this.vt = new VtCursor({ cols: t.cols, rows: innerRows,
      onPrint: (cp, row, col) => { this.observeComposer(cp, row, col); } });
    this.target = new Canvas(t.cols, 1);
    this.teardown = new Teardown(() => this.restoreState());
  }

  /** 退出时的还原参数。现场取值 —— 内层光标一直在动，安装时的快照到这会儿早过期了。 */
  private restoreState(): RestoreOptions {
    // homeRow 给内层光标所在行：还原时从那里 ED 0，游戏区被擦干净，
    // 之后 shell 的提示符接着 CLI 的最后一行往下走，看不出这里跑过一个游戏。
    return {
      homeRow: Math.min(this.vt.row, this.inlineTop ?? this.vt.row),
      // 内层 push 过 kitty 键盘标志就照数弹回去，它用 `CSI = … u` 直接设过的只能硬复位。
      // 漏掉这一步的症状离我们很远：用户回到自己的 shell，方向键变成乱码。
      kittyPops: this.pass.kittyDepth,
      kittyHardReset: this.pass.kittySet,
      // 只有真上传过图才发删除。半块档发了就是往用户屏幕上打一行 `a=d,d=I,…` 字面量 ——
      // 不认 APC 的终端会把它当文字，那比留一张图糟糕得多。
      deleteImage: this.target.tier === 'graphics',
    };
  }

  async run(): Promise<number> {
    // 终端在我们底下消失时 stdout 会 EPIPE。它不该变成一次 uncaughtException ——
    // 那条路径会去打印栈，而屏幕已经没了。
    process.stdout.on('error', () => { /* 交给还原路径 */ });

    this.teardown.install();
    this.teardown.onRestore(() => { this.stopFrames(); });
    this.teardown.onRestore(() => { this.clearComposerTimers(); });
    this.teardown.onRestore(() => { try { process.stdin.setRawMode(false); } catch { /* 已经不是 TTY 了 */ } });
    this.teardown.onRestore(() => { this.pty?.killNow(); });
    this.teardown.onRestore(() => { this.closeTee(); });
    this.teardown.onRestore(() => { this.cleanupEvents(); });
    // 最后一个：删掉 bin/moyu 的接管标记。放最后是因为它的语义是"还原真的做完了"——
    // 前面的钩子抛异常会被 Teardown 吞掉，但还原字节在那之前就已经写出去了，所以
    // 走到这一步屏幕一定是干净的。SIGKILL 时这行跑不到，标记留着，sh 的 trap 接手。
    this.teardown.onRestore(() => { clearTakeover(); });
    markTakeover();

    this.openTee();

    const t = termSize();

    // raw + resume 提到这里（探测之前）有两个硬理由：回复必须在 raw 下读 ——
    // 行缓冲会把它扣到用户按回车；而探测**必须**排在把 stdin 交给路由器之前 ——
    // 不然 `ESC _ G i=31;OK ESC \` 会被当普通按键转发进内层的输入框，开局一行乱码。
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const caps = await probeCaps({
      stdin: process.stdin,
      write: (x) => { this.write(x); },
      env: process.env,
      cols: t.cols, rows: t.rows, tty: true,
    });
    this.frameMs = 1000 / caps.fps;
    // 回答内层 `CSI 14/16 t` 用的格像素：探测值优于默认值，两档都要（半块档也会被问）。
    this.pass.cell = { w: caps.cellW, h: caps.cellH };
    if (caps.tier === 'graphics') {
      // 尺寸随便给，下面 applyLayout 立刻按真实布局 resize 一次。
      this.target = new GraphicsTarget(t.cols, 1, caps.cellW, caps.cellH);
    } else if (caps.tier === 'braille') {
      // 包裹模式嵌在用户现有的 coding CLI 里；沿用终端默认背景，画面才像输入框的一部分，
      // 不会因主题色不同而露出一块 40×2 的黑色贴片。独立 play/demo 仍使用游戏自己的底色。
      this.target = new BrailleTarget(t.cols, 1, { defaultBackground: true, defaultForeground: 0xecf0f8 });
    }

    const first = computeLayout({ cols: t.cols, rows: t.rows });
    if (first.kind === 'split') {
      this.applyLayout(first.layout, 'init');
    } else {
      // 太小就不分屏，整屏给内层。走 initialize 而不是 set —— 这是初始状态，
      // 没有"从可见变成不可见"这回事，也没有东西需要重绘。
      this.write(`\x1b[H\x1b[2J${fullScrollRegionSeq()}`);
      this.arbiter.initialize(['too-small']);
      process.stderr.write(`moyu: ${first.reason}，游戏区先收起（放大终端后自动出现）\r\n`);
    }

    const innerRows = this.layout?.innerRows ?? t.rows;
    try {
      this.pty = await PtyHost.spawn({
        file: this.argv[0]!,
        args: this.argv.slice(1),
        cols: t.cols,
        rows: innerRows,
        env: { ...process.env, MOYU_EVENTS: this.events.file },
      });
    } catch (e) {
      this.teardown.run();
      process.stderr.write(`moyu: ${e instanceof Error ? e.message : String(e)}\n`);
      return 127;
    }

    this.pty.onData((data) => { this.onPtyData(data); });
    this.pty.onExit(({ exitCode }) => { this.finish(exitCode); });

    // 探测那 150ms 里用户抢跑敲的键。攒到现在才喂 —— 那会儿 PTY 还不存在，
    // 转发给谁都没有；丢掉的话用户会觉得"开头几个字符吃了"。
    if (caps.leftover.length > 0) this.onStdin(caps.leftover);
    process.stdin.on('data', (chunk: Buffer) => { this.onStdin(chunk); });

    // 用 stdout 的 'resize' 而**不是** `process.on('SIGWINCH')`：SIGWINCH 的监听器顺序
    // 不保证排在 Node 自己刷新 `process.stdout.columns/rows` 之后，直接在信号里读尺寸
    // 会读到**上一次**的值。'resize' 是文档承诺"columns/rows 已经更新"之后才发的。
    process.stdout.on('resize', () => { this.onResize(); });

    this.startFrames();
    return new Promise<number>((resolve) => { this.resolve = resolve; });
  }

  /* ── 布局 ─────────────────────────────────────────────────────────── */

  /**
   * 把一份布局落到真实终端和 PTY 上。
   *
   * 顺序是有讲究的：**先设滚动区，再 resize PTY**。resize 会给内层发 SIGWINCH，
   * 它收到就立刻按新尺寸重绘，那一刻滚动区必须已经是新的 —— 否则它的重绘会被旧区间截断。
   */
  private applyLayout(l: Layout, why: 'init' | 'resize' | 'resume'): void {
    assertLayout(l);
    // 游戏区**变矮**回到候场时要从**旧**的顶边开始擦，不是新的 —— 让出去的那几行
    // 上还留着上一帧的画布，而它们现在归内层了。内层是 TUI 的话 SIGWINCH 会让它重画一遍
    // 盖掉，但内层是个普通 shell 时不会，那几行就一直挂在那儿。
    const prevTop = this.layout?.gameTop;
    const clearFrom = prevTop === undefined ? l.gameTop : Math.min(prevTop, l.gameTop);
    this.layout = l;
    const resized = this.pty === null || this.pty.cols !== l.cols || this.pty.rows !== l.innerRows;
    if (!resized) this.invalidateComposerCandidate();

    this.pass.region = { top: 1, bottom: l.innerRows };
    this.pass.cols = l.cols;
    this.vt.resize(l.cols, l.innerRows);
    // 收起状态下那 1 行是纯文本状态条，画布一格都不占 —— 不能把世界压到 1 行去，
    // 否则展开时角色的坐标已经被来回缩放过两遍（而收起是"暂时不看"，不是"重开一局"）。
    if (!this.collapsed) {
      // 画布占游戏区的**全部**行，只在横向让出右边的 HUD 文本区。
      this.target.resize(l.fieldCols, l.gameRows);
      this.target.invalidate();
      // 画笔要跟着重建：它缓存了 `k = 设备像素高 / 虚拟高`。
      // 世界收到的是**虚拟**尺寸，不是设备像素 —— 不然视网膜用户的世界会比别人高一倍。
    }
    this.lastBar = '';

    let seq = '';
    // 启动时清屏：包裹层要接管整个屏幕的几何，不清屏的话残留内容会和分屏边界错位，
    // 看起来就像坏了。退出时 teardown 的 homeRow + ED 0 负责收拾干净。
    if (why === 'init') seq += '\x1b[H\x1b[2J';
    seq += scrollRegionSeq(l);
    // 擦掉游戏区：resize / 收屏之后那里可能留着旧内容或内层的残迹。
    seq += `\x1b[${clearFrom};1H\x1b[J`;
    this.write(seq + this.vt.restoreSeq());

    this.resizePty(l.cols, l.innerRows);
  }

  /** 候场一行；安全回退路径也只打开两行。 */
  private wantGameRows(): number | undefined {
    if (this.collapsed) return 1;
    if (!this.expanded) return MICRO_GAME_ROWS;
    const available = termSize().rows - 10;
    return available >= 6 ? 6 : available >= 4 ? 4 : MICRO_GAME_ROWS;
  }

  /** Move between the one-row standby state and the persistent play surface. */
  private setCollapsed(v: boolean): void {
    if (this.collapsed === v) return;
    this.collapsed = v;
    // 收起要**删图**：擦文字擦不掉它（图是终端另存的一层），一张挂在 CLI 上面的
    // 图就是纯粹的垃圾。展开时终端里那张已经没了，所以必须整幅重传，不能"没动就不发"。
    if (v) this.write(this.target.disposeSeq());
    else this.target.invalidate();
    this.relayout();
  }

  /** 让出整屏。两个原因（用户收起 / 太小）共用这一条路径。 */
  private onYield(): void {
    const t = termSize();
    const gameTop = Math.min(this.layout?.gameTop ?? t.rows, this.inlineTop ?? t.rows);
    // 先撤滚动区、擦掉游戏区，再把 PTY 调成整屏。反过来的话内层收到 SIGWINCH
    // 会立刻按整屏高度画，而滚动区还卡在上半屏，它画到底部时会被截断。
    // 让屏要顺手把终端里那张图删掉：擦文字擦不掉它（图是终端另存的一层），
    // 收起游戏区之后一张挂在那儿的图就是纯粹的垃圾。
    this.write(this.target.disposeSeq() + fullScrollRegionSeq() + `\x1b[${gameTop};1H\x1b[J` + this.vt.restoreSeq());
    if (this.inlinePlay) {
      this.inlinePlay = false;
      this.inlineTop = null;
      this.target.invalidate();
    }
    // Composer output at full-screen geometry must not mutate split-layout coordinates.
    // resizePty keeps the durable pre-yield baseline for the resume transaction.
    this.abortComposerOperation();
    this.composerGeneration++;
    this.composerRow = null;
    this.inlineTop = null;
    this.pass.region = { top: 1, bottom: t.rows };
    this.pass.cols = t.cols;
    this.vt.resize(t.cols, t.rows);
    this.resizePty(t.cols, t.rows);
  }

  /** 收屏，重新分屏。 */
  private onResume(): void {
    if (this.finished || this.arbiter.yielded) return;
    const t = termSize();
    const r = computeLayout({ cols: t.cols, rows: t.rows, manualGameRows: this.wantGameRows() });
    // too-small 本身就是让屏原因之一，所以走到这里必然是 split。真不是就保持让屏，别崩。
    if (r.kind !== 'split') { this.arbiter.set('too-small', true); return; }
    this.applyLayout(r.layout, 'resume');
    if (this.inlinePlay) {
      this.target.resize(fieldColsFor(t.cols), MICRO_GAME_ROWS);
      this.target.invalidate();
    }
  }

  /** 内层切换主屏/备用屏以后，在**新缓冲区**上重建外壳几何。 */
  private onScreenSwap(_on: boolean): void {
    const screen = this.composerScreen;
    setImmediate(() => {
      const l = this.layout;
      if (this.finished || l === null || screen !== this.composerScreen) return;
      // live 是 target 级状态，但 kitty 图片实际按主/备用屏分别存。收起或让屏后切到另一个
      // 缓冲区时，那里可能还有旧图，必须在新缓冲区上再无条件删一次。
      if (this.arbiter.yielded) {
        if (this.target.tier === 'graphics') this.write(deleteImageSeq());
        return;
      }
      if (this.inlinePlay) {
        const removeImage = this.target.tier === 'graphics' ? deleteImageSeq() : '';
        this.target.invalidate();
        this.lastBar = '';
        this.write(removeImage + scrollRegionSeq(l)
          + `\x1b[${l.gameTop};1H\x1b[2K` + this.vt.restoreSeq());
        return;
      }
      if (this.collapsed) {
        // Codex 启动时会切进备用屏。DECSTBM 与屏幕内容都不跨缓冲区：如果这里只
        // 返回，新的屏幕既没有底栏，也没有保护游戏行的滚动区。清空缓存让下一帧
        // 必定重画待机条，并先在当前（新）缓冲区重新建立一行布局。
        const removeImage = this.target.tier === 'graphics' ? deleteImageSeq() : '';
        this.lastBar = '';
        this.write(removeImage + scrollRegionSeq(l)
          + `\x1b[${l.gameTop};1H\x1b[J` + this.vt.restoreSeq());
        return;
      }
      this.write(scrollRegionSeq(l) + `\x1b[${l.gameTop};1H\x1b[J` + this.vt.restoreSeq());
      // 新缓冲区上游戏区是空的（1049h 会清屏，也会清掉图），而画布只发变化 ——
      // 不 invalidate 就一直黑着。
      this.target.invalidate();
    });
  }

  private onResize(): void {
    const t = termSize();
    const r = computeLayout({ cols: t.cols, rows: t.rows, manualGameRows: this.wantGameRows() });

    if (r.kind !== 'split') {
      this.arbiter.set('too-small', true);
      // 让屏路径按当时的尺寸调过 PTY，但尺寸又变了，得再跟一次。
      this.pass.region = { top: 1, bottom: t.rows };
      this.pass.cols = t.cols;
      this.vt.resize(t.cols, t.rows);
      this.resizePty(t.cols, t.rows);
      return;
    }

    const flipped = this.arbiter.set('too-small', false);
    if (this.arbiter.yielded) {
      // 还在因为别的原因让屏（用户收起）：只把整屏尺寸跟上。
      this.pass.region = { top: 1, bottom: t.rows };
      this.pass.cols = t.cols;
      this.vt.resize(t.cols, t.rows);
      this.resizePty(t.cols, t.rows);
      return;
    }
    // flipped 为真时 onResume 已经排好了 applyLayout，别做第二遍。
    if (!flipped) this.applyLayout(r.layout, 'resize');
    if (this.inlinePlay) {
      this.target.resize(fieldColsFor(t.cols), MICRO_GAME_ROWS);
      this.target.invalidate();
    }
  }

  private relayout(): void {
    if (this.arbiter.yielded) return;
    const t = termSize();
    const r = computeLayout({ cols: t.cols, rows: t.rows, manualGameRows: this.wantGameRows() });
    if (r.kind === 'split') this.applyLayout(r.layout, 'resize');
    else this.arbiter.set('too-small', true);
  }

  /* ── 帧循环 ───────────────────────────────────────────────────────── */

  private startFrames(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { this.tick(); }, this.frameMs);
    // 帧定时器不该把进程钉在事件循环上 —— 内层退出后我们要能自然收尾。
    this.timer.unref();
  }

  private stopFrames(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const l = this.layout;
    if (l === null || this.finished || this.arbiter.yielded) return;
    // 内层的吞吐优先于游戏：它在刷屏时我们丢帧，而不是把它的输出排在我们的队列后面。
    if (process.stdout.writableLength > BACKPRESSURE) { this.skipped++; return; }
    if (this.inlinePlay) { this.tickInline(l); return; }
    if (this.collapsed) { this.tickCollapsed(l); return; }

    this.game.setDisplay(l.gameRows, this.target.tier);
    this.game.advance(Date.now());
    const body = this.surface.render(this.game, this.target, l.gameTop, l.cols, l.gameRows);
    this.frames++;

    // A task event is an empty sentinel: save and return focus without audible interruption.
    const alert = this.game.takeAlert();
    if (alert !== null && this.focus === 'game') {
      this.toggleFocus();
      return;
    }

    // 必须是**一次** write：中间被内层的输出插进来会同时撕裂两边的画面。
    //
    // 画布最后一格恰好是屏幕右下角，写它会置上"延迟换行"标志，但紧跟着的
    // restoreSeq 以 SGR 开头 —— 控制序列不会消费那个标志，只有可打印字符会。所以不会滚屏。
    // **没动就不发**：画布没变（`body === ''`）+ HUD 文本没变 + 没有横幅 = 整帧零字节。
    // 任务完成后的暂停就是这个状态，而那正是用户在读横幅、最不该有带宽噪声的时候。
    // 隐藏光标那一对也一起省掉 —— 没画东西就没有光标要藏。
    if (body === '' && alert === null) return;
    this.write(`\x1b[?25l${alert ?? ''}${body}${this.vt.restoreSeq()}`);
  }

  /** 在 Codex 输入提示正上方绘制两行，不改变内层 PTY 尺寸或滚动区。 */
  private tickInline(l: Layout): void {
    if (this.inlineTop === null) {
      if (this.composerRow === null || this.composerRow <= MICRO_GAME_ROWS) return;
      this.inlineTop = this.composerRow - MICRO_GAME_ROWS;
      this.target.invalidate();
    }
    const top = this.inlineTop;
    if (top < 1 || top + MICRO_GAME_ROWS - 1 > l.innerRows) return;
    this.game.setDisplay(MICRO_GAME_ROWS, this.target.tier);
    this.game.advance(Date.now());
    const body = this.surface.render(this.game, this.target, top, l.cols, MICRO_GAME_ROWS);
    this.frames++;
    const alert = this.game.takeAlert();
    if (alert !== null && this.focus === 'game') { this.toggleFocus(); return; }
    if (body === '' && alert === null) return;
    this.write(`\x1b[?25l${alert ?? ''}${body}${this.vt.restoreSeq()}`);
  }

  /**
   * 收起状态下那一行。
   *
   * Simulation advances without painting, so task state is still observed while bandwidth stays quiet.
   */
  private tickCollapsed(l: Layout): void {
    this.game.advance(Date.now());
    const alert = this.game.takeAlert();
    if (alert !== null && this.focus === 'game') this.toggleFocus();
    const h = this.game.hud();
    const text = h.urgent ? `moyu · ${h.short} · Ctrl+] 开玩` : 'moyu  Ctrl+] 开玩';
    // 最后一列留白：写屏幕右下角会置上延迟换行标志，见 hudSeq。
    const seq = `${h.urgent ? SGR_URGENT : SGR_IDLE}`
      + `\x1b[${l.gameTop};1H${fitRow('', text, Math.max(1, l.cols - 1))}\x1b[0m`;
    if (seq === this.lastBar && alert === null) return;
    this.lastBar = seq;
    this.write(`\x1b[?25l${alert ?? ''}${seq}${this.vt.restoreSeq()}`);
  }

  /* ── 数据流 ───────────────────────────────────────────────────────── */

  private onPtyData(data: Uint8Array): void {
    if (this.tee !== null) {
      try { fs.writeSync(this.tee, data); } catch { this.closeTee(); }
    }
    this.ptyBoundaries.length = 0;
    const rewritten = this.pass.push(data);
    let start = 0;
    for (const boundary of this.ptyBoundaries) {
      const end = Math.max(start, Math.min(rewritten.length, boundary.offset));
      if (end > start) this.vt.feed(rewritten.subarray(start, end));
      this.applyPtyBoundary(boundary);
      start = end;
    }
    if (start < rewritten.length) this.vt.feed(rewritten.subarray(start));
    this.activateComposerProposal();
    if (rewritten.length === 0) return;
    // Codex 会按需重绘输入框附近；下一帧必须把被它盖掉的微型画面补回来。
    if (this.inlinePlay) this.target.invalidate();
    const ready = process.stdout.write(rewritten);
    if (!ready && !this.ptyPaused) {
      this.ptyPaused = true;
      this.pty?.pause();
      process.stdout.once('drain', () => {
        this.ptyPaused = false;
        this.pty?.resume();
      });
    }
  }

  private applyPtyBoundary(boundary: PtyBoundary): void {
    this.abortComposerOperation();
    if (this.inlinePlay) {
      // ED/换屏已经擦掉旧 overlay；这里只撤销状态，不能在 PTY 控制序列写出前另写清行。
      this.inlinePlay = false;
      this.inlineTop = null;
      this.target.invalidate();
    }
    if (boundary.kind === 'alt-screen') this.composerScreen++;
    this.beginComposerRepaint(false);
    this.target.invalidate();
    this.lastBar = '';
    if (boundary.kind === 'alt-screen') this.onScreenSwap(boundary.on);
  }

  private onStdin(chunk: Uint8Array): void {
    this.router.route(chunk, (a) => {
      switch (a.kind) {
        case 'forward': this.pty?.write(a.bytes); break;
        // 焦点在游戏：按键喂给游戏，**不**转发给内层（不然打字会跑进 claude 的输入框）。
        // 游戏里的 q / Ctrl+C 只是"退出游戏"，绝不能杀掉用户的 CLI 会话 ——
        // 所以它被翻译成"把焦点交回 CLI"。退出整个外壳仍由内层 CLI 自己的退出命令负责。
        case 'game':
          if (this.game.feed(a.bytes)) this.toggleFocus();
          else if (this.game.takeViewToggle()) this.toggleSize();
          break;
        case 'toggle-focus': this.toggleFocus(); break;
      }
    });
  }

  private toggleFocus(): void {
    const now = Date.now();
    // 防止键盘自动重复在一次手势里立刻展开又收起。
    if (this.focus === 'cli' && now - this.lastToggle < FOCUS_DEBOUNCE_MS) return;
    this.lastToggle = now;
    const entering = this.focus === 'cli';
    if (entering) this.expanded = false;
    this.focus = entering ? 'game' : 'cli';
    // latch 里可能还压着一个方向键。不清掉的话焦点一离开游戏，角色会自己再走 150ms。
    this.game.keys.clear();
    // 路由器必须跟着变。漏了这一行的后果是 HUD 说"焦点在游戏"、按键却还在往内层跑，
    // 而且是**静默**的分叉 —— M0 里两条路都通向内层，所以症状要到 M1 才会显形。
    this.router.focus = this.focus;
    if (entering) this.wantInline = !this.expanded;
    if (entering && this.canUseComposerOverlay()) this.startInlinePlay();
    else if (!entering && this.inlinePlay) {
      // A normal inline overlay still has one-row standby geometry and needs a same-size
      // refresh to restore the covered composer. Returning from expanded play has two-row
      // geometry, so collapsing it performs the resize/repaint instead.
      const needsResize = !this.collapsed;
      this.stopInlinePlay(!needsResize);
      this.setCollapsed(true);
    } else this.setCollapsed(!entering);
    if (!entering) this.wantInline = false;
    if (entering) this.game.resume(); else this.game.pause();
    this.lastBar = '';
  }

  private observeComposer(cp: number, row: number, col: number): void {
    if (!this.preferComposerOverlay || this.arbiter.yielded) return;
    const signature = ' Ask Codex';
    const generation = this.composerGeneration;
    const candidate = this.composerCandidate;
    if (candidate !== null && candidate.generation === generation
      && row === candidate.row && col === candidate.col) {
      if (cp === signature.codePointAt(candidate.index)) {
        candidate.index++;
        candidate.col++;
        if (candidate.index === signature.length) {
          this.composerCandidate = null;
          this.observeExactComposer(row);
        }
        return;
      }
      this.composerCandidate = null;
    } else if (candidate !== null) {
      this.composerCandidate = null;
    }

    if (col <= 4 && row > MICRO_GAME_ROWS && (cp === 0x203a || cp === 0x276f)) {
      const permit = this.composerPermit;
      this.composerCandidate = { row, col: col + 1, index: 0, generation };
      if (this.composerTrusted && permit !== null && permit.mode !== 'verify'
        && permit.generation === generation && permit.screen === this.composerScreen
        && row >= permit.minRow && row <= permit.maxRow) {
        this.recordComposerCandidate(permit, row, false);
      }
    }
  }

  private observeExactComposer(row: number): void {
    const l = this.layout;
    const permit = this.composerPermit;
    if (!this.composerTrusted) {
      const proposal = this.composerProposal;
      if (permit?.mode === 'verify' && permit.generation === this.composerGeneration
        && permit.screen === this.composerScreen && proposal !== null && l !== null
        && proposal.generation === permit.generation && proposal.screen === permit.screen
        && row === permit.expectedRow && row === proposal.row
        && l.cols === proposal.cols && l.innerRows === proposal.innerRows) {
        this.commitComposer(row, true);
        return;
      }
      if (permit === null && l !== null && row > MICRO_GAME_ROWS) {
        this.composerProposal = {
          generation: this.composerGeneration,
          screen: this.composerScreen,
          row,
          cols: l.cols,
          innerRows: l.innerRows,
        };
      }
      return;
    }
    if (permit !== null && permit.mode !== 'verify'
      && permit.generation === this.composerGeneration && permit.screen === this.composerScreen
      && row >= permit.minRow && row <= permit.maxRow) {
      this.recordComposerCandidate(permit, row, true);
    }
  }

  private activateComposerProposal(): void {
    const proposal = this.composerProposal;
    const l = this.layout;
    if (proposal === null || this.composerTrusted || this.arbiter.yielded) return;
    // Refresh acknowledgement and repaint can arrive in separate PTY chunks. Once verification
    // is armed, unrelated output must not discard the proposal the repaint is bound to.
    if (this.composerPermit !== null) return;
    if (this.pty === null || l === null || proposal.generation !== this.composerGeneration
      || proposal.screen !== this.composerScreen || proposal.cols !== l.cols
      || proposal.innerRows !== l.innerRows) {
      this.composerProposal = null;
      return;
    }
    const generation = ++this.composerGeneration;
    const permit: ComposerPermit = {
      generation,
      screen: proposal.screen,
      mode: 'verify',
      preserveRow: false,
      cols: proposal.cols,
      innerRows: proposal.innerRows,
      expectedRow: proposal.row,
      minRow: proposal.row,
      maxRow: proposal.row,
      bestRow: null,
      bestDistance: Number.POSITIVE_INFINITY,
    };
    // Keep the proposal while the refresh is live so verification also binds to its geometry.
    this.composerProposal = { ...proposal, generation };
    this.composerPermit = permit;
    this.scheduleComposerExpiry(permit);
    if (this.pty.refresh() !== true) this.abortComposerOperation();
  }

  private recordComposerCandidate(permit: ComposerPermit, row: number, exact: boolean): void {
    if (exact) {
      // A full signature is authoritative. Discard provisional glyph-only rows so an earlier,
      // closer transcript glyph cannot outrank the real composer during the same repaint.
      permit.bestRow = row;
      permit.bestDistance = -1;
    } else if (permit.mode === 'draft' || permit.mode === 'draft-verify') {
      const distance = Math.abs(row - permit.expectedRow);
      // A non-empty draft has no fixed suffix. Its first repaint only nominates a row; a fresh
      // same-size challenge must redraw that same row before it can become an anchor.
      if (distance < permit.bestDistance || (distance === permit.bestDistance
        && (permit.bestRow === null || row >= permit.bestRow))) {
        permit.bestRow = row;
        permit.bestDistance = distance;
      }
    } else if (permit.bestDistance >= 0) {
      const distance = Math.abs(row - permit.expectedRow);
      // Preserve-row refreshes may emit transcript first; a provisional glyph is never committed.
      if (distance < permit.bestDistance || (distance === permit.bestDistance
        && (permit.bestRow === null || row >= permit.bestRow))) {
        permit.bestRow = row;
        permit.bestDistance = distance;
      }
    }
    if (exact || ((permit.mode === 'draft' || permit.mode === 'draft-verify')
      && permit.bestRow === row)) this.scheduleComposerSettle(permit);
  }

  private resolveComposerPermit(permit: ComposerPermit): void {
    const row = permit.bestRow;
    if (row === null) return;
    if (permit.bestDistance < 0 || permit.mode === 'draft-verify') {
      this.commitComposer(row);
      return;
    }
    if (permit.mode === 'draft') this.challengeDraftComposer(permit, row);
  }

  private challengeDraftComposer(permit: ComposerPermit, row: number): void {
    const pty = this.pty;
    const l = this.layout;
    if (this.finished || pty === null || l === null || this.arbiter.yielded
      || this.composerPermit !== permit || permit.generation !== this.composerGeneration
      || permit.screen !== this.composerScreen || l.cols !== permit.cols
      || l.innerRows !== permit.innerRows) return;
    this.abortComposerOperation();
    const generation = ++this.composerGeneration;
    const challenge: ComposerPermit = {
      generation,
      screen: permit.screen,
      mode: 'draft-verify',
      preserveRow: false,
      cols: permit.cols,
      innerRows: permit.innerRows,
      expectedRow: row,
      minRow: row,
      maxRow: row,
      bestRow: null,
      bestDistance: Number.POSITIVE_INFINITY,
    };
    this.composerPermit = challenge;
    this.scheduleComposerExpiry(challenge);
    if (pty.refresh() !== true) {
      this.abortComposerOperation();
      this.fallbackFromInlineInvalidation();
    }
  }

  private commitComposer(row: number, establishTrust = false): void {
    const l = this.layout;
    if (this.arbiter.yielded || l === null || row <= MICRO_GAME_ROWS) return;
    if (establishTrust) this.composerTrusted = true;
    if (!this.composerTrusted) return;
    this.abortComposerOperation();
    this.composerRow = row;
    this.composerBaseline = { row, cols: l.cols, innerRows: l.innerRows, screen: this.composerScreen };
    if (this.inlinePlay && this.inlineTop !== null && row - MICRO_GAME_ROWS !== this.inlineTop) {
      setImmediate(() => {
        if (!this.inlinePlay || this.composerRow === null || this.inlineTop === this.composerRow - MICRO_GAME_ROWS) return;
        this.stopInlinePlay(); this.startInlinePlay();
      });
    }
    if (this.focus === 'game' && !this.expanded && this.wantInline && !this.inlinePlay) {
      setImmediate(() => {
        if (this.focus === 'game' && !this.expanded && this.wantInline && !this.inlinePlay
          && this.canUseComposerOverlay()) this.startInlinePlay();
      });
    }
  }

  private invalidateComposerCandidate(): void {
    this.abortComposerOperation();
    this.composerGeneration++;
  }

  private resizePty(cols: number, rows: number): void {
    const pty = this.pty;
    if (pty === null || (pty.cols === cols && pty.rows === rows)) return;
    if (this.arbiter.yielded) {
      // Full-screen yield is not a split-layout repaint transaction. Keep the durable split
      // baseline and reacquire only after onResume installs the new split geometry.
      this.abortComposerOperation();
      this.composerGeneration++;
      this.composerRow = null;
      this.inlineTop = null;
      if (this.inlinePlay) {
        this.inlinePlay = false;
        this.target.invalidate();
      }
      pty.resize(cols, rows);
      return;
    }
    this.beginComposerRepaint(false, cols, rows);
    if (pty.resize(cols, rows) !== true) {
      this.abortComposerOperation();
      this.fallbackFromInlineInvalidation();
    }
  }

  /** Arm a transaction before an operation that can redraw the composer. */
  private beginComposerRepaint(preserveRow: boolean, cols?: number, innerRows?: number): void {
    this.abortComposerOperation();
    const l = this.layout;
    const nextCols = cols ?? l?.cols;
    const nextRows = innerRows ?? l?.innerRows;
    const baseline = this.composerBaseline;
    const row = this.composerRow ?? baseline?.row;
    const generation = ++this.composerGeneration;
    if (!preserveRow) {
      this.composerRow = null;
      this.inlineTop = null;
      if (this.inlinePlay) {
        this.inlinePlay = false;
        this.target.invalidate();
      }
    }
    if (!this.composerTrusted || baseline === null || nextCols === undefined || nextRows === undefined
      || row === null || row === undefined) return;
    const expected = clampRow(row + (nextRows - baseline.innerRows), nextRows);
    const widthChanged = baseline.cols !== nextCols;
    const radius = widthChanged ? Math.max(4, Math.min(12, Math.floor(nextRows / 3))) : 2;
    const permit: ComposerPermit = {
      generation,
      screen: this.composerScreen,
      mode: preserveRow ? 'repaint' : 'draft',
      preserveRow,
      cols: nextCols,
      innerRows: nextRows,
      expectedRow: expected,
      minRow: Math.max(MICRO_GAME_ROWS + 1, expected - radius),
      maxRow: Math.min(nextRows, expected + radius),
      bestRow: null,
      bestDistance: Number.POSITIVE_INFINITY,
    };
    this.composerPermit = permit;
    this.scheduleComposerExpiry(permit);
  }

  private scheduleComposerSettle(permit: ComposerPermit): void {
    if (this.composerSettleTimer !== null) clearTimeout(this.composerSettleTimer);
    this.composerSettleTimer = setTimeout(() => {
      this.composerSettleTimer = null;
      if (this.finished || this.composerPermit !== permit || permit.generation !== this.composerGeneration
        || permit.screen !== this.composerScreen) return;
      this.resolveComposerPermit(permit);
    }, COMPOSER_SETTLE_MS);
    this.composerSettleTimer.unref();
  }

  private scheduleComposerExpiry(permit: ComposerPermit): void {
    if (this.composerExpiryTimer !== null) clearTimeout(this.composerExpiryTimer);
    this.composerExpiryTimer = setTimeout(() => {
      this.composerExpiryTimer = null;
      if (this.finished || this.composerPermit !== permit || permit.generation !== this.composerGeneration
        || permit.screen !== this.composerScreen) return;
      if (permit.bestRow !== null) {
        this.resolveComposerPermit(permit);
        return;
      }
      // A silent same-size refresh leaves a still-valid row; invalidating operations stay invalid.
      this.abortComposerOperation();
      if (!permit.preserveRow) this.fallbackFromInlineInvalidation();
    }, COMPOSER_PERMIT_MS);
    this.composerExpiryTimer.unref();
  }

  private abortComposerOperation(): void {
    this.composerCandidate = null;
    this.composerProposal = null;
    this.composerPermit = null;
    if (this.composerSettleTimer !== null) clearTimeout(this.composerSettleTimer);
    if (this.composerExpiryTimer !== null) clearTimeout(this.composerExpiryTimer);
    this.composerSettleTimer = null;
    this.composerExpiryTimer = null;
  }

  private clearComposerTimers(): void {
    this.abortComposerOperation();
  }

  private fallbackFromInlineInvalidation(): void {
    if (this.focus !== 'game' || this.expanded || !this.wantInline || this.inlinePlay) return;
    this.collapsed = false;
    this.relayout();
  }

  private toggleSize(): void {
    if (this.focus !== 'game') return;
    if (this.inlinePlay) this.stopInlinePlay(false);
    this.expanded = !this.expanded;
    this.wantInline = !this.expanded;
    this.collapsed = false;
    this.relayout();
  }

  private canUseComposerOverlay(): boolean {
    return this.preferComposerOverlay && !this.arbiter.yielded && this.layout !== null
      && this.composerRow !== null && this.composerRow > MICRO_GAME_ROWS;
  }

  private startInlinePlay(): void {
    const l = this.layout;
    if (this.arbiter.yielded || l === null || this.composerRow === null) return;
    this.wantInline = true;
    this.inlinePlay = true;
    this.inlineTop = this.composerRow - MICRO_GAME_ROWS;
    this.target.resize(fieldColsFor(l.cols), MICRO_GAME_ROWS);
    this.target.invalidate();
    this.lastBar = '';
    // 收掉最底部的候场提示；游戏本体只出现在输入框上方。
    this.write(this.target.disposeSeq() + `\x1b[${l.gameTop};1H\x1b[2K` + this.vt.restoreSeq());
  }

  private stopInlinePlay(refresh = true): void {
    const l = this.layout;
    const top = this.inlineTop;
    let seq = this.target.disposeSeq();
    if (top !== null) for (let i = 0; i < MICRO_GAME_ROWS; i++) seq += `\x1b[${top + i};1H\x1b[2K`;
    this.inlinePlay = false;
    this.inlineTop = null;
    this.target.invalidate();
    if (l !== null) seq += this.vt.restoreSeq();
    this.write(seq);
    // 清行只能删掉游戏，真正属于 Codex 的内容交给它自己按当前状态重画。相同尺寸的
    // SIGWINCH 可能一个字节都不产出，所以保留现有坐标；若有 ED/新 glyph 再原子替换。
    if (refresh) {
      this.beginComposerRepaint(true);
      if (this.pty?.refresh() !== true) this.abortComposerOperation();
    }
  }

  /* ── 收尾 ─────────────────────────────────────────────────────────── */

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.stopFrames();
    this.teardown.run();
    const r = this.resolve;
    this.resolve = null;
    r?.(code);
  }

  private write(s: string): void {
    if (s.length > 0) process.stdout.write(s);
  }

  /**
   * `MOYU_TEE=<路径>` 把内层的**原始**字节旁录一份。
   *
   * 用途明确：拿真实 Claude Code 的字节流去喂 passthrough 的切点属性测试。
   * 手写的测试输入永远想不到真实程序会发什么。
   */
  private openTee(): void {
    const p = process.env.MOYU_TEE;
    if (p === undefined || p === '') return;
    try { this.tee = fs.openSync(p, 'a'); } catch { this.tee = null; }
  }

  private closeTee(): void {
    if (this.tee === null) return;
    try { fs.closeSync(this.tee); } catch { /* 关不掉也没别的办法 */ }
    this.tee = null;
  }

  private cleanupEvents(): void {
    if (!this.events.owned) return;
    try { fs.unlinkSync(this.events.file); } catch { /* 文件可能还没被 hook 创建 */ }
    try { fs.rmdirSync(path.dirname(this.events.file)); } catch { /* 其它会话还在用或目录不存在 */ }
  }
}

function clampRow(row: number, innerRows: number): number {
  return Math.max(MICRO_GAME_ROWS + 1, Math.min(innerRows, row));
}

/**
 * `bin/moyu` 的接管标记。它的语义是"屏幕还欠一次还原"。
 *
 * 用标记文件而不是退出码，因为退出码分不清两件事：内层 CLI 自己退出码 130 是很正常的，
 * 不代表屏幕坏了。而重复还原有真实代价 —— `?1049l` 自带一次光标恢复，
 * 会把用户 shell 的光标搬到一个陈旧的位置去。
 */
function markTakeover(): void {
  const p = process.env.MOYU_TAKEOVER_FLAG;
  if (p === undefined || p === '') return;
  try { fs.writeFileSync(p, 'taken\n'); } catch { /* 没标记只是少一层兜底，不该因此不启动 */ }
}

function clearTakeover(): void {
  const p = process.env.MOYU_TAKEOVER_FLAG;
  if (p === undefined || p === '') return;
  try { fs.unlinkSync(p); } catch { /* 已经没了 */ }
}

export { main };

/** argv[1] 指的是不是这个模块本身。两边都过一遍 realpath，软链才不会骗到我们。 */
function isEntry(entry: string): boolean {
  const here = fileURLToPath(import.meta.url);
  if (path.resolve(entry) === here) return true;
  try { return fs.realpathSync(entry) === fs.realpathSync(here); } catch { return false; }
}

// 只在被当作入口跑时执行。测试要 import 这个模块（bench 是纯函数，好测），
// 而 import 一下就把外壳跑起来显然不行。
//
// 比的是 **realpath**，不是 argv[1] 原样：Node 加载模块时会解析软链（除非
// --preserve-symlinks），而 argv[1] 保留调用时写的那个路径。macOS 上 /tmp 就是
// /private/tmp 的软链，于是 `moyu` 装在任何带软链的路径下时两边对不上 ——
// 表现是**每条命令都静默退出、什么都不打印、退出码 0**，最难查的那种。
// 实测踩到过：npm i -g --prefix /tmp/... 之后装出来的包就是这样。
const entry = process.argv[1];
if (entry !== undefined && isEntry(entry)) {
  main().then(
    (code) => { process.exit(code); },
    (e: unknown) => {
      // 到这里说明还原钩子已经跑过了（Teardown 挂了 uncaughtException），屏幕是干净的。
      process.stderr.write(`moyu: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
}
