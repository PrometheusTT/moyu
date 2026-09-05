#!/usr/bin/env node
/**
 * moyu 的入口。M0 阶段这里只有三个子命令：
 *
 *   moyu -- <cmd...>      外壳：内层 CLI 占满上面，游戏是最底下那条 1~2 行的窄条
 *   moyu bench            无头跑场景，报字节/帧和毫秒/帧（性能回归的看门狗）
 *   moyu doctor --reset   无条件发一遍全部还原序列（SIGKILL 之后的逃生出口）
 *
 * ## 布局的方向不能反
 *
 * 内层从**真实第 1 行**开始，游戏在下面。这样内层的绝对光标定位（`CSI y;xH`）
 * 在真实屏幕坐标系里本来就是对的，零坐标转换。反过来就得给内层的每一条定位做平移，
 * 而那正是"要写终端模拟器"的开始。`Layout.innerTop` 的字面量类型 `1` 就是这条约束的编译期版本。
 * 游戏为什么不能放在输入框**上面**（而是紧贴它下面）见 `regions.ts` 的文件头。
 *
 * ## 游戏条的横向切分
 *
 * ```
 * 第 1..innerRows 行          内层 CLI（它的输入框就在游戏条正上方）
 * 第 gameTop.. 行  [画布 0..fieldCols) [HUD 文本 fieldCols..cols-1) [最后一列留白]
 * ```
 *
 * HUD 和画布**同排**，不再单独占一行 —— 整条只有 1~2 行，拿一行去写字就没得玩了。
 * 最后一列刻意不写：写屏幕右下角那一格会置上终端的延迟换行标志，紧跟着的可打印字符
 * 就会把整屏滚上去一行。画布在 `fieldCols` 处就停了，所以那一格永远没人碰。
 *
 * ## 每帧的字节顺序
 *
 * `隐藏光标 → HUD 文本 → 画布 diff → vt.restoreSeq()`。
 *
 * 刻意**不用** DEC 2026 同步输出：内层自己在大量使用它（实测二进制里 770 处），
 * 我们无法知道它当前是开还是关，而在它开着的时候发一个 `?2026l` 会把它半张画面提前放出去。
 * 用"隐藏光标 + 一次 write"代替 —— 撕裂只是观感问题，放飞内层半帧是正确性问题。
 */
import { computeLayout, adjustGameRows, scrollRegionSeq, fullScrollRegionSeq, assertLayout, fieldColsFor, DEFAULT_GAME_ROWS } from "../shell/regions.js";
import { Passthrough } from "../shell/passthrough.js";
import { VtCursor } from "../shell/vtcursor.js";
import { PtyHost } from "../shell/pty.js";
import { Teardown, doctorResetSeq, writeAllSync } from "../shell/teardown.js";
import { ScreenArbiter } from "../shell/altscreen.js";
import { InputRouter, hotkeyHint, pendingRows } from "../shell/focus.js";
import { Canvas } from "../render/canvas.js";
import { GraphicsTarget } from "../render/graphics.js";
import { probeCaps, DEFAULT_CELL } from "../render/caps.js";
import { stripPainter } from "../render/painter.js";
import { paintWorld } from "../render/scene.js";
import { fitRow } from "../render/text.js";
import { paintScene, paintStress } from "./scene0.js";
import { Game } from "./game.js";
import { cmdDemo } from "./demo.js";
import { appendSignal, eventsPath } from "../bridge/signal.js";
import { hookSnippet, plan, apply, status, detected, eventSignals, homeVar, TARGET_NAME } from "../bridge/install.js";
import { World } from "../core/world.js";
import * as fs from 'node:fs';
import * as path from 'node:path';
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
const SGR_PENDING = '\x1b[38;2;24;26;36m\x1b[48;2;226;190;96m';
const SGR_URGENT = '\x1b[38;2;255;238;238m\x1b[48;2;138;22;30m';
const SGR_IDLE = '\x1b[38;2;158;166;188m\x1b[48;2;24;26;36m';
/**
 * 焦点切换的最小间隔。
 *
 * 焦点变化会 resize PTY，而 resize 让内层 TUI 全量重绘 —— 连按会把它抖成一片。
 */
const FOCUS_DEBOUNCE_MS = 180;
function usage() {
    return [
        '摸鱼 —— 谁不想在 Claude Code 干活的时候酣畅淋漓地砍一顿火柴小人',
        '',
        '用法：',
        '  moyu -- <命令...>        在外壳里跑一个 CLI，游戏在下半屏（例：moyu -- claude）',
        '  moyu demo                整屏跑游戏本身（调手感用）',
        '  moyu install             把任务信号 hook 装进 Claude Code / Codex（默认干跑，加 --write 才写）',
        '  moyu install --uninstall 摘掉它们（同样默认干跑）',
        '  moyu hook [--codex]      只打印配置片段，自己手动并进去',
        '  moyu signal start|done   手动喂一个任务信号（给别的 CLI 做集成）',
        '  moyu doctor              体检：hook 装没装、事件文件、PTY、node 版本',
        '  moyu bench [帧数] [--stress|--game|--strip] [--tier=graphics|half]  无头跑渲染，报字节/帧和毫秒/帧',
        '  moyu doctor --caps       打印渲染档位探测结果（只有在真终端里跑才有意义）',
        '  moyu doctor --reset      终端被搞坏之后无条件还原',
        '',
        `游戏内：J 砍 · A/D 走 · 空格 跳 · t 假装任务完成 · y 假装下一个任务开始`,
        `外壳内热键：${hotkeyHint('cli')}`,
    ].join('\n');
}
async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (cmd === 'doctor') {
        if (argv.includes('--caps'))
            return cmdCaps();
        if (argv.includes('--reset')) {
            writeAllSync(1, doctorResetSeq());
            return 0;
        }
        return cmdDoctor();
    }
    if (cmd === 'install')
        return cmdInstall(argv.slice(1));
    if (cmd === 'demo')
        return cmdDemo(argv[1] === undefined ? undefined : Number(argv[1]));
    if (cmd === 'hook') {
        const t = argv.includes('--codex') ? 'codex' : 'claude';
        process.stdout.write(`${hookSnippet(eventsPath(), t)}\n`);
        return 0;
    }
    if (cmd === 'signal') {
        const k = argv[1];
        if (k !== 'start' && k !== 'done' && k !== 'notify') {
            process.stderr.write('用法：moyu signal start|done|notify\n');
            return 2;
        }
        appendSignal(k);
        process.stdout.write(`${k} → ${eventsPath()}\n`);
        return 0;
    }
    if (cmd === 'bench') {
        const tier = tierArg(argv);
        if (tier === 'bad') {
            process.stderr.write('--tier= 只认 graphics 或 half\n');
            return 2;
        }
        return cmdBench(Number(argv[1] ?? 300), argv.includes('--stress'), argv.includes('--game'), argv.includes('--strip'), tier);
    }
    if (cmd === 'play') {
        process.stderr.write('moyu play（全屏游戏）是 M1 的内容，还没实现。\n');
        return 1;
    }
    if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
        process.stdout.write(`${usage()}\n`);
        return cmd === undefined ? 2 : 0;
    }
    const dd = argv.indexOf('--');
    const inner = dd >= 0 ? argv.slice(dd + 1) : argv;
    if (inner.length === 0) {
        process.stderr.write(`${usage()}\n`);
        return 2;
    }
    return cmdWrap(inner);
}
/* ── moyu install / moyu doctor ─────────────────────────────────────────
 *
 * 这两条命令是别人第一次接触摸鱼的地方，所以刻意话多：install **默认干跑**、
 * 把要改的文件和要写的每一条都摆出来，doctor 只读。改用户的配置这件事不该有一步是猜的。
 */
const INSTALL_FLAGS = new Set(['--write', '--uninstall', '--remove', '--print', '--claude', '--codex', '--dry-run', '--events']);
const BOTH = ['claude', 'codex'];
function pad(s, n) {
    return s + ' '.repeat(Math.max(0, n - [...s].length));
}
function cmdInstall(args) {
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
        process.stderr.write('没找到 Claude Code 或 Codex（~/.claude 和 ~/.codex 都不存在，PATH 上也没有）。\n' +
            '要强制装：moyu install --claude --write（或 --codex）。\n');
        return 1;
    }
    const plans = targets.map((t) => plan(t, { file, uninstall: un }));
    const out = [un ? '摸鱼 hook 卸载' : '摸鱼 hook 安装', ''];
    let failed = false;
    for (const p of plans) {
        const name = pad(TARGET_NAME[p.target], 11);
        if (p.action === 'error') {
            failed = true;
            out.push(`✗ ${name}  ${p.error ?? '未知错误'}`, `  手动版：moyu install --${p.target} --print`, '');
            continue;
        }
        if (write) {
            let backup = null;
            try {
                backup = apply(p);
            }
            catch (e) {
                failed = true;
                out.push(`✗ ${name}  写不进 ${homeVar(p.path)}：${e instanceof Error ? e.message : String(e)}`, '');
                continue;
            }
            const what = p.action === 'unchanged' ? '本来就是这样，没动' : p.action === 'remove' ? '已删掉' : p.action === 'create' ? '已新建' : '已更新';
            out.push(`✓ ${name}  ${what} ${homeVar(p.path)}${backup === null ? '' : `（备份 ${homeVar(backup)}）`}`);
        }
        else {
            const what = p.action === 'unchanged' ? '不用改（已经是想要的样子）' : p.action === 'remove' ? `会删掉整个文件（摘掉 ${p.removed} 条之后它就空了）` : p.action === 'create' ? '会新建' : `会更新${p.removed > 0 ? `（先摘掉 ${p.removed} 条旧的）` : ''}`;
            out.push(`${name}  ${homeVar(p.path)}`, `  ${what}`);
            const mark = p.action === 'unchanged' ? '·' : '+';
            for (const [event, kind] of eventSignals(p.target)) {
                if (p.added.includes(event))
                    out.push(`  ${mark} ${pad(event, 17)}→ ${kind}`);
            }
        }
        if (p.target === 'codex' && !un && p.action !== 'unchanged') {
            out.push('  ! Codex 下次启动会问 "Hooks need review" —— 选 "Trust all and continue"，不然 hook 不会跑');
        }
        out.push('');
    }
    out.push(`事件文件：${homeVar(file)}`);
    if (!write)
        out.push('', '以上是干跑，什么都没改。真要写：' + (un ? 'moyu install --uninstall --write' : 'moyu install --write'));
    else if (!un && !failed)
        out.push('可以了：moyu -- claude（或 moyu -- codex）。不装 hook 也能玩：游戏里按 t / y 手动喂信号。');
    process.stdout.write(`${out.join('\n')}\n`);
    return failed ? 1 : 0;
}
/** 事件文件的最后一条信号。只读尾部 4KB —— 这文件是只追加的，可能很长。 */
function lastSignal(file) {
    let fd = -1;
    try {
        const size = fs.statSync(file).size;
        const n = Math.min(size, 4096);
        const buf = Buffer.alloc(n);
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, n, size - n);
        const lines = buf.toString('utf8').trim().split('\n');
        const last = lines[lines.length - 1]?.trim() ?? '';
        if (last === '')
            return '空的（还没有任何事件）';
        const parts = last.split(/\s+/);
        const kind = parts[parts.length - 1] ?? '?';
        const ts = Number(parts[0]);
        if (!Number.isFinite(ts) || parts.length < 2)
            return `最后一条 ${kind}`;
        const age = Math.max(0, Math.round(Date.now() / 1000 - ts));
        const when = age < 60 ? `${age} 秒前` : age < 3600 ? `${Math.round(age / 60)} 分钟前` : `${Math.round(age / 3600)} 小时前`;
        return `最后一条 ${kind}（${when}）`;
    }
    catch {
        return '读不出来';
    }
    finally {
        if (fd >= 0) {
            try {
                fs.closeSync(fd);
            }
            catch { /* 关不掉也没别的办法 */ }
        }
    }
}
/** `moyu doctor`：只读的体检。装出问题的时候第一件该跑的事。 */
async function cmdDoctor() {
    const out = ['摸鱼体检', ''];
    const major = Number(process.versions.node.split('.')[0] ?? 0);
    out.push(`node        ${process.version}${major >= 22 ? '' : '  ← 太旧了，要 >= 22'}`);
    // PTY 是 `moyu -- <cmd>` 的硬依赖，但 `moyu demo` 不需要它 —— 所以坏了也不是致命的。
    let pty;
    try {
        await import('@lydell/node-pty');
        pty = '可用';
    }
    catch (e) {
        pty = `加载失败（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）—— moyu -- <cmd> 用不了，moyu demo 照样能玩`;
    }
    out.push(`PTY         ${pty}`);
    const file = eventsPath();
    out.push(`事件文件    ${homeVar(file)}：${fs.existsSync(file) ? lastSignal(file) : '还不存在（装了 hook 或按过 t/y 之后才有）'}`);
    for (const t of BOTH) {
        const st = status(t, { file });
        const name = pad(TARGET_NAME[t], 11);
        if (st.broken !== null) {
            out.push(`${name} ${homeVar(st.path)} 不是合法 JSON：${st.broken}`);
            continue;
        }
        if (st.events.length === 0) {
            out.push(`${name} 没装${detected(t) ? `（moyu install --${t} --write）` : '（这台机器上也没装这个 CLI）'}`);
            continue;
        }
        out.push(`${name} 已装 ${st.events.join(' / ')}${st.stale ? '  ← 命令和现在的事件文件路径不一致，重跑 moyu install --write' : ''}`);
        if (t === 'codex')
            out.push('            （Codex 那边还要在启动时点过一次 "Trust all and continue" 才真的会跑）');
    }
    out.push('', '渲染档位：moyu doctor --caps（要在真终端里跑）', '终端被搞坏了：moyu doctor --reset');
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
function cmdBench(frames, stress, game, strip, tier) {
    const n = Number.isFinite(frames) && frames > 0 ? Math.floor(frames) : 300;
    const paint = stress ? paintStress : game || strip ? benchGame() : paintScene;
    const [cols, rows] = strip ? [fieldColsFor(100), DEFAULT_GAME_ROWS] : [160, 45];
    const t = tier === 'graphics'
        ? new GraphicsTarget(cols, rows, BENCH_CELL.w, BENCH_CELL.h)
        : new Canvas(cols, rows);
    let bytes = 0;
    let peak = 0;
    const t0 = process.hrtime.bigint();
    for (let f = 0; f < n; f++) {
        paint(t, f);
        const s = t.encode(1);
        bytes += s.length > 0 ? t.lastBytes : 0;
        if (t.lastBytes > peak)
            peak = t.lastBytes;
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
const BENCH_CELL = { w: 16, h: 34 };
/** `--tier=` 的解析。写错了要报错而不是静默退档 —— bench 打出来的数字必须知道自己量的是哪一档。 */
function tierArg(argv) {
    const a = argv.find((x) => x.startsWith('--tier='));
    if (a === undefined)
        return 'half';
    const v = a.slice('--tier='.length);
    return v === 'graphics' || v === 'half' ? v : 'bad';
}
/**
 * `bench --game` 用的无头驱动：真实的战斗世界 + 一段脚本化的操作。
 *
 * 意义在于它测的是**会真正发生的**帧，而不是一个人造场景 —— 断肢乱飞 + 血 + 刀光同时在动
 * 是这个游戏字节数最高的时刻，那才是该盯着的数字。种子固定，所以两次跑出来的字节数可比。
 */
function benchGame() {
    let w = null;
    let p = null;
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
        const move = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
        const first = { move, jump: f % 53 === 0, slash: f % 11 === 0 };
        w.step(1 / 60, first);
        w.step(1 / 60, { move, jump: false, slash: false });
        if (f === 900)
            w.taskDone();
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
 */
async function cmdCaps() {
    const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
    const t = termSize();
    // 回复必须在 raw 下读：行缓冲会把它扣到用户按回车，那时候早超时了。
    let raw = false;
    if (tty) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        raw = true;
    }
    const caps = await probeCaps({
        stdin: process.stdin,
        write: (x) => { process.stdout.write(x); },
        env: process.env,
        cols: t.cols, rows: t.rows, tty,
    });
    if (raw) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }
    // 按探到的档位算一遍**出货那个条**的几何，顺带把身高折算成设备像素 ——
    // "认不认得出是人"最终就是这个数字说话（3 像素的时候是不可能的，40 像素才有戏）。
    const l = computeLayout({ cols: t.cols, rows: t.rows });
    const cols = l.kind === 'split' ? l.layout.fieldCols : fieldColsFor(t.cols);
    const rows = l.kind === 'split' ? l.layout.gameRows : DEFAULT_GAME_ROWS;
    const target = caps.tier === 'graphics'
        ? new GraphicsTarget(cols, rows, caps.cellW, caps.cellH)
        : new Canvas(cols, rows);
    const painter = stripPainter(target);
    const w = new World(1);
    w.resize(painter.vw, painter.vh);
    process.stdout.write([
        `终端       ${t.cols}×${t.rows} 字符格${tty ? '' : '（不是 TTY —— 下面的探测结果没有意义）'}`,
        `档位       ${caps.tier}`,
        `理由       ${caps.why}`,
        `格像素     ${caps.cellW}×${caps.cellH}`
            + `${caps.cellW === DEFAULT_CELL.w && caps.cellH === DEFAULT_CELL.h ? '（= 默认值）' : ''}`,
        `帧率       ${caps.fps}fps`,
        `游戏条     ${cols}×${rows} 字符格 → ${target.pixelW}×${target.pixelH} 像素`,
        `世界坐标   ${painter.vw}×${painter.vh} 虚拟像素，k = ${painter.k.toFixed(2)}`,
        `火柴人     ${w.fh} 虚拟像素 → 屏幕上约 ${Math.round(w.fh * painter.k)} 像素高`,
        caps.leftover.length > 0 ? `抢跑的输入 ${caps.leftover.length} 字节（已丢弃 —— 这个命令不转发给谁）` : '',
        '',
        '覆盖用的环境变量：MOYU_TIER=half|graphics 强制档位，MOYU_CELL=16x34 强制格像素。',
    ].filter((x) => x !== '').join('\n') + '\n');
    return 0;
}
/* ────────────────────────────── 外壳 spike ────────────────────────────── */
async function cmdWrap(inner) {
    // 没有 TTY 就没有"分屏"可言（管道、CI、被别的程序调用）。这时候唯一正确的行为是
    // 完全退化成一层透明的转发 —— 装作外壳不存在，别把转义序列灌进人家的管道里。
    if (!process.stdout.isTTY || !process.stdin.isTTY)
        return runBare(inner);
    return new Shell(inner).run();
}
/** 无 TTY 的退化路径：直接继承 stdio 跑内层，退出码原样传出去。 */
async function runBare(inner) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
        const child = spawn(inner[0], inner.slice(1), { stdio: 'inherit' });
        child.on('error', (e) => { process.stderr.write(`moyu: 起不来 ${inner[0]}：${e.message}\n`); resolve(127); });
        child.on('exit', (code, signal) => resolve(signal !== null ? 129 : (code ?? 0)));
    });
}
/** 真实终端尺寸。拿不到就给一个保守的默认值，而不是崩。 */
function termSize() {
    return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}
class Shell {
    argv;
    focus = 'cli';
    /** 用户手动调过的游戏区行数。一旦有值就不再按焦点联动 —— 他有自己的想法。 */
    manualGameRows;
    /** `^G h` 收起了吗。收起 ≠ 让屏：塌成 1 行，那一行写着怎么回来（见 `setCollapsed`）。 */
    collapsed = false;
    /** 收起那一行上一次写出去的字节。和 `lastHud` 一样，用来做"没变就不发"。 */
    lastBar = '';
    layout = null;
    arbiter;
    pass;
    vt;
    /**
     * 画布。**不是 `readonly`** —— 启动探测之后才知道是哪一档，换档要换一个实例。
     * 构造时先给半块档兜底：探测失败、非 TTY、tmux 都停在这个值上。
     */
    target;
    /** 世界坐标 → 设备像素的那把画笔。`target` 换了或者尺寸变了就要重建。 */
    painter;
    router = new InputRouter();
    teardown;
    /** 下半屏那个游戏。和 `moyu demo` 是同一份模拟 —— 手感只调一次。 */
    game = new Game();
    pty = null;
    timer = null;
    tee = null;
    /** 帧间隔。探测到 SSH 会把它翻倍（15fps），所以不能直接用 `FRAME_MS`。 */
    frameMs = FRAME_MS;
    frames = 0;
    skipped = 0;
    paintMs = 0;
    /** 上一帧发出去的 HUD 字节。和"画布没动"一起构成"整帧一个字节都不发"的门。 */
    lastHud = '';
    lastToggle = 0;
    resolve = null;
    finished = false;
    constructor(argv) {
        this.argv = argv;
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
            // 备用屏切换**不让屏**，只在新缓冲区上重建几何 —— 见 altscreen.ts 的文件头，
            // 真实 claude 整个会话都待在备用屏上，让屏等于游戏永久消失。
            onAltScreen: () => { this.onScreenSwap(); },
            // ED 2 / ED 3 不受滚动区约束，会把游戏区一起擦掉。画布是差分编码的，
            // 不 invalidate 它就以为屏幕上还是上一帧，什么都不重发，游戏区一直黑着。
            onFullClear: () => { this.target.invalidate(); this.lastHud = ''; },
        });
        this.vt = new VtCursor({ cols: t.cols, rows: innerRows });
        this.target = new Canvas(t.cols, 1);
        this.painter = stripPainter(this.target);
        this.teardown = new Teardown(() => this.restoreState());
    }
    /** 退出时的还原参数。现场取值 —— 内层光标一直在动，安装时的快照到这会儿早过期了。 */
    restoreState() {
        // homeRow 给内层光标所在行：还原时从那里 ED 0，游戏区被擦干净，
        // 之后 shell 的提示符接着 CLI 的最后一行往下走，看不出这里跑过一个游戏。
        return {
            homeRow: this.vt.row,
            // 内层 push 过 kitty 键盘标志就照数弹回去，它用 `CSI = … u` 直接设过的只能硬复位。
            // 漏掉这一步的症状离我们很远：用户回到自己的 shell，方向键变成乱码。
            kittyPops: this.pass.kittyDepth,
            kittyHardReset: this.pass.kittySet,
            // 只有真上传过图才发删除。半块档发了就是往用户屏幕上打一行 `a=d,d=I,…` 字面量 ——
            // 不认 APC 的终端会把它当文字，那比留一张图糟糕得多。
            deleteImage: this.target.tier === 'graphics',
        };
    }
    async run() {
        // 终端在我们底下消失时 stdout 会 EPIPE。它不该变成一次 uncaughtException ——
        // 那条路径会去打印栈，而屏幕已经没了。
        process.stdout.on('error', () => { });
        this.teardown.install();
        this.teardown.onRestore(() => { this.stopFrames(); });
        this.teardown.onRestore(() => { try {
            process.stdin.setRawMode(false);
        }
        catch { /* 已经不是 TTY 了 */ } });
        this.teardown.onRestore(() => { this.pty?.killNow(); });
        this.teardown.onRestore(() => { this.closeTee(); });
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
            this.painter = stripPainter(this.target);
        }
        const first = computeLayout({ cols: t.cols, rows: t.rows });
        if (first.kind === 'split') {
            this.applyLayout(first.layout, 'init');
        }
        else {
            // 太小就不分屏，整屏给内层。走 initialize 而不是 set —— 这是初始状态，
            // 没有"从可见变成不可见"这回事，也没有东西需要重绘。
            this.write(`\x1b[H\x1b[2J${fullScrollRegionSeq()}`);
            this.arbiter.initialize(['too-small']);
            process.stderr.write(`moyu: ${first.reason}，游戏区先收起（放大终端后自动出现）\r\n`);
        }
        const innerRows = this.layout?.innerRows ?? t.rows;
        try {
            this.pty = await PtyHost.spawn({
                file: this.argv[0],
                args: this.argv.slice(1),
                cols: t.cols,
                rows: innerRows,
                env: process.env,
            });
        }
        catch (e) {
            this.teardown.run();
            process.stderr.write(`moyu: ${e instanceof Error ? e.message : String(e)}\n`);
            return 127;
        }
        this.pty.onData((data) => { this.onPtyData(data); });
        this.pty.onExit(({ exitCode }) => { this.finish(exitCode); });
        // 探测那 150ms 里用户抢跑敲的键。攒到现在才喂 —— 那会儿 PTY 还不存在，
        // 转发给谁都没有；丢掉的话用户会觉得"开头几个字符吃了"。
        if (caps.leftover.length > 0)
            this.onStdin(caps.leftover);
        process.stdin.on('data', (chunk) => { this.onStdin(chunk); });
        // 用 stdout 的 'resize' 而**不是** `process.on('SIGWINCH')`：SIGWINCH 的监听器顺序
        // 不保证排在 Node 自己刷新 `process.stdout.columns/rows` 之后，直接在信号里读尺寸
        // 会读到**上一次**的值。'resize' 是文档承诺"columns/rows 已经更新"之后才发的。
        process.stdout.on('resize', () => { this.onResize(); });
        this.startFrames();
        return new Promise((resolve) => { this.resolve = resolve; });
    }
    /* ── 布局 ─────────────────────────────────────────────────────────── */
    /**
     * 把一份布局落到真实终端和 PTY 上。
     *
     * 顺序是有讲究的：**先设滚动区，再 resize PTY**。resize 会给内层发 SIGWINCH，
     * 它收到就立刻按新尺寸重绘，那一刻滚动区必须已经是新的 —— 否则它的重绘会被旧区间截断。
     */
    applyLayout(l, why) {
        assertLayout(l);
        // 游戏区**变矮**时（收起、`^G j`）要从**旧**的顶边开始擦，不是新的 —— 让出去的那几行
        // 上还留着上一帧的画布，而它们现在归内层了。内层是 TUI 的话 SIGWINCH 会让它重画一遍
        // 盖掉，但内层是个普通 shell 时不会，那几行就一直挂在那儿。
        const prevTop = this.layout?.gameTop;
        const clearFrom = prevTop === undefined ? l.gameTop : Math.min(prevTop, l.gameTop);
        this.layout = l;
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
            this.painter = stripPainter(this.target);
            this.game.resize(this.painter.vw, this.painter.vh);
        }
        this.lastHud = '';
        this.lastBar = '';
        let seq = '';
        // 启动时清屏：包裹层要接管整个屏幕的几何，不清屏的话残留内容会和分屏边界错位，
        // 看起来就像坏了。退出时 teardown 的 homeRow + ED 0 负责收拾干净。
        if (why === 'init')
            seq += '\x1b[H\x1b[2J';
        seq += scrollRegionSeq(l);
        // 擦掉游戏区：resize / 收屏之后那里可能留着旧内容或内层的残迹。
        seq += `\x1b[${clearFrom};1H\x1b[J`;
        this.write(seq + this.vt.restoreSeq());
        this.pty?.resize(l.cols, l.innerRows);
    }
    /** 这一拍该分几行给游戏。收起时恒定 1 行（那一行是状态条，不是画布）。 */
    wantGameRows() {
        return this.collapsed ? 1 : this.manualGameRows;
    }
    /**
     * `^G h` —— 收起 / 展开。
     *
     * **收起不是让屏，是塌成 1 行。** 让屏（整条消失）是用户报的那条 bug 的成因：
     * 按键路径本身是好的，再按一次确实会重新分屏、重新出帧；坏的是屏幕上再没有任何东西
     * 告诉你怎么回去 —— 连那行 `^G h 收起` 的提示都跟着一起消失了，唯一的线索只剩记忆，
     * 而记住的那半个 `h` 按下去只会进内层 CLI 的输入框（看起来就像"打不开了"）。
     *
     * 所以留 1 行给一条写着 `^G h 展开` 的状态条：40 行的终端里花 1 行换一条永远看得见的
     * 回头路。顺带这一行还接着任务完成的横幅 —— 收起期间任务跑完了，你照样看得见。
     */
    setCollapsed(v) {
        if (this.collapsed === v)
            return;
        this.collapsed = v;
        // 收起要**删图**：擦文字擦不掉它（图是终端另存的一层），一张挂在 CLI 上面的
        // 图就是纯粹的垃圾。展开时终端里那张已经没了，所以必须整幅重传，不能"没动就不发"。
        if (v)
            this.write(this.target.disposeSeq());
        else
            this.target.invalidate();
        this.relayout();
    }
    /** 让出整屏。两个原因（用户收起 / 太小）共用这一条路径。 */
    onYield() {
        const t = termSize();
        const gameTop = this.layout?.gameTop ?? t.rows;
        // 先撤滚动区、擦掉游戏区，再把 PTY 调成整屏。反过来的话内层收到 SIGWINCH
        // 会立刻按整屏高度画，而滚动区还卡在上半屏，它画到底部时会被截断。
        // 让屏要顺手把终端里那张图删掉：擦文字擦不掉它（图是终端另存的一层），
        // 收起游戏区之后一张挂在那儿的图就是纯粹的垃圾。
        this.write(this.target.disposeSeq() + fullScrollRegionSeq() + `\x1b[${gameTop};1H\x1b[J` + this.vt.restoreSeq());
        this.pass.region = { top: 1, bottom: t.rows };
        this.pass.cols = t.cols;
        this.vt.resize(t.cols, t.rows);
        this.pty?.resize(t.cols, t.rows);
    }
    /** 收屏，重新分屏。 */
    onResume() {
        if (this.finished || this.arbiter.yielded)
            return;
        const t = termSize();
        const r = computeLayout({ cols: t.cols, rows: t.rows, manualGameRows: this.wantGameRows() });
        // too-small 本身就是让屏原因之一，所以走到这里必然是 split。真不是就保持让屏，别崩。
        if (r.kind !== 'split') {
            this.arbiter.set('too-small', true);
            return;
        }
        this.applyLayout(r.layout, 'resume');
    }
    /**
     * 内层切了备用屏（`?1049h` / `?1049l`）。**不让屏**，只把我们的几何在新缓冲区上重建。
     *
     * 为什么不让屏：实测真实 claude 2.1.260 启动时切过去就再也不回来（退出才 `?1049l`），
     * 让屏等于游戏在启动一秒后永久消失、同屏合成根本没发生过。备用屏只是另一个缓冲区，
     * 内层有多少行是我们用 TIOCSWINSZ 告诉它的，跟它画在哪个缓冲区上无关 ——
     * 所以尺寸不用动，也**不要** resize PTY（那会白白触发内层一次全量重绘）。
     *
     * 两个缓冲区之间唯一的实质差别是 **DECSTBM 是每缓冲区各自一份**：切过去之后新缓冲区
     * 的边距是默认的整屏，不重设的话内层换行就能滚到游戏区上。
     *
     * 必须推到 setImmediate：回调是在 `?1049h/l` 的字节**还没写出去**的时候触发的
     * （Passthrough 先上报、再吐字节），这时候活动屏幕还是旧的那个。同步设滚动区就设到了
     * 旧缓冲区上 —— 白设一遍，而真正要去的那个缓冲区还是整屏边距。
     */
    onScreenSwap() {
        setImmediate(() => {
            const l = this.layout;
            if (this.finished || l === null || this.arbiter.yielded)
                return;
            this.write(scrollRegionSeq(l) + `\x1b[${l.gameTop};1H\x1b[J` + this.vt.restoreSeq());
            // 新缓冲区上游戏区是空的（1049h 会清屏，也会清掉图），而画布只发变化 ——
            // 不 invalidate 就一直黑着。
            this.target.invalidate();
            this.lastHud = '';
        });
    }
    onResize() {
        const t = termSize();
        const r = computeLayout({ cols: t.cols, rows: t.rows, manualGameRows: this.wantGameRows() });
        if (r.kind !== 'split') {
            this.arbiter.set('too-small', true);
            // 让屏路径按当时的尺寸调过 PTY，但尺寸又变了，得再跟一次。
            this.pass.region = { top: 1, bottom: t.rows };
            this.pass.cols = t.cols;
            this.vt.resize(t.cols, t.rows);
            this.pty?.resize(t.cols, t.rows);
            return;
        }
        const flipped = this.arbiter.set('too-small', false);
        if (this.arbiter.yielded) {
            // 还在因为别的原因让屏（用户收起）：只把整屏尺寸跟上。
            this.pass.region = { top: 1, bottom: t.rows };
            this.pass.cols = t.cols;
            this.vt.resize(t.cols, t.rows);
            this.pty?.resize(t.cols, t.rows);
            return;
        }
        // flipped 为真时 onResume 已经排好了 applyLayout，别做第二遍。
        if (!flipped)
            this.applyLayout(r.layout, 'resize');
    }
    relayout() {
        if (this.arbiter.yielded)
            return;
        const t = termSize();
        const r = computeLayout({ cols: t.cols, rows: t.rows, manualGameRows: this.wantGameRows() });
        if (r.kind === 'split')
            this.applyLayout(r.layout, 'resize');
        else
            this.arbiter.set('too-small', true);
    }
    /* ── 帧循环 ───────────────────────────────────────────────────────── */
    startFrames() {
        if (this.timer !== null)
            return;
        this.timer = setInterval(() => { this.tick(); }, this.frameMs);
        // 帧定时器不该把进程钉在事件循环上 —— 内层退出后我们要能自然收尾。
        this.timer.unref();
    }
    stopFrames() {
        if (this.timer === null)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    tick() {
        const l = this.layout;
        if (l === null || this.finished || this.arbiter.yielded)
            return;
        // 内层的吞吐优先于游戏：它在刷屏时我们丢帧，而不是把它的输出排在我们的队列后面。
        if (process.stdout.writableLength > BACKPRESSURE) {
            this.skipped++;
            return;
        }
        if (this.collapsed) {
            this.tickCollapsed(l);
            return;
        }
        const t0 = process.hrtime.bigint();
        this.game.advance(Date.now());
        paintWorld(this.painter, this.game.world);
        const body = this.target.encode(l.gameTop);
        this.paintMs = Number(process.hrtime.bigint() - t0) / 1e6;
        this.frames++;
        // 任务完成的响铃 + 桌面通知。**摸鱼摸过头错过下一步操作，这个产品就是负分**，
        // 所以这里还顺手把焦点交回 CLI —— 横幅弹出来的那一刻，你的按键就应该回到 claude 上。
        const alert = this.game.takeAlert();
        if (alert !== null && this.focus === 'game')
            this.toggleFocus();
        // 必须是**一次** write：中间被内层的输出插进来会同时撕裂两边的画面。
        //
        // 画布最后一格恰好是屏幕右下角，写它会置上"延迟换行"标志，但紧跟着的
        // restoreSeq 以 SGR 开头 —— 控制序列不会消费那个标志，只有可打印字符会。所以不会滚屏。
        // **没动就不发**：画布没变（`body === ''`）+ HUD 文本没变 + 没有横幅 = 整帧零字节。
        // 任务完成后的暂停就是这个状态，而那正是用户在读横幅、最不该有带宽噪声的时候。
        // 隐藏光标那一对也一起省掉 —— 没画东西就没有光标要藏。
        const hud = this.hudSeq(l);
        if (body === '' && hud === this.lastHud && alert === null)
            return;
        this.lastHud = hud;
        this.write(`\x1b[?25l${alert ?? ''}${hud}${body}${this.vt.restoreSeq()}`);
    }
    /**
     * 收起状态下那一行。
     *
     * 模拟照常推进（`advance` 是 0.1ms 级的纯计算），只是不作画 —— 这样任务完成的
     * 响铃 / 横幅在收起期间照样会来。**打断摸鱼是这个产品的第一职责**，收起不该把它关掉。
     */
    tickCollapsed(l) {
        this.game.advance(Date.now());
        const alert = this.game.takeAlert();
        if (alert !== null && this.focus === 'game')
            this.toggleFocus();
        const h = this.game.hud();
        const waiting = this.router.awaitingCommand;
        const text = waiting ? pendingRows().join(' · ')
            : h.urgent ? `${h.short} · ^G h 展开`
                : `摸鱼收起了 · ^G h 展开 · ^G q 退出`;
        // 最后一列留白：写屏幕右下角会置上延迟换行标志，见 hudSeq。
        const seq = `${waiting ? SGR_PENDING : h.urgent ? SGR_URGENT : SGR_IDLE}`
            + `\x1b[${l.gameTop};1H${fitRow(text, '', Math.max(1, l.cols - 1))}\x1b[0m`;
        if (seq === this.lastBar && alert === null)
            return;
        this.lastBar = seq;
        this.write(`\x1b[?25l${alert ?? ''}${seq}${this.vt.restoreSeq()}`);
    }
    /**
     * 画布右边那块文本区。**和画布同排**，不再单独占一行 —— 整条只有 1~2 行，
     * 拿一行去写字就没得玩了。
     *
     * 为什么战绩不画在画布里：中文在半块画布上根本画不出来（一个字要 2×2 个"像素"
     * 也还是糊的），而文本行便宜得离谱 —— 30 列的一行连 SGR 带定位不到 60 字节，
     * 比同样面积的像素 diff 还小。所以画布里只有火柴人，字全在右边。
     *
     * 任务完成时整块变红底 —— 它的任务是**打断摸鱼**，得比常规 HUD 显眼一个数量级。
     */
    hudSeq(l) {
        // 最后一列留白：写屏幕右下角会置上延迟换行标志，见文件头。
        const w = l.cols - l.fieldCols - 1;
        if (w <= 0)
            return '';
        const h = this.game.hud();
        const waiting = this.router.awaitingCommand;
        // 前缀键按下之后必须**立刻**看得见反应，否则用户会再按一次 ——
        // 而"再按一次"以前是把字面 Ctrl+G 送进内层（claude 会开外部编辑器）。
        // 现在连按也是切焦点了，但这行反馈依然是那条 bug 的另一半解法。
        const rows = waiting ? pendingRows() : this.statusRows(h);
        // SGR 是全局状态，设一次就管到 reset —— 所以颜色只发一遍，后面只有定位和文字。
        let out = waiting ? SGR_PENDING : h.urgent ? SGR_URGENT : SGR_IDLE;
        for (let i = 0; i < l.gameRows; i++) {
            // 每一行都写满（哪怕是空行）：不写的话上一次的文字会留在那儿，
            // 而这块区域不走画布的 diff，没人替它擦。
            out += `\x1b[${l.gameTop + i};${l.fieldCols + 1}H${fitRow(rows[i] ?? '', '', w)}`;
        }
        return out + '\x1b[0m';
    }
    /** 常规状态的文本行：第一行战绩（1 行高时唯一看得见的那行），第二行该按什么。 */
    statusRows(h) {
        const keys = hotkeyHint(this.focus);
        if (process.env.MOYU_DEBUG === undefined || process.env.MOYU_DEBUG === '') {
            return [h.short, keys];
        }
        // 调试时用性能数字**换掉**热键行：两者都塞不进 30 列，而调试的人不需要热键提示。
        const perf = `${(this.target.lastBytes / 1024).toFixed(1)}KB ${this.paintMs.toFixed(2)}ms`
            + (this.skipped > 0 ? ` 丢${this.skipped}` : '');
        return [h.short, perf, keys];
    }
    /* ── 数据流 ───────────────────────────────────────────────────────── */
    onPtyData(data) {
        if (this.tee !== null) {
            try {
                fs.writeSync(this.tee, data);
            }
            catch {
                this.closeTee();
            }
        }
        const rewritten = this.pass.push(data);
        if (rewritten.length === 0)
            return;
        // 喂 VtCursor 的必须是**改写后**的字节：我们要还原的是真实终端光标的位置，
        // 而真实终端看到的就是这一版。喂原始字节的话，一条被夹取的定位会让跟踪值和终端
        // 实际状态分叉 —— 而这个分叉恰好只在"内层试图越界"时发生，也就是最需要还原正确的时候。
        this.vt.feed(rewritten);
        process.stdout.write(rewritten);
    }
    onStdin(chunk) {
        for (const a of this.router.route(chunk)) {
            switch (a.kind) {
                case 'forward':
                    this.pty?.write(a.bytes);
                    break;
                // 焦点在游戏：按键喂给游戏，**不**转发给内层（不然打字会跑进 claude 的输入框）。
                // 游戏里的 q / Ctrl+C 只是"退出游戏"，绝不能杀掉用户的 CLI 会话 ——
                // 所以它被翻译成"把焦点交回 CLI"。真要退整个外壳走 Ctrl+G q。
                case 'game':
                    if (this.game.feed(a.bytes))
                        this.toggleFocus();
                    break;
                case 'toggle-focus':
                    this.toggleFocus();
                    break;
                case 'toggle-hidden':
                    this.setCollapsed(!this.collapsed);
                    break;
                case 'adjust-split':
                    this.adjustSplit(a.delta);
                    break;
                case 'redraw':
                    this.target.invalidate();
                    this.lastHud = '';
                    this.relayout();
                    break;
                case 'quit':
                    this.finish(0);
                    break;
            }
        }
    }
    toggleFocus() {
        const now = Date.now();
        // debounce 留着，但已经不是为了 resize 了：焦点**不再改尺寸**（游戏条恒定 1~2 行），
        // 所以内层完全不知道有人在切焦点，也就不会重绘。这里挡的只是 HUD 文案的抖动。
        if (now - this.lastToggle < FOCUS_DEBOUNCE_MS)
            return;
        this.lastToggle = now;
        this.focus = this.focus === 'cli' ? 'game' : 'cli';
        // latch 里可能还压着一个方向键。不清掉的话焦点一离开游戏，角色会自己再走 150ms。
        this.game.keys.clear();
        // 路由器必须跟着变。漏了这一行的后果是 HUD 说"焦点在游戏"、按键却还在往内层跑，
        // 而且是**静默**的分叉 —— M0 里两条路都通向内层，所以症状要到 M1 才会显形。
        this.router.focus = this.focus;
    }
    adjustSplit(delta) {
        // 收起着还按"加高"：他要的显然是展开，而不是把收起条调成 2 行。
        if (this.collapsed) {
            if (delta > 0)
                this.setCollapsed(false);
            return;
        }
        const t = termSize();
        const cur = this.layout?.gameRows ?? DEFAULT_GAME_ROWS;
        // 一步 1 行 = 2 个像素行。整条只有 1~4 行，2 行一步会直接撞到两头。
        const next = adjustGameRows(t.rows, cur, delta);
        if (next === cur)
            return;
        this.manualGameRows = next;
        this.relayout();
    }
    /* ── 收尾 ─────────────────────────────────────────────────────────── */
    finish(code) {
        if (this.finished)
            return;
        this.finished = true;
        this.stopFrames();
        this.teardown.run();
        const r = this.resolve;
        this.resolve = null;
        r?.(code);
    }
    write(s) {
        if (s.length > 0)
            process.stdout.write(s);
    }
    /**
     * `MOYU_TEE=<路径>` 把内层的**原始**字节旁录一份。
     *
     * 用途明确：拿真实 Claude Code 的字节流去喂 passthrough 的切点属性测试。
     * 手写的测试输入永远想不到真实程序会发什么。
     */
    openTee() {
        const p = process.env.MOYU_TEE;
        if (p === undefined || p === '')
            return;
        try {
            this.tee = fs.openSync(p, 'a');
        }
        catch {
            this.tee = null;
        }
    }
    closeTee() {
        if (this.tee === null)
            return;
        try {
            fs.closeSync(this.tee);
        }
        catch { /* 关不掉也没别的办法 */ }
        this.tee = null;
    }
}
/**
 * `bin/moyu` 的接管标记。它的语义是"屏幕还欠一次还原"。
 *
 * 用标记文件而不是退出码，因为退出码分不清两件事：内层 CLI 自己退出码 130 是很正常的，
 * 不代表屏幕坏了。而重复还原有真实代价 —— `?1049l` 自带一次光标恢复，
 * 会把用户 shell 的光标搬到一个陈旧的位置去。
 */
function markTakeover() {
    const p = process.env.MOYU_TAKEOVER_FLAG;
    if (p === undefined || p === '')
        return;
    try {
        fs.writeFileSync(p, `${process.pid}\n`);
    }
    catch { /* 没标记只是少一层兜底，不该因此不启动 */ }
}
function clearTakeover() {
    const p = process.env.MOYU_TAKEOVER_FLAG;
    if (p === undefined || p === '')
        return;
    try {
        fs.unlinkSync(p);
    }
    catch { /* 已经没了 */ }
}
export { main };
/** argv[1] 指的是不是这个模块本身。两边都过一遍 realpath，软链才不会骗到我们。 */
function isEntry(entry) {
    const here = fileURLToPath(import.meta.url);
    if (path.resolve(entry) === here)
        return true;
    try {
        return fs.realpathSync(entry) === fs.realpathSync(here);
    }
    catch {
        return false;
    }
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
    main().then((code) => { process.exit(code); }, (e) => {
        // 到这里说明还原钩子已经跑过了（Teardown 挂了 uncaughtException），屏幕是干净的。
        process.stderr.write(`moyu: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
        process.exit(1);
    });
}
