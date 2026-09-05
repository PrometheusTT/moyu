import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPty } from '../../src/shell/pty.ts';
import { TITLE } from '../../src/app/game.ts';

/**
 * `moyu demo` 的 PTY 黄金测试：把整屏版跑在一个我们控制的 PTY 里，对它吐到"终端"上的
 * 字节做断言。这是唯一能在**没有控制终端**的环境里验证它的手段（这台机器上 `stty size`
 * 就是 no tty），而且它盯的是组件测试碰不到的部分：进备用屏的顺序、HUD 和画布同帧到达、
 * 退出时的还原、终端太小的守卫。
 *
 * 事件文件指向临时目录 —— 绝不能读用户真实的 `~/.moyu/events.log`，否则一个真实任务
 * 跑完就会把测试弄红。
 */
const COLS = 100;
const ROWS = 40;

type Session = {
  send: (s: string) => void;
  wire: () => string;
  waitFor: (pred: (s: string) => boolean, what: string, ms?: number) => Promise<string>;
  exited: Promise<{ exitCode: number }>;
  resize: (cols: number, rows: number) => void;
  events: string;
  pid: number;
  kill: () => void;
};

async function launch(seed = 42): Promise<Session> {
  const { spawn } = await loadPty();
  const root = new URL('../../', import.meta.url).pathname;
  const events = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-demo-')), 'events.log');
  const p = spawn(process.execPath, [
    '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    `${root}src/app/main.ts`, 'demo', String(seed),
  ], {
    cols: COLS, rows: ROWS, cwd: root, encoding: null,
    env: { ...process.env, TERM: 'xterm-256color', MOYU_EVENTS: events },
    handleFlowControl: false,
  }) as unknown as {
    pid: number;
    onData: (f: (d: Uint8Array) => void) => unknown;
    onExit: (f: (e: { exitCode: number }) => void) => unknown;
    write: (d: string) => void;
    resize: (c: number, r: number) => void;
    kill: (s?: string) => void;
  };

  const chunks: number[] = [];
  p.onData((d) => { for (const b of d) chunks.push(b); });
  const dec = new TextDecoder();
  const wire = (): string => dec.decode(Uint8Array.from(chunks));

  let exitInfo: { exitCode: number } | null = null;
  const exited = new Promise<{ exitCode: number }>((res) => {
    p.onExit((e) => { exitInfo = e; res(e); });
  });

  const waitFor = async (pred: (s: string) => boolean, what: string, ms = 5000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = wire();
      if (pred(s)) return s;
      if (exitInfo !== null) assert.fail(`等 ${what} 时 demo 已退出（码 ${exitInfo.exitCode}）`);
      if (Date.now() > deadline) assert.fail(`超时等不到：${what}\n最后 300 字节：${JSON.stringify(s.slice(-300))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  return {
    send: (s) => { p.write(s); }, wire, waitFor, exited, events, pid: p.pid,
    resize: (c, r) => { p.resize(c, r); },
    kill: () => { p.kill('SIGKILL'); },
  };
}

/** 抽出所有 CUP 的行号。 */
function cupRows(s: string): number[] {
  return [...s.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((m) => Number(m[1]));
}

/** 半块字符的个数 —— 画布真的在画东西的证据。 */
function blocks(s: string): number {
  return s.split('▀').length - 1;
}

test('起来就进备用屏、关自动换行、藏光标，HUD 上是那句标题', async () => {
  const s = await launch();
  try {
    const w = await s.waitFor((x) => x.includes(TITLE), '标题出现在 HUD 上');
    // 顺序是硬要求：先进备用屏再清屏，否则清掉的是用户的主屏。
    const alt = w.indexOf('\x1b[?1049h');
    assert.ok(alt >= 0, '没进备用屏 —— 玩完用户的滚动历史就没了');
    assert.ok(alt < w.indexOf('\x1b[2J'), '在进备用屏之前就清屏了');
    // 关 DECAWM 是必须的：画布最后一格就是右下角，开着自动换行写它会把整屏顶上去一行。
    assert.ok(w.includes('\x1b[?7l'), '没关自动换行');
    assert.ok(w.includes('\x1b[?25l'), '没藏光标');
    assert.ok(w.indexOf(TITLE) > alt, '标题画在了主屏上');
  } finally { s.kill(); }
});

test('按一下就开打：画布真的在画，而且一格都不落到屏幕外', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    const mark = s.wire().length;
    s.send('j');
    // 两个条件必须**一起**等：第一帧本来就很大（整屏 invalidate），它单独就能凑够 200 个
    // 半块，而那一帧的 HUD 还是标题态 —— 只等像素数会在 'j' 生效之前就返回。
    const w = await s.waitFor(
      (x) => blocks(x.slice(mark)) > 200 && /砍了 \d+ 个/.test(x.slice(mark)), '开打：画布出像素 + HUD 切到战斗态');
    const rows = cupRows(w);
    assert.ok(rows.length > 0, '一条 CUP 都没有 —— 帧循环没跑起来');
    assert.deepEqual(rows.filter((r) => r > ROWS), [], `往屏幕外（第 ${ROWS} 行之下）画了`);
    assert.ok(rows.some((r) => r >= 2), '画布该从第 2 行开始（第 1 行是 HUD）');
  } finally { s.kill(); }
});

test('t 键：红底横幅 + 响铃 + 桌面通知，一帧到达', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    s.send('j');
    await s.waitFor((x) => blocks(x) > 200, '开打');
    const mark = s.wire().length;

    s.send('t');
    const w = await s.waitFor((x) => x.slice(mark).includes('任务完成'), '任务完成横幅');
    const tail = w.slice(mark);
    assert.ok(tail.includes('\x07'), '没响铃 —— 摸鱼摸过头错过下一步操作，这个产品就是负分');
    assert.ok(tail.includes('\x1b]9;'), '没发 OSC 9 桌面通知');
    assert.ok(tail.includes('\x1b[48;2;138;22;30m'), '横幅不是红底 —— 它的任务是打断摸鱼，必须比 HUD 显眼一个数量级');
    // 响铃和横幅必须在同一次 write 里：中间不能夹着一整帧画布，不然听到响声和看到横幅差一帧。
    const bell = tail.indexOf('\x07');
    const banner = tail.indexOf('任务完成');
    assert.ok(banner - bell < 200, `响铃和横幅隔了 ${banner - bell} 字节 —— 不是同一帧`);
  } finally { s.kill(); }
});

test('hook 写进事件文件也能触发（真实信号那条链路，跑在真进程里）', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    s.send('j');
    await s.waitFor((x) => blocks(x) > 200, '开打');
    const mark = s.wire().length;

    fs.mkdirSync(path.dirname(s.events), { recursive: true });
    fs.appendFileSync(s.events, `${Math.floor(Date.now() / 1000)} done\n`);
    await s.waitFor((x) => x.slice(mark).includes('任务完成'), '事件文件里的 done 被读到');

    const mark2 = s.wire().length;
    fs.appendFileSync(s.events, `${Math.floor(Date.now() / 1000)} start\n`);
    await s.waitFor((x) => /砍了 \d+ 个/.test(x.slice(mark2)), '下一个任务开始，HUD 回到战斗态');
  } finally { s.kill(); }
});

/** 退出时必须发齐的还原序列。 */
const RESTORE = ['\x1b[?1049l', '\x1b[r', '\x1b[?7h', '\x1b[0m', '\x1b[?25h'] as const;

test('q 退出：码 0，终端状态还原干净', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    s.send('j');
    await s.waitFor((x) => blocks(x) > 200, '开打');
    s.send('q');
    const e = await s.exited;
    assert.equal(e.exitCode, 0);
    const w = s.wire();
    for (const seq of RESTORE) assert.ok(w.includes(seq), `还原序列里缺 ${JSON.stringify(seq)}`);
    // 备用屏上**不能**发 CUP + ED 0：那会从光标处往下擦**主屏**，也就是用户的滚动历史。
    assert.ok(!/\x1b\[\d+;1H\x1b\[J/.test(w.slice(w.lastIndexOf('\x1b[?1049l'))),
      '撤备用屏之后又擦了一次 —— 擦掉的是用户的滚动历史');
  } finally { s.kill(); }
});

test('Ctrl+C 走同一条退出路径（raw 模式下它是普通字节，不是信号）', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    s.send('\x03');
    const e = await s.exited;
    assert.equal(e.exitCode, 0);
    for (const seq of RESTORE) assert.ok(s.wire().includes(seq), `缺 ${JSON.stringify(seq)}`);
  } finally { s.kill(); }
});

test('SIGTERM 也还原，退出码 143', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    s.send('j');
    await s.waitFor((x) => blocks(x) > 200, '开打');
    // 用 pid 而不是 pkill：pkill 按命令行匹配，会连带打到别的进程上去。
    process.kill(s.pid, 'SIGTERM');
    const e = await s.exited;
    for (const seq of RESTORE) assert.ok(s.wire().includes(seq), `缺 ${JSON.stringify(seq)}`);
    assert.equal(e.exitCode, 143, 'SIGTERM 之后该以 128+15 退出');
  } finally { s.kill(); }
});

test('终端太小就说人话，放大回来自动接着画', async () => {
  const s = await launch();
  try {
    await s.waitFor((x) => x.includes(TITLE), '标题');
    s.send('j');
    await s.waitFor((x) => blocks(x) > 200, '开打');

    const mark = s.wire().length;
    s.resize(30, 10);
    await s.waitFor((x) => x.slice(mark).includes('终端太小'), '太小的提示');
    const mark2 = s.wire().length;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(blocks(s.wire().slice(mark2)), 0, '太小的时候还在画 —— 会糊掉那行提示');

    const mark3 = s.wire().length;
    s.resize(COLS, ROWS);
    const w = await s.waitFor((x) => blocks(x.slice(mark3)) > 200, '放大后接着画');
    assert.deepEqual(cupRows(w.slice(mark3)).filter((r) => r > ROWS), [], '重排后往屏幕外画了');
  } finally { s.kill(); }
});
