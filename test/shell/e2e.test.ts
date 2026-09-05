import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../../src/shell/regions.ts';
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

/** 外壳启动时会算出来的布局。不写死数字 —— 常数改了这个测试要跟着改才对。 */
const L = (() => {
  const r = computeLayout({ cols: COLS, rows: ROWS });
  assert.equal(r.kind, 'split', `${COLS}×${ROWS} 应该能分屏`);
  return r.kind === 'split' ? r.layout : null!;
})();

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
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', ...extraEnv };
  if (via === 'node') env.MOYU_TAKEOVER_FLAG = '';
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

test('内层切备用屏后游戏照样合成在同一块屏幕上（M0 通过标准 ②，被实测改写过）', async () => {
  // 原来的标准是"内层切备用屏时游戏自动让屏、收屏后恢复"。实测把它推翻了：
  // 真实 claude 2.1.260 启动时发一次 ?1049h 就**整个会话待在备用屏上**（退出才 ?1049l），
  // 按原标准游戏会在启动一秒后永久消失，同屏合成等于从来没发生过。
  // 所以标准反了过来：备用屏上照样合成。备用屏只是另一个缓冲区，内层有多少行是
  // TIOCSWINSZ 给的，跟缓冲区无关；唯一要补的是 DECSTBM 每缓冲区各自一份，切过去要重设。
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 120));   // 先让游戏画几帧

    s.send('a');
    const w0 = await s.waitFor((x) => x.includes('ALT-SCREEN'), '内层进备用屏');
    const mark = w0.indexOf('ALT-SCREEN');

    // ① 新缓冲区上必须重设滚动区，否则内层一换行就能滚进游戏区
    await s.waitFor((x) => x.slice(mark).includes(`\x1b[1;${L.innerRows}r`), '备用屏上重设滚动区');
    // ② 游戏继续画 —— 这是这条标准被推翻之后剩下的那个要求
    const mark2 = s.wire().length;
    await s.waitFor((x) => cupRows(x.slice(mark2)).some((r) => r >= L.gameTop), '备用屏上继续作画');

    // ③ 夹取在备用屏上照样生效（原策略在这里是停止夹取的）
    const mark3 = s.wire().length;
    s.send('mg');
    const w = await s.waitFor((x) => x.slice(mark3).includes('OUT-OF-RANGE'), '备用屏上的越界输出');
    const tail = w.slice(mark3);
    assert.ok(!tail.includes('\x1b[1;999r'), '备用屏上那条 999 行的滚动区被原样透传了');
    assert.ok(!tail.includes('\x1b[999;7H'), '备用屏上那条 999 行的定位被原样透传了');

    // 退出备用屏走同一条路径：在回来的那个缓冲区上重设滚动区 + 继续画
    const mark4 = s.wire().length;
    s.send('A');
    await s.waitFor((x) => {
      const t = x.slice(mark4);
      return t.includes(`\x1b[1;${L.innerRows}r`) && cupRows(t).some((r) => r >= L.gameTop);
    }, '回主屏后重设滚动区并继续作画');
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

test('内层 push 了 kitty 键盘标志之后，^G 照样是热键（用户报的"^G 还是会进一个编辑界面"）', async () => {
  // 这条 bug 之所以能活到用户手上：假内层从不 push kitty 标志，所以整个 e2e 套件都是绿的，
  // 而真实 claude 启动就 push（`CSI > 5 u`）—— 之后 Ctrl+G 是 `ESC [ 103 ; 5 u`，
  // 只认字节 0x07 的路由器把整条序列原样转发下去，claude 收到真的 Ctrl+G，打开外部编辑器。
  const { hotkeyHint } = await import('../../src/shell/focus.ts');
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('k');
    await s.waitFor((w) => w.includes('KITTY-ON'), '内层 push kitty 标志');
    const mark = s.wire().length;

    s.send('\x1b[103;5ug');                        // kitty 编码的 ^G，然后命令 g
    await s.waitFor((x) => x.slice(mark).includes(hotkeyHint('game')), 'HUD 切到游戏焦点');

    // 'g' 是假内层的"往游戏区里定位"命令。它出现就说明命令字节漏进了内层 ——
    // 真实 claude 上漏进去的那一下就是打开外部编辑器。
    assert.ok(!s.wire().slice(mark).includes('OUT-OF-RANGE'), '命令字节漏进了内层');

    // 切回来也走同一条编码路径。等过 FOCUS_DEBOUNCE_MS —— 切焦点有 180ms 的防抖，
    // 紧跟着切回去会被它自己挡掉，那样这条断言测的就是防抖而不是编码了。
    await new Promise((r) => setTimeout(r, 220));
    const mark2 = s.wire().length;
    s.send('\x1b[103;5u\x1b[103;5u');              // 连按 = 切焦点
    await s.waitFor((x) => x.slice(mark2).includes(hotkeyHint('cli')), 'HUD 切回 CLI 焦点');
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

test('终端 resize 后两边一起重排（M0 通过标准 ③）', async () => {
  // 刻意**缩小**而不是放大。放大时旧的游戏区落在新的内层区域里，画错了也看不出来；
  // 缩小之后旧的 gameTop（第 31 行）直接超出了屏幕总高度，任何一条落在那儿的定位都是硬错误。
  const SMALL_ROWS = 24;
  const small = layoutAt(COLS, SMALL_ROWS)!;
  assert.ok(small.gameTop < L.gameTop, '这个测试要求新布局的 gameTop 比旧的小');
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await new Promise((r) => setTimeout(r, 150));   // 先按旧布局画几帧
    const mark = s.wire().length;

    s.resize(COLS, SMALL_ROWS);
    const w = await s.waitFor((x) => x.slice(mark).includes('WINCH '), '内层收到新尺寸');
    const tail = w.slice(mark);
    assert.ok(tail.includes(`WINCH ${COLS}x${small.innerRows}`),
      `内层看到的新尺寸不对，期望 ${COLS}x${small.innerRows}：${JSON.stringify(tail.match(/WINCH \d+x\d+/g))}`);
    assert.ok(tail.includes(`\x1b[1;${small.innerRows}r`), '没按新高度重设滚动区');

    // 重排稳定之后再看：必须在新的 gameTop 上作画，且一格都不能落到屏幕外。
    const mark2 = s.wire().length;
    const after = await s.waitFor(
      (x) => cupRows(x.slice(mark2)).some((r) => r >= small.gameTop), '游戏区在新位置作画');
    const off = cupRows(after.slice(mark2)).filter((r) => r > SMALL_ROWS);
    assert.deepEqual(off, [], `resize 后还在往屏幕外（第 ${SMALL_ROWS} 行之下）画：${off}`);
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
/** 一条完整的出帧 APC（首块带全部键，`q=2` 在里面）。 */
const APC_FRAME = /\x1b_Ga=T,f=24,s=(\d+),v=(\d+),o=z,i=19801,p=1,c=(\d+),r=(\d+),q=2,C=1(,m=1)?;/;

test('像素档：图落在游戏区顶行、格数夹住、备用屏后照样出帧、退出删图', async () => {
  const s = await launch('node', GFX_ENV);
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    const w0 = await s.waitFor((x) => APC_FRAME.test(x), '第一帧 APC');
    const m = APC_FRAME.exec(w0)!;
    // 键里的格数必须是我们分给游戏的那块矩形，像素数必须是它乘格像素 —— 差一位就溢进上半屏。
    assert.equal(Number(m[3]), L.fieldCols, `c= 不是画布列数（${L.fieldCols}）`);
    assert.equal(Number(m[4]), L.gameRows, `r= 不是游戏区行数（${L.gameRows}）`);
    assert.equal(Number(m[1]), L.fieldCols * 16, 's= 和 c=×格宽 对不上');
    assert.equal(Number(m[2]), L.gameRows * 34, 'v= 和 r=×格高 对不上');
    // 每条 APC 前面紧贴的那条 CUP 必须指向游戏区顶行：图落在光标处，落错了就画到内层身上。
    for (const at of [...w0.matchAll(/\x1b_Ga=T/g)].map((x) => x.index)) {
      const before = w0.slice(0, at);
      const cup = /\x1b\[(\d+);1H$/.exec(before);
      assert.ok(cup, `APC 前面不是一条 CUP：${JSON.stringify(before.slice(-24))}`);
      assert.equal(Number(cup[1]), L.gameTop, `图落在第 ${cup[1]} 行，游戏区从 ${L.gameTop} 行开始`);
    }

    // 备用屏之后还在发图（真实 claude 整个会话都待在备用屏上，这条挂了就等于游戏消失）
    s.send('a');
    await s.waitFor((x) => x.includes('ALT-SCREEN'), '内层进备用屏');
    const mark = s.wire().length;
    await s.waitFor((x) => APC_FRAME.test(x.slice(mark)), '备用屏上继续出帧');

    // ^G h 收起游戏区：必须删图，否则那张图会一直挂在用户的 CLI 上面
    const mark2 = s.wire().length;
    s.send('\x07h');
    await s.waitFor((x) => x.slice(mark2).includes('\x1b_Ga=d,d=I,i=19801,q=2\x1b\\'), '收起时删图');
    // 收起之后不该再有新的图上传
    const mark3 = s.wire().length;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!APC_FRAME.test(s.wire().slice(mark3)), '游戏区收起了还在往终端上传图');

    // 再按一次 ^G h 展开：终端里的图已经被删掉了，必须整幅重传，不能以为"没动就不用发"
    s.send('\x07h');
    await s.waitFor((x) => APC_FRAME.test(x.slice(mark3)), '重新展开后整幅重传');

    const mark4 = s.wire().length;
    s.send('\x07q');
    const e = await s.exited;
    assert.equal(e.exitCode, 0);
    assertDeletedOnBothBuffers(s.wire().slice(mark4), '^G q');
  } finally { s.kill(); }
});

/**
 * 退出路径必须在**两个屏幕缓冲区上各删一次图**。
 *
 * 这条断言是用户报的 bug 逼出来的：“退出以后渲染框还在” —— 图还挂在新提示符下面。
 * 发是发了，但只发了一遍：kitty 图的存储每个缓冲区各自一份（Ghostty 的 `kitty_images`
 * 是 `Screen` 的字段，`a=d` 只作用在活动屏幕上），而内层 claude 是启动一秒后才切进备用屏的
 * —— 在那之前的几十帧留在**主屏**上。删备用屏那张、`?1049l` 切回主屏，陈旧的那张就露出来。
 */
function assertDeletedOnBothBuffers(tail: string, how: string): void {
  const dels = [...tail.matchAll(/\x1b_Ga=d,d=I,i=19801,q=2\x1b\\/g)].map((m) => m.index);
  assert.equal(dels.length, 2,
    `${how} 退出时删图发了 ${dels.length} 次，应该是 2 次（备用屏 + 主屏各一次）`);
  const alt = tail.lastIndexOf('\x1b[?1049l');
  assert.ok(alt >= 0, `${how} 退出时没撤备用屏`);
  assert.ok(dels[0]! < alt, `${how}：第一次删图要在撤备用屏之前（那时活动屏幕是备用屏）`);
  assert.ok(dels[1]! > alt, `${how}：第二次删图要在撤备用屏之后 —— 主屏那张只有这一下删得掉`);
}

test('像素档：每条退出路径都在两个缓冲区上各删一次图', async () => {
  // 只有 `^G q` 那条路被上面那个测试覆盖过。内层自己退出和 SIGTERM 走的是别的入口，
  // 而用户真实退出多半是**内层自己退**（在 claude 里 /exit 或 Ctrl+D），正是没被测到的那条。
  for (const route of ['inner', 'sigterm'] as const) {
    const s = await launch('node', GFX_ENV);
    try {
      await s.waitFor((w) => w.includes('INNER-READY'), `内层启动（${route}）`);
      await s.waitFor((x) => APC_FRAME.test(x), `第一帧 APC（${route}）`);   // 确认真上传过图
      const mark = s.wire().length;
      if (route === 'inner') s.send('q'); else s.signal('SIGTERM');
      const e = await s.exited;
      assert.equal(e.exitCode, route === 'inner' ? 7 : 143, `${route} 的退出码`);
      assertDeletedOnBothBuffers(s.wire().slice(mark), route);
    } finally { s.kill(); }
  }
});

test('像素档：一帧的 APC 必须一次写完，不和光标还原的字节交错', async () => {
  const s = await launch('node', GFX_ENV);
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('p');
    await s.waitFor((w) => w.includes('INNER-HELLO'), '内层输出');
    // 等**三条完整**的 APC。只等 `a=T` 出现是不够的：那一刻最后一条可能才写了一半，
    // 于是下面找不到它的 ST —— 报出来的是"没有 ST 结尾"，而真相只是读到一半。
    await s.waitFor((x) => (x.match(/\x1b_Ga=T[\s\S]*?\x1b\\/g) ?? []).length >= 3, '攒够三帧');
    const w = s.wire();
    // APC 一旦开头，到 ST 之前不许出现任何别的转义序列 —— 交错了终端会把 CSI 当成图片数据。
    for (const at of [...w.matchAll(/\x1b_Ga=T/g)].map((x) => x.index)) {
      const st = w.indexOf('\x1b\\', at);
      if (st < 0) continue;                        // 末尾那条还在写，不是交错
      const inner = w.slice(at + 3, st);
      assert.ok(!inner.includes('\x1b['), `APC 里夹进了一条 CSI：${JSON.stringify(inner.slice(0, 40))}`);
    }
    // 每帧仍然以"光标回内层区域"收尾（像素档不该改变这条）
    const rows = cupRows(w);
    assert.ok(rows[rows.length - 1]! <= L.innerRows,
      `最后一条 CUP 落在第 ${rows[rows.length - 1]} 行，光标被留在游戏区了`);
  } finally { s.kill(); }
});

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

test('收起之后内层长一行，尺寸回复跟着变（收起 ≠ 让屏）', async () => {
  // `^G h` **不让整屏**，塌成 1 行：那一行写着怎么回来。所以内层拿到的是 ROWS-1，
  // 不是 ROWS。这条和下一条一起钉住"收起"的两半 —— 尺寸真的变了，且回头路真的在屏幕上。
  const s = await launch('node', GFX_ENV);
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    s.send('\x07h');
    await s.waitFor((w) => w.includes(`WINCH ${COLS}x${ROWS - 1}`), '内层收到长了一行的尺寸');
    const mark = s.wire().length;
    s.send('t');
    const w = await s.waitFor((x) => x.slice(mark).includes('SIZEREP '), '尺寸回复');
    const reps = [...w.slice(mark).matchAll(/SIZEREP ([\d;]+)/g)].map((m) => m[1]);
    assert.equal(reps[0], `8;${ROWS - 1};${COLS}`, '收起之后答案必须跟着变');
  } finally { s.kill(); }
});

test('半块档收起再展开：收起期间不画画布，展开后整条重画', async () => {
  // 像素档那条（上面「^G h 收起时删图」）盯的是图层；这条盯的是**文本层** ——
  // 半块档的画布是差分编码的，展开时必须 invalidate 整幅重发，不然它以为屏幕上还是
  // 收起前那一帧，于是一格都不发，游戏区从此一直空着（和让屏那个 bug 一模一样的症状）。
  const s = await launch();                          // 不给 MOYU_TIER：探不到就是半块档
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await s.waitFor((w) => cupRows(w).filter((r) => r >= L.gameTop).length >= 3, '攒够几帧画布');
    s.send('\x07h');
    await s.waitFor((w) => w.includes('^G h 展开'), '收起条');
    const mark = s.wire().length;
    await new Promise((r) => setTimeout(r, 150));
    // 收起之后只许写最后那一行（收起条），画布那几行一格都不许碰。
    const quiet = s.wire().slice(mark);
    assert.deepEqual(cupRows(quiet).filter((r) => r >= L.gameTop && r < ROWS), [],
      '收起了还在画画布那几行');
    s.send('\x07h');
    const back = await s.waitFor((w) => cupRows(w.slice(mark)).filter((r) => r >= L.gameTop).length >= 3,
      '展开后重新出帧');
    // 重画必须是**整幅**的：一帧里定位到画布每一行都至少一次（差分残留会让它只发一两行）。
    const tail = back.slice(mark);
    for (let r = L.gameTop; r < ROWS; r++) {
      assert.ok(cupRows(tail).includes(r), `展开后第 ${r} 行没重画（差分状态没清）`);
    }
  } finally { s.kill(); }
});

test('游戏区变矮时从**旧**的顶边开始擦（让出去的那几行不留残迹）', async () => {
  // 2 行 → 1 行：第 gameTop 行现在归内层了，但上面还留着上一帧的画布。内层是 TUI 的话
  // SIGWINCH 会让它重画一遍盖掉，普通 shell 不会 —— 那几行就一直挂在那儿。
  const s = await launch();
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    await s.waitFor((w) => cupRows(w).filter((r) => r >= L.gameTop).length >= 3, '攒够几帧画布');
    const mark = s.wire().length;
    s.send('\x07h');
    const w = await s.waitFor((x) => x.slice(mark).includes('\x1b[J'), '收起时的擦除');
    assert.ok(w.slice(mark).includes(`\x1b[${L.gameTop};1H\x1b[J`),
      `擦除该从旧顶边第 ${L.gameTop} 行开始，实际字节：${JSON.stringify(w.slice(mark, mark + 120))}`);
  } finally { s.kill(); }
});

test('收起那一行必须写着怎么回来（用户报的"打不开了"就是这一条缺失）', async () => {
  // 原来 `^G h` 是让整屏：按键路径本身好的，再按一次真的会回来 —— 坏的是屏幕上再没有
  // 任何东西告诉你怎么回去，而记忆里那半个 `h` 按下去只会打进内层的输入框。
  // 所以这条断言的是**可见的回头路**，不是可用的按键；按键那半边由上面几条覆盖。
  const s = await launch('node', GFX_ENV);
  try {
    await s.waitFor((w) => w.includes('INNER-READY'), '内层启动');
    const mark = s.wire().length;
    s.send('\x07h');
    const w = await s.waitFor((x) => x.slice(mark).includes('^G h 展开'), '收起条上的回头路');
    // 而且它必须落在**最后一行**（就是刚让出来的那一行），不能盖在内层身上。
    const at = w.indexOf('^G h 展开', mark);
    const cup = [...w.slice(mark, at).matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
    assert.equal(cup[cup.length - 1], ROWS, `收起条画在第 ${cup[cup.length - 1]} 行，不是最后一行`);
  } finally { s.kill(); }
});
