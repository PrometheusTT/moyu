import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeLayout, MICRO_GAME_ROWS } from '../../src/shell/regions.ts';
import { loadPty } from '../../src/shell/pty.ts';

/**
 * PTY-in-PTY 黄金测试：把**外壳自己**跑在一个我们控制的 PTY 里，内层放一个听指挥的假 CLI，
 * 然后对外壳吐到"真实终端"上的字节做断言。
 *
 * 这是唯一能在**没有控制终端**的环境里验证 M0 通过标准的手段（CI 里、这个 session 里
 * `stty size` 都返回 no tty）。前面的 pipeline 测试验证的是组件拼起来对不对，这里验证的是
 * 真正那个进程跑起来对不对 —— 包括启动顺序、帧循环、退出路径这些组件测试碰不到的部分。
 */
const COLS = 100;
const ROWS = 40;
const STANDBY = 'moyu  Ctrl+] 开玩';

/** 外壳启动时会算出来的布局。不写死数字 —— 常数改了这个测试要跟着改才对。 */
const L = (() => {
  const r = computeLayout({ cols: COLS, rows: ROWS });
  assert.equal(r.kind, 'split', `${COLS}×${ROWS} 应该能分屏`);
  return r.kind === 'split' ? r.layout : null!;
})();

const PLAY = (() => {
  const r = computeLayout({ cols: COLS, rows: ROWS, manualGameRows: MICRO_GAME_ROWS });
  assert.equal(r.kind, 'split');
  return r.kind === 'split' ? r.layout : null!;
})();

test('PTY 启动环境清掉宿主终端状态并保留无关变量', () => {
  const inherited: NodeJS.ProcessEnv = {
    PATH: '/bin', HOME: '/home/test', LANG: 'zh_CN.UTF-8', CUSTOM: 'kept',
    MOYU_TIER: 'graphics', MOYU_FUTURE_FLAG: '1', MOYU_TAKEOVER_FLAG: '/tmp/leak',
    TMUX: '/tmp/tmux', STY: 'screen', SSH_CONNECTION: 'remote', SSH_CLIENT: 'remote', SSH_TTY: '/dev/ttys001',
    TERM_PROGRAM: 'kitty', COLORTERM: 'truecolor', KITTY_WINDOW_ID: '7',
    GHOSTTY_RESOURCES_DIR: '/ghostty', WEZTERM_PANE: '9', COLUMNS: '200', LINES: '60',
    NODE_OPTIONS: '--require ambient-hook',
  };
  const before = { ...inherited };
  const env = launchEnv('node', inherited);
  assert.deepEqual(inherited, before, '不能修改调用方传入的 env');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  assert.equal(env.CUSTOM, 'kept');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.MOYU_TIER, 'braille');
  assert.equal(env.MOYU_REDUCE_MOTION, '1');
  assert.equal(env.MOYU_TAKEOVER_FLAG, '');
  for (const key of ['MOYU_FUTURE_FLAG', 'TMUX', 'STY', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
    'TERM_PROGRAM', 'COLORTERM', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE',
    'COLUMNS', 'LINES', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
});

test('PTY 启动环境先清洗再应用显式覆盖，但 takeover 始终归 launcher 所有', () => {
  const inherited = { MOYU_TIER: 'half', SSH_CONNECTION: 'ambient', MOYU_TAKEOVER_FLAG: 'ambient' };
  const extra = { MOYU_TIER: 'graphics', SSH_CONNECTION: 'intentional', MOYU_TAKEOVER_FLAG: 'override' };
  assert.deepEqual(launchEnv('node', inherited, extra), {
    TERM: 'xterm-256color', MOYU_TIER: 'graphics', MOYU_REDUCE_MOTION: '1',
    SSH_CONNECTION: 'intentional', MOYU_TAKEOVER_FLAG: '',
  });
  assert.deepEqual(launchEnv('sh', inherited, extra), {
    TERM: 'xterm-256color', MOYU_TIER: 'graphics', MOYU_REDUCE_MOTION: '1', SSH_CONNECTION: 'intentional',
  });
});

type Session = {
  send: (s: string) => void;
  /** 到目前为止外壳写到"终端"上的全部字节。 */
  wire: () => string;
  waitFor: (pred: (s: string) => boolean, what: string, ms?: number) => Promise<string>;
  exited: Promise<{ exitCode: number }>;
  resize: (cols: number, rows: number) => void;
  signal: (sig: string) => void;
  pid: number;
  kill: () => void;
};

const AMBIENT_ENV = [
  'TMUX', 'STY', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TERM_PROGRAM', 'COLORTERM',
  'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'COLUMNS', 'LINES', 'NODE_OPTIONS',
] as const;

function launchEnv(
  via: 'node' | 'sh',
  inherited: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (key.startsWith('MOYU_')) delete env[key];
  for (const key of AMBIENT_ENV) delete env[key];
  Object.assign(env, {
    TERM: 'xterm-256color',
    MOYU_TIER: 'braille',
    MOYU_REDUCE_MOTION: '1',
  }, extra);
  if (via === 'node') env.MOYU_TAKEOVER_FLAG = '';
  else delete env.MOYU_TAKEOVER_FLAG;
  return env;
}

/**
 * `via: 'node'` 直接跑 main.ts；`via: 'sh'` 走 `bin/moyu`，用来测那层 sh 包装的 SIGKILL 兜底。
 * 走 sh 时必须让它自己管 MOYU_TAKEOVER_FLAG（清空会让兜底整个失效）。
 */
async function launch(via: 'node' | 'sh' = 'node', extraEnv: NodeJS.ProcessEnv = {}): Promise<Session> {
  const { spawn } = await loadPty();
  const root = new URL('../../', import.meta.url).pathname;
  const flags = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
  const inner = [process.execPath, ...flags, `${root}test/fixtures/inner.ts`];
  const [file, args] = via === 'sh'
    ? [`${root}bin/moyu`, ['--', ...inner]]
    : [process.execPath, [...flags, `${root}src/app/main.ts`, '--', ...inner]];
  const env = launchEnv(via, process.env, extraEnv);
  const p = spawn(file, args, {
    cols: COLS, rows: ROWS, cwd: root, encoding: null, env,
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
  p.onData((d: Uint8Array) => { for (const b of d) chunks.push(b); });
  const dec = new TextDecoder();
  const wire = (): string => dec.decode(Uint8Array.from(chunks));

  let exitInfo: { exitCode: number } | null = null;
  const exited = new Promise<{ exitCode: number }>((res) => {
    p.onExit((e) => { exitInfo = e; res(e); });
  });

  const waitFor = async (pred: (s: string) => boolean, what: string, ms = 4000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = wire();
      if (pred(s)) return s;
      if (exitInfo !== null) assert.fail(`等 ${what} 时外壳已退出（码 ${exitInfo.exitCode}）`);
      if (Date.now() > deadline) assert.fail(`超时等不到：${what}\n最后 400 字节：${JSON.stringify(s.slice(-400))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  return {
    send: (s) => { p.write(s); }, wire, waitFor, exited, pid: p.pid,
    resize: (c, r) => { p.resize(c, r); },
    signal: (sig) => { try { process.kill(p.pid, sig as NodeJS.Signals); } catch { /* 已退 */ } },
    kill: () => { p.kill('SIGKILL'); },
  };
}

/** 抽出所有 CUP（绝对定位）的行号，按出现顺序。 */
function cupRows(s: string): number[] {
  return [...s.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((m) => Number(m[1]));
}

function inlineGameAt(s: string, row: number): boolean {
  const expected = row - MICRO_GAME_ROWS;
  let at = -1;
  while ((at = s.indexOf('J 砍', at + 1)) >= 0) {
    const rows = cupRows(s.slice(0, at));
    if (rows.at(-1) === expected) return true;
  }
  return false;
}

function protectedSplit(s: string, innerRows: number): boolean {
  let region = -1;
  while ((region = s.indexOf(`\x1b[1;${innerRows}r`, region + 1)) >= 0) {
    if (s.indexOf('J 砍', region) >= 0) return true;
  }
  return false;
}

async function establishComposer(s: Session, command = 'G'): Promise<void> {
  const mark = s.wire().length;
  s.send(command);
  await s.waitFor((w) => w.slice(mark).includes('Ask Codex'), 'Codex 输入框初始签名');
  if (command === 'G') {
    const pending = s.wire().length;
    s.send('f');
    await s.waitFor((w) => w.slice(pending).includes('REFRESH-PENDING 1'), '输入框验证刷新已等待放行');
    const intermediate = s.wire().length;
    s.send('F');
    await s.waitFor((w) => w.slice(intermediate).includes('INTERMEDIATE-ONLY'), '验证期间的独立 PTY 输出');
    s.send('3');
  }
  await s.waitFor((w) => {
    const tail = w.slice(mark);
    return [...tail.matchAll(/Ask Codex/g)].length >= 2;
  }, 'Codex 输入框验证重绘');
}

test('a broken installed Cartridge cannot prevent the wrapped CLI from starting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-broken-cartridge-'));
  const game = path.join(home, 'games', 'broken');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'moyu.game.json'), JSON.stringify({
    id: 'broken', name: 'Broken', version: '1', apiVersion: 1, author: 'test', description: 'broken',
    entry: 'index.mjs', viewport: { width: 16, height: 8 }, palette: ['#000000', '#ffffff'], controls: [],
  }));
  fs.writeFileSync(path.join(game, 'index.mjs'), `export default { create() { throw new Error('factory exploded'); } };\n`);
  const s = await launch('node', { MOYU_HOME: home });
  try {
    await s.waitFor((w) => w.includes('INNER-READY') && w.includes(STANDBY), '坏 Cartridge 后内层仍启动');
    const mark = s.wire().length;
    s.send('p');
    await s.waitFor((w) => w.slice(mark).includes('INNER-HELLO'), '内层仍能响应');
    s.send('q');
    assert.equal((await s.exited).exitCode, 7);
  } finally { s.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('默认只占一行，Ctrl+] 一键展开并用 Esc 返回', async () => {
  const s = await launch();
  try {
    const start = await s.waitFor((w) => w.includes(STANDBY), '一行待机条');
    assert.ok(start.includes(`\x1b[1;${ROWS - 1}r`), '待机时应该只给底部留一行');

    const enter = s.wire().length;
    s.send('\x1d');
    const playing = await s.waitFor((w) => {
      const tail = w.slice(enter);
      return tail.includes(`\x1b[1;${PLAY.innerRows}r`) && cupRows(tail).some((row) => row >= PLAY.gameTop)
        && tail.includes('Esc 返回') && tail.includes('J 砍');
    }, '展开游戏机');
    assert.match(playing.slice(enter), /J 砍/, '进入时必须明确显示操作');
    const begin = s.wire().length;
    s.send('j');
    await s.waitFor(w => /[\u2580-\u259f\u2800-\u28ff]/.test(w.slice(begin)), '操作后显示游戏');

    const leave = s.wire().length;
    s.send('\x1b');
    await s.waitFor((w) => w.slice(leave).includes(STANDBY), 'Esc 返回待机');
    assert.ok(s.wire().slice(leave).includes(`\x1b[1;${ROWS - 1}r`), '返回后没有恢复一行待机');
  } finally { s.kill(); }
});

test('Codex 中游戏覆盖在输入框正上方两行，退出后立即归还画面', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '一行待机条');
    await establishComposer(s);

    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return /\x1b\[(?:10|11);\d+H/.test(tail) && tail.includes('J 砍') && tail.includes('Esc 返回');
    }, '输入框上方两行游戏')).slice(enter);
    assert.ok(!playing.includes(`\x1b[1;${PLAY.innerRows}r`), 'overlay 不应 resize Codex 或改成底部分屏');
    assert.ok(playing.includes(`\x1b[${ROWS};1H\x1b[2K`), '进入时应清掉最底部候场提示');

    const captured = s.wire().length;
    s.send('p');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(!s.wire().slice(captured).includes('INNER-HELLO'), '游戏焦点下普通按键漏进了 Codex 输入框');

    const action = s.wire().length;
    s.send('j');
    await s.waitFor((w) => /\x1b\[(?:10|11);\d+H/.test(w.slice(action)), '攻击动作下一帧可见');

    const leave = s.wire().length;
    s.send('\x1b');
    const restored = (await s.waitFor((w) => {
      const tail = w.slice(leave);
      return tail.includes(STANDBY) && tail.includes('SIGWINCH') && tail.includes('ORIGINAL-CONTEXT') && tail.includes('ORIGINAL-SEPARATOR');
    }, '退出后恢复候场并请求 Codex 重绘')).slice(leave);
    assert.ok(restored.includes('\x1b[10;1H\x1b[2K\x1b[11;1H\x1b[2K'), '退出时应清掉两行浮层');

    const returned = s.wire().length;
    s.send('p');
    await s.waitFor((w) => w.slice(returned).includes('INNER-HELLO'), '退出后键盘焦点归还 Codex');
  } finally { s.kill(); }
});

test('verification keeps its proposal across intermediate PTY chunks', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '一行待机条');
    await establishComposer(s, 'G');
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return inlineGameAt(tail, 12) || protectedSplit(tail, PLAY.innerRows);
    }, '跨 marker chunk 验证后的浮层')).slice(enter);
    assert.ok(inlineGameAt(playing, 12), 'SIGWINCH marker 不应清掉待验证的输入框 proposal');
  } finally { s.kill(); }
});

test('both Codex prompt glyphs confirm the composer before using inline overlay', async () => {
  for (const command of ['G', 'H']) {
    const s = await launch('node', { MOYU_OVERLAY: '1' });
    try {
      await s.waitFor((w) => w.includes(STANDBY), '一行待机条');
      await establishComposer(s, command);
      const enter = s.wire().length;
      s.send('\x1d');
      const playing = (await s.waitFor((w) => {
        const tail = w.slice(enter);
        return inlineGameAt(tail, 12) || protectedSplit(tail, PLAY.innerRows);
      }, '确认后的输入框浮层')).slice(enter);
      assert.ok(inlineGameAt(playing, 12), `${command}: 应在输入框正上方绘制`);
      assert.ok(!protectedSplit(playing, PLAY.innerRows), `${command}: 不应退回底部分屏`);
    } finally { s.kill(); }
  }
});

test('explicit refresh reacquires a composer that moved nearby', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    s.send('R');
    const enter = s.wire().length;
    s.send('\x1d');
    await s.waitFor((w) => inlineGameAt(w.slice(enter), 12), '首次输入框浮层');
    const leave = s.wire().length;
    s.send('\x1b');
    await s.waitFor((w) => w.slice(leave).includes('\x1b[14;1H› Ask Codex'), '移动后的 refresh 重绘');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reenter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => inlineGameAt(w.slice(reenter), 14),
      '移动后的输入框浮层')).slice(reenter);
    assert.ok(!inlineGameAt(playing, 12));
  } finally { s.kill(); }
});

test('split refresh prefers the later real composer over transcript glyphs', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    s.send('2');
    const enter = s.wire().length;
    s.send('\x1d');
    await s.waitFor((w) => inlineGameAt(w.slice(enter), 12), '首次输入框浮层');
    const leave = s.wire().length;
    s.send('\x1b');
    await s.waitFor((w) => {
      const tail = w.slice(leave);
      return tail.includes('› transcript before composer') && tail.includes('Ask Codex');
    }, 'split refresh 两个候选');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reenter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => inlineGameAt(w.slice(reenter), 12),
      '真实输入框候选获胜')).slice(reenter);
    assert.ok(!inlineGameAt(playing, 10), '较早的 transcript glyph 不得获胜');
  } finally { s.kill(); }
});

test('a silent refresh expires without discarding a still-valid row', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    s.send('0');
    const enter = s.wire().length;
    s.send('\x1d');
    await s.waitFor((w) => inlineGameAt(w.slice(enter), 12), '首次输入框浮层');
    const leave = s.wire().length;
    s.send('\x1b');
    await s.waitFor((w) => w.slice(leave).includes('SIGWINCH'), 'silent refresh 信号');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const reenter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(reenter);
      return inlineGameAt(tail, 12) || protectedSplit(tail, PLAY.innerRows);
    }, 'silent refresh 过期后重入')).slice(reenter);
    assert.ok(inlineGameAt(playing, 12));
  } finally { s.kill(); }
});

test('an exact static transcript cannot establish composer trust', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    const transcript = s.wire().length;
    s.send('V');
    await s.waitFor((w) => w.slice(transcript).includes('Ask Codex static transcript'), '静态精确签名');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return protectedSplit(tail, PLAY.innerRows) || inlineGameAt(tail, 12);
    }, '静态签名后的安全回退')).slice(enter);
    assert.ok(protectedSplit(playing, PLAY.innerRows), '静态 transcript 不得建立输入框信任');
    assert.ok(!inlineGameAt(playing, 12));
  } finally { s.kill(); }
});

test('a prompt glyph in ordinary transcript falls back to the protected bottom split', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '一行待机条');
    s.send('v');
    await s.waitFor((w) => w.includes('› ordinary transcript'), '普通 transcript');
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return tail.includes(`\x1b[1;${PLAY.innerRows}r`) && tail.includes('J 砍');
    }, '受保护的底部分屏')).slice(enter);
    assert.ok(!/\x1b\[(?:10|11);1H\x1b\[2K/.test(playing), '不能清掉 transcript 上方两行');
    const leave = s.wire().length;
    s.send('\x1b');
    const restored = await s.waitFor((w) => w.slice(leave).includes(STANDBY), '返回待机');
    assert.ok(restored.includes('› ordinary transcript'), '普通 transcript 必须保留');
  } finally { s.kill(); }
});

test('non-empty drafts reacquire after invalidation', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    const redraw = s.wire().length;
    s.send('Dn');
    await s.waitFor((w) => w.slice(redraw).includes('› draft text'), 'ED 后非空草稿重绘');
    await s.waitFor((w) => [...w.slice(redraw).matchAll(/› draft text/g)].length >= 2,
      '非空草稿验证重绘');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return inlineGameAt(tail, 12) || protectedSplit(tail, PLAY.innerRows);
    }, '非空草稿锚点重获')).slice(enter);
    assert.ok(inlineGameAt(playing, 12));
  } finally { s.kill(); }
});

test('same-write ED accepts only the post-boundary composer row', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    const repaint = s.wire().length;
    s.send('o');
    await s.waitFor((w) => w.slice(repaint).includes('ordered draft'), 'ED 后的新输入框');
    await s.waitFor((w) => [...w.slice(repaint).matchAll(/› ordered draft/g)].length >= 2,
      'ED 后输入框验证重绘');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return inlineGameAt(tail, 14) || protectedSplit(tail, PLAY.innerRows);
    }, 'ED 后输入框重获')).slice(enter);
    assert.ok(inlineGameAt(playing, 14), '必须使用 ED 后的输入框坐标');
    assert.ok(!inlineGameAt(playing, 8), 'ED 前 transcript 坐标不得存活');
  } finally { s.kill(); }
});

test('ED without redraw invalidates the composer anchor', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    const erase = s.wire().length;
    s.send('D');
    await s.waitFor((w) => w.slice(erase).includes('ED-WITHOUT-REDRAW'), '无重绘 ED');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => protectedSplit(w.slice(enter), PLAY.innerRows),
      '无锚点安全回退')).slice(enter);
    assert.ok(!inlineGameAt(playing, 12), 'ED 前锚点不得继续使用');
  } finally { s.kill(); }
});

test('a transcript glyph cannot satisfy an authorized repaint without a complete signature', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((wire) => wire.includes(STANDBY), '待机');
    await establishComposer(s);
    const repaint = s.wire().length;
    s.send('Dw');
    await s.waitFor((wire) => {
      const tail = wire.slice(repaint);
      return tail.includes('› ordinary repaint transcript') && tail.includes('SIGWINCH');
    }, '不完整候选的验证刷新');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal([...s.wire().slice(repaint).matchAll(/› ordinary repaint transcript/g)].length, 1,
      '静态 transcript 不应随验证刷新重画');
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((wire) => {
      const tail = wire.slice(enter);
      return protectedSplit(tail, PLAY.innerRows) || inlineGameAt(tail, 13);
    }, '不完整候选后的安全回退')).slice(enter);
    assert.ok(!inlineGameAt(playing, 13), '只有完整 prompt 签名才能提交重绘坐标');
  } finally { s.kill(); }
});

test('a split candidate cannot complete across an invalidation boundary', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    const stale = s.wire().length;
    s.send('z');
    await s.waitFor((w) => w.slice(stale).includes('Codex stale'), '跨 ED 的半截签名');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => protectedSplit(w.slice(enter), PLAY.innerRows),
      '陈旧半截签名后的安全回退')).slice(enter);
    assert.ok(!inlineGameAt(playing, 12));
  } finally { s.kill(); }
});

test('expanded collapse waits for an authorized composer repaint', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    s.send('4');
    const enter = s.wire().length;
    s.send('\x1d');
    await s.waitFor((w) => inlineGameAt(w.slice(enter), 12), '首次输入框浮层');
    let mark = s.wire().length;
    s.send('e');
    await s.waitFor((w) => w.slice(mark).includes('\x1b[1;34r'), '展开六行');
    s.send('\x00');
    await new Promise((resolve) => setTimeout(resolve, 80));
    mark = s.wire().length;
    s.send('e');
    await s.waitFor((w) => w.slice(mark).includes('SIGWINCH'), '折叠刷新信号');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!inlineGameAt(s.wire().slice(mark), 12), '未授权重绘前不应恢复浮层');
    const release = s.wire().length;
    s.send('\x00');
    await s.waitFor((w) => inlineGameAt(w.slice(release), 12), '授权重绘后恢复浮层');
  } finally { s.kill(); }
});

test('E expands to six protected rows, Tab selects a full board, and E returns inline', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1', MOYU_TIER: 'braille' });
  try {
    await s.waitFor(w => w.includes(STANDBY), '待机');
    await establishComposer(s);
    s.send('\x1d');
    await s.waitFor(w => w.includes('J 砍'), '首次帮助');
    let mark = s.wire().length;
    s.send('e');
    await s.waitFor(w => w.slice(mark).includes('\x1b[1;34r'), '六行展开');
    mark = s.wire().length;
    s.send('\t');
    await s.waitFor(w => w.slice(mark).includes('贪吃蛇') && w.slice(mark).includes('WASD'), '切换游戏帮助');
    mark = s.wire().length;
    s.send('d');
    await s.waitFor(w => /[\u2580-\u259f\u2800-\u28ff]/.test(w.slice(mark)), '完整棋盘');
    mark = s.wire().length;
    s.send('e');
    await s.waitFor(w => /\x1b\[(?:10|11);1H/.test(w.slice(mark))
      && w.slice(mark).includes('E 展开'), '恢复两行入口及输入框锚点');
    await new Promise((resolve) => setTimeout(resolve, 80));
    mark = s.wire().length;
    s.send('\x1b');
    await s.waitFor(w => w.slice(mark).includes(STANDBY), '退出后归还 CLI 焦点');
  } finally { s.kill(); }
});

test('alternate-screen transitions require post-boundary composer evidence', async () => {
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(s);
    const swap = s.wire().length;
    s.send('aA');
    await s.waitFor((w) => {
      const tail = w.slice(swap);
      return tail.includes('ALT-SCREEN') && tail.includes('\x1b[?1049l')
        && tail.lastIndexOf('Ask Codex') > tail.lastIndexOf('\x1b[?1049l');
    }, '换屏边界后的输入框重绘');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const enter = s.wire().length;
    s.send('\x1d');
    const playing = (await s.waitFor((w) => {
      const tail = w.slice(enter);
      return inlineGameAt(tail, 12) || protectedSplit(tail, PLAY.innerRows);
    }, '换屏后的输入框重获')).slice(enter);
    assert.ok(inlineGameAt(playing, 12));
  } finally { s.kill(); }

  const stale = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await stale.waitFor((w) => w.includes(STANDBY), '待机');
    await establishComposer(stale);
    const swap = stale.wire().length;
    stale.send('a');
    await stale.waitFor((w) => w.slice(swap).includes('ALT-SCREEN'), '只进入备用屏');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const enter = stale.wire().length;
    stale.send('\x1d');
    const playing = (await stale.waitFor((w) => protectedSplit(w.slice(enter), PLAY.innerRows),
      '无边界后证据的安全回退')).slice(enter);
    assert.ok(!inlineGameAt(playing, 12));
  } finally { stale.kill(); }
});

test('Codex 启动切入备用屏后会重建滚动区并重画待机条', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes(STANDBY), '主屏上的待机条');
    const mark = s.wire().length;
    s.send('a');
    const tail = (await s.waitFor((w) => {
      const next = w.slice(mark);
      return next.includes('ALT-SCREEN')
        && next.includes(`\x1b[1;${ROWS - 1}r`)
        && next.includes(STANDBY);
    }, '备用屏上的待机条')).slice(mark);
    assert.ok(tail.indexOf(`\x1b[1;${ROWS - 1}r`) > tail.indexOf('ALT-SCREEN'),
      '滚动区必须在切换到新缓冲区之后重建');
    assert.ok(tail.indexOf(STANDBY) > tail.indexOf('ALT-SCREEN'),
      '待机条必须在 Codex 的备用屏上重新绘制');
  } finally { s.kill(); }
});

test('Codex inline TUI 用 ED 0 清屏后会再次重画待机条', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes(STANDBY), '初始待机条');
    s.send('a');
    await s.waitFor((w) => w.includes('ALT-SCREEN') && w.lastIndexOf(STANDBY) > w.indexOf('ALT-SCREEN'),
      '备用屏待机条');
    const mark = s.wire().length;
    s.send('d');
    const tail = (await s.waitFor((w) => {
      const next = w.slice(mark);
      return next.includes('CODEX-INLINE-CLEAR') && next.includes(STANDBY);
    }, 'inline 清屏后的待机条')).slice(mark);
    assert.ok(tail.indexOf(STANDBY) > tail.indexOf('CODEX-INLINE-CLEAR'),
      'ED 0 擦除以后必须重新绘制待机条');
  } finally { s.kill(); }
});

test('a game-owned Kitty Escape release never reaches the wrapped CLI', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('\x1d');
    await s.waitFor((w) => w.includes(`\x1b[1;${PLAY.innerRows}r`), '进入游戏');
    const mark = s.wire().length;
    s.send('\x1b[27;1:1u\x1b[27;3:3u');
    await s.waitFor((w) => w.slice(mark).includes(STANDBY), 'Kitty Escape 返回待机');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(!s.wire().slice(mark).includes('OTHERSEQ'), 'Kitty Escape release leaked into the inner PTY');
    const check = s.wire().length;
    s.send('p');
    await s.waitFor((w) => w.slice(check).includes('INNER-HELLO'), '焦点已归还内层');
  } finally { s.kill(); }
});

test('Ctrl+G 在普通和 kitty 键盘协议下都完整交给内层', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    const mark = s.wire().length;
    s.send('\x1b[103;5u');
    await s.waitFor((w) => w.slice(mark).includes('OTHERSEQ "\\u001b[103;5u"'), 'kitty Ctrl+G 透传');

    s.send('\x1d');
    await s.waitFor((w) => w.includes(`\x1b[1;${PLAY.innerRows}r`), '进入游戏');
    const mark2 = s.wire().length;
    s.send('\x1b[103;5u');
    await s.waitFor((w) => w.slice(mark2).includes('OTHERSEQ "\\u001b[103;5u"'), '游戏中 Ctrl+G 仍透传');
  } finally { s.kill(); }
});


test('外壳启动就把内层锁在上半屏，并把尺寸如实告诉它（M0 通过标准的前提）', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    assert.ok(s.wire().includes(`\x1b[1;${L.innerRows}r`), `没发滚动区 \x1b[1;${L.innerRows}r`);

    s.send('s');
    const w = await s.waitFor((x) => x.includes('SIZE '), '内层自报尺寸');
    assert.ok(w.includes(`SIZE ${COLS}x${L.innerRows}`),
      `内层看到的尺寸不对，期望 ${COLS}x${L.innerRows}：${JSON.stringify(w.match(/SIZE \d+x\d+/)?.[0])}`);
  } finally { s.kill(); }
});

test('每帧画完游戏后光标回到内层区域内（M0 通过标准 ①）', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('p');
    await s.waitFor((w) => w.includes('INNER-HELLO'), '内层输出');
    // 等几帧过去，然后看最后一条 CUP —— 每帧的字节以 restoreSeq 收尾，它必须把光标
    // 放回内层区域。如果最后一条 CUP 落在游戏区，就是光标被留在游戏里了。
    await new Promise((r) => setTimeout(r, 200));
    const rows = cupRows(s.wire());
    assert.ok(rows.length > 0, '一条 CUP 都没有 —— 帧循环没跑起来');
    const last = rows[rows.length - 1]!;
    assert.ok(last <= L.innerRows, `最后一条 CUP 落在第 ${last} 行（游戏区从第 ${L.gameTop} 行开始）`);
  } finally { s.kill(); }
});

test('内层越界的定位和过大的滚动区都被夹回内层区域（M0 通过标准 ①的另一半）', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('mg');
    const w = await s.waitFor((x) => x.includes('OUT-OF-RANGE'), '内层越界输出');
    assert.ok(!w.includes('\x1b[1;999r'), '内层那条 999 行的滚动区被原样透传了');
    assert.ok(!w.includes('\x1b[999;7H'), '内层那条 999 行的定位被原样透传了');
    // 夹取后的值必须落在内层区域里，而且 OUT-OF-RANGE 这段文字前面那条 CUP 就是它。
    const before = w.slice(0, w.indexOf('OUT-OF-RANGE'));
    const rows = cupRows(before);
    assert.equal(rows[rows.length - 1], L.innerRows, `夹取后的行号应是 ${L.innerRows}`);
  } finally { s.kill(); }
});


test('^G q 退出时终端状态被还原干净（M0 通过标准 ④）', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 120));
    s.send('\x07q');                                // Ctrl+G q
    await s.exited;
    const w = s.wire();
    for (const seq of ['\x1b[?2026l', '\x1b[?1049l', '\x1b[r', '\x1b[?7h', '\x1b[0m', '\x1b[?25h']) {
      assert.ok(w.includes(seq), `还原序列里缺 ${JSON.stringify(seq)}`);
    }
    // 顺序上的硬要求：撤备用屏必须在最后那条定位之前（?1049l 自带一次光标恢复，
    // 放在定位之后会把我们刚放好的光标又搬走）。
    const alt = w.lastIndexOf('\x1b[?1049l');
    const home = w.lastIndexOf('\x1b[J');
    assert.ok(alt < home, '?1049l 必须在最后的定位 + 擦除之前');
  } finally { s.kill(); }
});

test('两个外壳各用自己的事件文件，不会互相触发', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-sessions-'));
  const env = { HOME: home, MOYU_EVENTS: '' };
  const a = await launch('node', env);
  const b = await launch('node', env);
  try {
    await Promise.all([
      a.waitFor((w) => w.includes('INNER-READY'), '第一个内层启动'),
      b.waitFor((w) => w.includes('INNER-READY'), '第二个内层启动'),
    ]);
    a.send('e');
    b.send('e');
    const [aw, bw] = await Promise.all([
      a.waitFor((w) => w.includes('EVENTS '), '第一个事件路径'),
      b.waitFor((w) => w.includes('EVENTS '), '第二个事件路径'),
    ]);
    const ap = /EVENTS ([^\r\n]+)/.exec(aw)?.[1];
    const bp = /EVENTS ([^\r\n]+)/.exec(bw)?.[1];
    assert.ok(ap?.includes('/.moyu/sessions/'), ap);
    assert.ok(bp?.includes('/.moyu/sessions/'), bp);
    assert.notEqual(ap, bp, '两个并行会话共用了事件文件');
  } finally {
    a.send('\x07q');
    b.send('\x07q');
    await Promise.all([a.exited, b.exited]);
  }
});

test('退出会杀掉忽略 SIGHUP 的内层孙进程', async () => {
  const s = await launch();
  let childPid = 0;
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('x');
    const w = await s.waitFor((x) => /HUP-CHILD \d+/.test(x), '忽略 HUP 的孙进程');
    childPid = Number(/HUP-CHILD (\d+)/.exec(w)?.[1]);
    assert.ok(childPid > 1);
    s.send('\x07q');
    await s.exited;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try { process.kill(childPid, 0); } catch { childPid = 0; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(childPid, 0, '忽略 SIGHUP 的孙进程还活着');
  } finally {
    if (childPid > 1) { try { process.kill(childPid, 'SIGKILL'); } catch { /* 已退 */ } }
    s.kill();
  }
});

test('内层自己退出时外壳跟着退出并原样传出退出码', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('q');
    const e = await s.exited;
    assert.equal(e.exitCode, 7, '内层的退出码 7 没传出来');
    assert.ok(s.wire().includes('\x1b[?25h'), '退出时没恢复光标可见性');
  } finally { s.kill(); }
});


test('内层没弹干净的 kitty 标志由退出路径替它弹掉', async () => {
  // 内层被 SIGKILL 就不会自己弹。留在那儿的后果全落在用户的 shell 上：
  // 方向键变乱码、Ctrl+C 不再是 SIGINT。
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('k');
    await s.waitFor((w) => w.includes('KITTY-ON'), '内层 push kitty 标志');
    const mark = s.wire().length;
    s.send('\x07q');                               // 裸字节的 ^G q（标志只影响 ctrl+key 的编码）
    await s.exited;
    assert.ok(s.wire().slice(mark).includes('\x1b[<u'), '还原序列里没弹 kitty 标志');
  } finally { s.kill(); }
});

/** 某个尺寸下外壳该算出来的布局。分不了屏就返回 null。 */
function layoutAt(cols: number, rows: number): { innerRows: number; gameTop: number } | null {
  const r = computeLayout({ cols, rows });
  return r.kind === 'split' ? { innerRows: r.layout.innerRows, gameTop: r.layout.gameTop } : null;
}


test('too-small yield never paints stale inline rows and reacquires the bottom composer on resume', async () => {
  const TINY = 10;
  const s = await launch('node', { MOYU_OVERLAY: '1' });
  try {
    await s.waitFor((w) => w.includes(STANDBY), '待机');
    s.send('B');
    await establishComposer(s);
    const initialRow = L.innerRows - 2;
    const enter = s.wire().length;
    s.send('\x1d');
    await s.waitFor((w) => inlineGameAt(w.slice(enter), initialRow), '底部输入框上方的浮层');

    const shrink = s.wire().length;
    s.resize(COLS, TINY);
    await s.waitFor((w) => {
      const tail = w.slice(shrink);
      return tail.includes(`WINCH ${COLS}x${TINY}`) && tail.includes(`\x1b[${TINY - 2};1H`)
        && cupRows(tail).at(-1) === TINY - 2;
    }, '让屏后内层拿到整屏并重绘输入框');
    const yielded = s.wire().length;
    await new Promise((resolve) => setTimeout(resolve, 160));
    const quiet = s.wire().slice(yielded);
    assert.deepEqual(cupRows(quiet).filter((row) => row > TINY), [], '让屏期间还按旧布局画到屏幕外');
    assert.ok(!quiet.includes('J 砍'), '让屏期间不应重启输入框浮层');

    const resume = s.wire().length;
    s.resize(COLS, ROWS);
    await s.waitFor((w) => {
      const tail = w.slice(resume);
      return tail.includes(`\x1b[1;${L.innerRows}r`) && tail.includes(`WINCH ${COLS}x${L.innerRows}`);
    }, '恢复一行候场分屏');
    const repaint = s.wire().length;
    s.send('\x00');
    const resumed = (await s.waitFor((w) => inlineGameAt(w.slice(repaint), initialRow),
      '恢复后重获底部输入框并继续浮层')).slice(repaint);
    assert.ok(!protectedSplit(resumed, L.innerRows), '恢复后不应退回底部分屏');
  } finally { s.kill(); }
});

test('终端小到放不下就收起游戏区，放大后自动回来', async () => {
  // 游戏条只要 1 行，所以"放不下"的门槛低到只剩 MIN_INNER_ROWS —— 10 行。
  const TINY = 10;
  assert.equal(layoutAt(COLS, TINY), null, `${TINY} 行本该小到分不了屏 —— 常数改了这个测试要跟着改`);
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 150));

    const mark = s.wire().length;
    s.resize(COLS, TINY);
    const w = await s.waitFor((x) => x.slice(mark).includes(`WINCH ${COLS}x${TINY}`), '内层拿到整屏');
    assert.ok(w.slice(mark).includes('\x1b[r'), '收起游戏区时没撤掉滚动区');

    // 从"内层已经拿到整屏"这一刻之后再看，避免把 resize 生效前那几帧算进来。
    const mark2 = s.wire().length;
    await new Promise((r) => setTimeout(r, 200));
    const quiet = s.wire().slice(mark2);
    assert.deepEqual(cupRows(quiet).filter((r) => r > TINY), [], '收起之后还在往屏幕外画');

    const back = layoutAt(COLS, ROWS)!;
    const mark3 = s.wire().length;
    s.resize(COLS, ROWS);
    await s.waitFor((x) => {
      const t = x.slice(mark3);
      return t.includes(`\x1b[1;${back.innerRows}r`) && cupRows(t).some((r) => r >= back.gameTop);
    }, '放大后重新分屏并恢复作画');
  } finally { s.kill(); }
});

/** 还原序列里必须出现的那几条。顺序另外断言，这里只查"发了没"。 */
const RESTORE = ['\x1b[?2026l', '\x1b[?1049l', '\x1b[r', '\x1b[?7h', '\x1b[0m', '\x1b[?25h'] as const;

test('SIGTERM 也走同一条还原路径，退出码是 143', async () => {
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 150));
    s.signal('SIGTERM');
    const e = await s.exited;
    const w = s.wire();
    for (const seq of RESTORE) assert.ok(w.includes(seq), `还原序列里缺 ${JSON.stringify(seq)}`);
    assert.equal(e.exitCode, 143, 'SIGTERM 之后该以 128+15 退出，好让父进程看到真实死因');
  } finally { s.kill(); }
});

test('node 被 SIGKILL 时 bin/moyu 的 trap 补上还原（唯一抓不到的死法）', async () => {
  const s = await launch('sh');
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 200));
    const mark = s.wire().length;

    // sh 不 exec，所以 s.pid 是那层 sh；要杀的是它下面那个 node。
    const { execFileSync } = await import('node:child_process');
    const kids = execFileSync('pgrep', ['-P', String(s.pid)], { encoding: 'utf8' })
      .trim().split('\n').filter((x) => x !== '');
    assert.ok(kids.length > 0, `pgrep 没找到 sh(${s.pid}) 的子进程 —— bin/moyu 是不是用了 exec？`);
    for (const k of kids) process.kill(Number(k), 'SIGKILL');

    await s.exited;
    const tail = s.wire().slice(mark);
    for (const seq of RESTORE) {
      assert.ok(tail.includes(seq), `SIGKILL 之后 sh 的兜底还原里缺 ${JSON.stringify(seq)}`);
    }
  } finally { s.kill(); }
});

test('正常退出时 bin/moyu 不重复还原（?1049l 会搬走用户 shell 的光标）', async () => {
  const s = await launch('sh');
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 150));
    s.send('\x07q');
    await s.exited;
    // node 自己还原过一次，接管标记已删，所以 sh 的 trap 不该再发一遍。
    const n = [...s.wire().matchAll(/\x1b\[\?1049l/g)].length;
    assert.equal(n, 1, `?1049l 发了 ${n} 次 —— 重复还原会把用户 shell 的光标搬到陈旧位置`);
  } finally { s.kill(); }
});

/**
 * 像素档在**真外壳里**跑一遍（R1 的验证项 4，用假内层做，真 claude 那一遍只能你在终端里跑）。
 *
 * 这条测试的价值全在"只有跑起来才会暴露"的那几件事上：APC 有没有和光标还原的字节交错、
 * 备用屏之后还在不在发图、收起游戏区和退出时有没有把图删掉。组件测试碰不到这些 ——
 * `graphics.test.ts` 只知道 `encode()` 吐出来的字节对不对，不知道它们最后被谁包着写出去。
 */
const GFX_ENV = { MOYU_TIER: 'graphics', MOYU_CELL: '16x34' };





test('内层问屏幕尺寸时外壳自己回答，答的是上半屏而不是整窗（P9）', async () => {
  // 让终端回答会错两次：内层以为自己有 40 行（排版按整屏算），而它按整窗高度算出来的
  // 一张 kitty 图会直接盖住游戏区。更糟的是那条回复是**终端**发的，会落在我们的 stdin 上，
  // 被输入路由器当普通按键转发进内层的输入框 —— 用户看到的是开局一串乱码。
  const s = await launch('node', GFX_ENV);
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    const mark = s.wire().length;
    s.send('t');
    const w = await s.waitFor((x) => (x.slice(mark).match(/SIZEREP /g) ?? []).length >= 3, '三条尺寸回复');
    const reps = [...w.slice(mark).matchAll(/SIZEREP ([\d;]+)/g)].map((m) => m[1]);
    assert.deepEqual(reps, [
      `8;${L.innerRows};${COLS}`,                    // CSI 18 t：文本区字符数
      '6;34;16',                                     // CSI 16 t：格像素（= MOYU_CELL）
      `4;${L.innerRows * 34};${COLS * 16}`,          // CSI 14 t：文本区像素
    ]);
    // 另一半：查询本身一个字节都不能漏到真实终端上（漏了就是终端抢答）。
    assert.ok(!w.slice(mark).includes('\x1b[18t'), '`CSI 18 t` 漏给终端了');
    assert.ok(!w.slice(mark).includes('\x1b[16t'), '`CSI 16 t` 漏给终端了');
    assert.ok(!w.slice(mark).includes('\x1b[14t'), '`CSI 14 t` 漏给终端了');
  } finally { s.kill(); }
});
