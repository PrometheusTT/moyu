import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CELL, parseProbe, probeCaps, probeSeq } from '../../src/render/caps.ts';

/**
 * 探测这一段的正确性有两半，两半都在这里锁住：
 *
 * 1. **认出我们的回复** —— 认不出就退半块档，40 像素的火柴人白做了。
 * 2. **把不是我们的字节原样还回去** —— 用户在启动那一瞬间抢跑打的字。少还一个字节是丢输入，
 *    多还一个字节（把终端的回复也还回去）就是把 `\x1b_Gi=31;OK\x1b\\` 转发进 claude 的输入框。
 *
 * 第 2 条是这个文件的重点：leftover 断言全部按**逐字节相等**写，不用"包含"。
 */

const OK = '\x1b_Gi=31;OK\x1b\\';
const CELL = '\x1b[6;34;16t';
const DA = '\x1b[?62;22c';

test('三条查询的形状：a=q 不带 q=2，DA 放最后当哨兵', () => {
  const s = probeSeq();
  const apc = s.slice(0, s.indexOf('\x1b\\') + 2);
  // 带了 q=2 就把回复也抑制掉了 —— 等于自己把眼睛蒙上，永远退半块档。
  assert.ok(!apc.includes('q=2'), `探测的 APC 带了 q=2：${JSON.stringify(apc)}`);
  assert.ok(apc.includes('a=q'), '探测必须用 a=q（只问，不放置）');
  assert.ok(s.endsWith('\x1b[c'), 'DA 必须是最后一条 —— 它的回复是"可以收工了"的哨兵');
  assert.ok(s.includes('\x1b[16t'), '要问格像素');
});

test('认出三条回复，且一个字节都不留给输入路由器', () => {
  const r = parseProbe(OK + CELL + DA, 80, 24);
  assert.equal(r.graphics, true);
  assert.equal(r.cellW, 16);
  assert.equal(r.cellH, 34);
  assert.equal(r.done, true);
  assert.equal(r.leftover, '', '把终端的回复还给了输入路由器 —— 用户会在 claude 的输入框里看到乱码');
});

test('用户抢跑打的字按原顺序、逐字节还回去', () => {
  // 回复和按键任意交错：终端不保证它们不夹在一起。
  const typed = 'hi\x1b[A\x7f中';
  const r = parseProbe('hi' + OK + '\x1b[A' + CELL + '\x7f' + DA + '中', 80, 24);
  assert.equal(r.leftover, typed, 'leftover 必须是纯用户字节，顺序不变');
  assert.equal(r.graphics, true);
  assert.equal(r.cellW, 16);
});

test('BEL 收尾的 APC 变体也认，也吞掉', () => {
  const r = parseProbe('\x1b_Gi=31;OK\x07' + DA, 80, 24);
  assert.equal(r.graphics, true);
  assert.equal(r.leftover, '');
});

test('别人的图 id / 不是 OK 的回复：不当支持，但照样吞掉', () => {
  const other = parseProbe('\x1b_Gi=99;OK\x1b\\' + DA, 80, 24);
  assert.equal(other.graphics, false, 'i= 对不上就不能当我们的回复');
  assert.equal(other.leftover, '', 'APC 回复无论属于谁都不该转发进内层');
  const no = parseProbe('\x1b_Gi=31;ENOTSUPPORTED\x1b\\' + DA, 80, 24);
  assert.equal(no.graphics, false);
  assert.equal(no.leftover, '');
});

test('半截序列不吃掉后面的输入，也不算收工', () => {
  const half = parseProbe('\x1b_Gi=31;O', 80, 24);
  assert.equal(half.done, false, '没等到哨兵却说收工了 —— 会白白退半块档');
  assert.equal(half.leftover, '\x1b_Gi=31;O', '半截的字节要还回去，不能凭空吞掉');
  const csi = parseProbe('\x1b[6;34', 80, 24);
  assert.equal(csi.leftover, '\x1b[6;34');
  assert.equal(csi.cellW, undefined);
});

test('16t 问不到时用 14t 除格数兜底，问到了就不许被覆盖', () => {
  const only14 = parseProbe(OK + '\x1b[4;816;1280t' + DA, 80, 24);
  assert.equal(only14.cellW, 16, '1280/80');
  assert.equal(only14.cellH, 34, '816/24');
  // 两条都回：无论谁先到，都必须以 16t 的精确值为准（14t 含窗口边距，偏小）。
  for (const s of [OK + CELL + '\x1b[4;800;1200t' + DA, OK + '\x1b[4;800;1200t' + CELL + DA]) {
    const both = parseProbe(s, 80, 24);
    assert.equal(both.cellW, 16, `14t 覆盖了 16t 的值：${JSON.stringify(s)}`);
    assert.equal(both.cellH, 34);
  }
});

/**
 * 假终端：`write` 进来之后按 `reply` 回一段字节，像真终端那样异步到达。
 * `delayMs` 模拟链路延迟（SSH 上一个来回是真会花掉几百毫秒的）。
 */
function fakeIO(reply: string | null, env: NodeJS.ProcessEnv = {}, delayMs = 0) {
  const listeners: Array<(b: Buffer) => void> = [];
  const wrote: string[] = [];
  const io = {
    stdin: {
      on: (_ev: 'data', f: (b: Buffer) => void) => listeners.push(f),
      off: (_ev: 'data', f: (b: Buffer) => void) => {
        const at = listeners.indexOf(f);
        if (at >= 0) listeners.splice(at, 1);
      },
    },
    write: (s: string) => {
      wrote.push(s);
      if (reply === null) return;
      // 分两个 chunk 送：真终端的回复本来就会被 read 切开。
      const cut = Math.max(1, Math.floor(reply.length / 2));
      const soon = (f: () => void): unknown => (delayMs > 0 ? setTimeout(f, delayMs) : setImmediate(f));
      soon(() => {
        for (const part of [reply.slice(0, cut), reply.slice(cut)]) {
          for (const f of [...listeners]) f(Buffer.from(part, 'latin1'));
        }
      });
    },
    env,
    cols: 80,
    rows: 24,
    timeoutMs: 40,
    tty: true,
  };
  return { io, wrote, listeners };
}

test('探到了：像素档 + 精确格像素 + leftover 交还宿主', async () => {
  const { io, listeners } = fakeIO('x' + OK + CELL + DA);
  const c = await probeCaps(io);
  assert.equal(c.tier, 'graphics');
  assert.equal(c.cellW, 16);
  assert.equal(c.cellH, 34);
  assert.equal(c.fps, 30);
  assert.equal(Buffer.from(c.leftover).toString('latin1'), 'x', '用户抢跑打的字要交还');
  assert.equal(listeners.length, 0, '临时 listener 没摘掉 —— 之后每个按键都会被它读两遍');
});

test('只回哨兵：给 OK 一段宽限期，过了才退半块档', async () => {
  // 哨兵（DA）到了但 OK 没到 ≠ 不支持 —— 图形命令在有些终端里不走 CSI 那条同步路径，
  // 回复可能排在 DA 后面。所以这里不立刻定论，等 graceMs 再说。
  const { io } = fakeIO(DA);                     // 只回哨兵，不回 OK
  const t0 = performance.now();
  const c = await probeCaps({ ...io, graceMs: 12 });
  assert.equal(c.tier, 'half');
  assert.equal(c.cellW, DEFAULT_CELL.w, '问不到格像素就用默认值（往大猜：糊比块状好，见 DEFAULT_CELL）');
  const dt = performance.now() - t0;
  assert.ok(dt >= 10, `宽限期没等（${dt.toFixed(1)}ms）—— 回复晚一拍就把像素档判死了`);
  assert.ok(dt < 40, `等过了头（${dt.toFixed(1)}ms）—— 宽限期该被 graceMs 夹住，不是等满超时`);
});

test('OK 和哨兵都到了：立刻收工，不吃宽限期', async () => {
  const { io } = fakeIO(OK + CELL + DA);
  const t0 = performance.now();
  const c = await probeCaps({ ...io, graceMs: 500, timeoutMs: 500 });
  assert.equal(c.tier, 'graphics');
  const dt = performance.now() - t0;
  assert.ok(dt < 60, `拿到 OK 还在等（${dt.toFixed(1)}ms）—— 启动路径上这段是白卡的`);
});

test('探测没回话，但 env 认得出终端：照样走像素档', async () => {
  // 半块档在出货尺寸（2 行）上是 3 像素高的火柴人，等于不可用。所以对自报身份就足以
  // 确定支持 kitty graphics 的终端，一次丢包不该换来这个结果。
  for (const env of [
    { TERM: 'xterm-ghostty' },
    { TERM: 'xterm-kitty' },
    { TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm' },
    { TERM: 'xterm-256color', KITTY_WINDOW_ID: '1' },
    { TERM: 'xterm-256color', GHOSTTY_RESOURCES_DIR: '/x' },
  ]) {
    const { io } = fakeIO(DA, env);
    const c = await probeCaps({ ...io, graceMs: 5 });
    assert.equal(c.tier, 'graphics', `${JSON.stringify(env)} 该按 env 认定为像素档`);
    assert.equal(c.cellW, DEFAULT_CELL.w, '格像素问不到就用默认值');
    assert.match(c.why, /env 认定/);
  }
  // 认不出来的终端不许瞎猜：猜错就是把 base64 当文本打在用户屏幕上。
  const { io } = fakeIO(DA, { TERM: 'xterm-256color' });
  assert.equal((await probeCaps({ ...io, graceMs: 5 })).tier, 'half');
});

test('被 tmux / screen 包着时，env 认得出也不许走像素档', async () => {
  for (const env of [
    { TERM: 'xterm-ghostty', TMUX: '/tmp/x,1,0' },
    { TERM: 'xterm-ghostty', STY: '1234.pts-0.host' },
  ]) {
    const { io, wrote } = fakeIO(OK + CELL + DA, env);
    const c = await probeCaps(io);
    assert.equal(c.tier, 'half', `${JSON.stringify(env)} 下不该走像素档`);
    assert.equal(wrote.length, 0, '连探测字节都不该发（APC 会被复用器吞掉或打成乱码）');
  }
});

test('一个字节都不回：超时兜住，退半块档', async () => {
  const { io } = fakeIO(null);
  // 探测的超时定时器是**刻意 unref 的**（在飞的探测绝不该拖住进程退出）。真实进程里
  // raw 模式的 stdin 自己就是个 ref 过的句柄，事件循环不会空；测试里没有，所以自己压一个。
  const keep = setTimeout(() => { /* 压住事件循环 */ }, 1000);
  const c = await probeCaps(io);
  clearTimeout(keep);
  assert.equal(c.tier, 'half');
  assert.match(c.why, /没回/);
});

test('tmux 下不发探测字节，直接退半块档', async () => {
  const { io, wrote } = fakeIO(OK + CELL + DA, { TMUX: '/tmp/tmux-501/default,1,0' });
  const c = await probeCaps(io);
  assert.equal(c.tier, 'half');
  assert.equal(wrote.length, 0, 'tmux 里发了 APC 探测 —— 它不透传，字节会原样打在用户屏幕上');
  assert.match(c.why, /tmux/);
});

test('不是 TTY 就别问（管道里回复永远不会来）', async () => {
  const { io, wrote } = fakeIO(OK + DA);
  const c = await probeCaps({ ...io, tty: false });
  assert.equal(c.tier, 'half');
  assert.equal(wrote.length, 0);
});

test('SSH 下保留像素档但降到 15fps', async () => {
  const { io } = fakeIO(OK + CELL + DA, { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' });
  const c = await probeCaps(io);
  assert.equal(c.tier, 'graphics');
  assert.equal(c.fps, 15);
});

test('MOYU_TIER / MOYU_CELL 强制，且不发探测字节', async () => {
  const forced = fakeIO(OK + CELL + DA, { MOYU_TIER: 'graphics', MOYU_CELL: '16×34' });
  const g = await probeCaps(forced.io);
  assert.equal(g.tier, 'graphics');
  assert.equal(g.cellW, 16, '全角 × 也要认（复制粘贴容易带进来）');
  assert.equal(g.cellH, 34);
  assert.equal(forced.wrote.length, 0, '强制指定了还去问，回复就没人吞了');
  const h = await probeCaps(fakeIO(OK + CELL + DA, { MOYU_TIER: 'half', MOYU_CELL: '8x17' }).io);
  assert.equal(h.tier, 'half');
  // 坏值当没写，不能因为一个 typo 就按 0×0 算出一张空图。
  const bad = await probeCaps(fakeIO(OK + CELL + DA, { MOYU_TIER: 'graphics', MOYU_CELL: '0x0' }).io);
  assert.equal(bad.cellW, DEFAULT_CELL.w);
});

test('离谱的格像素当没问到 —— 宁可糊一档，也不要算出一张溢屏的图', async () => {
  const { io } = fakeIO(OK + '\x1b[6;1;1t' + DA);
  const c = await probeCaps(io);
  assert.equal(c.tier, 'graphics', '格像素不合理不影响"支不支持"的判断');
  assert.equal(c.cellW, DEFAULT_CELL.w);
  assert.equal(c.cellH, DEFAULT_CELL.h);
  assert.match(c.why, /默认值/);
});

/* ── 探测的结局：`tier` 是结论，`probe` 是"为什么"，两者不能混 ─────────────── */

test('哨兵回来了但没有 OK = 真的不支持；一个字都没回 = 没问出来', async () => {
  // 用户报"装完还是垃圾像素版"，`doctor --caps` 打的是"终端没回 kitty graphics 的 OK" ——
  // 这句话把两件事说成了一件，而它们的下一步完全相反：一个是"别折腾了"，另一个是
  // "你知道本地终端支持就直接 MOYU_TIER=graphics"。所以结局要分开报。
  const da = await probeCaps({ ...fakeIO(DA).io, graceMs: 5 });
  assert.equal(da.probe, 'no-graphics');
  assert.match(da.why, /真的不支持/);

  const silent = await probeCaps(fakeIO(null).io);
  assert.equal(silent.probe, 'silent');
  assert.match(silent.why, /没问出来/);
  assert.match(silent.why, /40ms/, '把等了多久打出来 —— 判定是不是超时太短要靠这个数');

  const ok = await probeCaps(fakeIO(OK + CELL + DA).io);
  assert.equal(ok.probe, 'ok');

  // 压根没问的那几条（强制档位 / 不是 TTY / mux）都是 skipped —— 它们的 half 不是探测的结论。
  for (const io2 of [
    { ...fakeIO(null, { MOYU_TIER: 'half' }).io },
    { ...fakeIO(null).io, tty: false },
    { ...fakeIO(null, { TMUX: '/tmp/x,1,0' }).io },
  ]) assert.equal((await probeCaps(io2)).probe, 'skipped');
});

test('SSH 下预算放宽：晚 500ms 的回复接得住，本地那档 400ms 接不住', async () => {
  // 预算基本免费（哨兵一到就收工，等满只发生在终端一个字都不回时），而 SSH 上一个来回
  // 就可能吃掉本地那 400ms 的一大半 —— 400 判出来的"不支持"可能只是链路慢。
  // `timeoutMs: undefined` 是这条的关键：要走真实默认值，不是 fakeIO 的 40ms。
  const late = (env: NodeJS.ProcessEnv): Parameters<typeof probeCaps>[0] => {
    // 把键**删掉**而不是设成 undefined：exactOptionalPropertyTypes 下后者不合法，
    // 而且语义也不一样 —— 我们要的是"没给这个参数"。
    const { timeoutMs, ...rest } = fakeIO(OK + CELL + DA, env, 500).io;
    void timeoutMs;
    return rest;
  };

  const ssh = await probeCaps(late({ SSH_CONNECTION: '10.0.0.1 5 10.0.0.2 22' }));
  assert.equal(ssh.tier, 'graphics', 'SSH 下 500ms 的回复被超时切掉了');
  assert.equal(ssh.fps, 15);
  assert.match(ssh.why, /格像素 16×34/, '接住了就该用终端报的值');

  const local = await probeCaps(late({}));
  assert.equal(local.tier, 'half', '本地预算该是 400ms —— 放宽到 1200 会让每次启动多黑半秒');
  assert.match(local.why, /400ms/);
});

/**
 * `doctor --gfx` 的契约：**探测的结论管不着它**。
 *
 * 这条存在的理由是一次真实的死胡同：SSH 上探测拿不到回复 → 报 half → 用户看到的仍然是
 * 3 像素的火柴人，而"到底是链路断了还是终端真不支持"从输出里分不出来。探测是**双向**
 * 握手（回程那一半 SSH 很容易吃掉），出图是**单向**的 —— 所以哪怕档位已经判成 half，
 * `--gfx` 也必须照样把那张图送出去，让用户用眼睛定论。
 */
test('doctor --gfx：档位判成 half 也照样送图，几何是出货那条', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const run = (args: string[]): string => execFileSync(path.join(root, 'bin/moyu'), args, {
    encoding: 'utf8',
    // MOYU_TIER=half 是最狠的那个前提：连强制降档都不该让 --gfx 闭嘴。
    env: { ...process.env, MOYU_TIER: 'half', TERM: 'xterm-256color', COLUMNS: '', LINES: '' },
  });

  const gfx = run(['doctor', '--gfx']);
  const apc = /\x1b_G([^;]*);/.exec(gfx);
  assert.notEqual(apc, null, `--gfx 没发 APC —— 那它就什么都证明不了：${JSON.stringify(gfx.slice(-200))}`);
  const keys = apc?.[1] ?? '';
  assert.match(keys, /a=T/);
  assert.match(keys, /c=40,r=2/, `图必须按出货那条的格数夹住（实际键：${keys}）`);
  assert.match(keys, /q=2/, '出帧的 APC 一定要抑制回复');
  // 相对定位：这一页前面已经打了十几行文字，绝对行号是未知的。发了 CUP 就会盖掉输出。
  assert.ok(!/\x1b\[\d+;1H\x1b_G/.test(gfx), '图前面发了绝对定位 —— 会跳到屏幕别处去');
  assert.match(gfx, /火柴人/, '三种结果的说明要在图**之前**打出来');

  // 不带 --gfx 就一个图字节都不发（这一页是会被贴到 issue 里的，2.6 KB base64 不能默认吐）。
  const plain = run(['doctor', '--caps']);
  assert.ok(!plain.includes('\x1b_G'), '--caps 自己吐图了');
  assert.match(plain, /--gfx/, '--caps 要指路到 --gfx，否则没人知道有这条命令');
});
