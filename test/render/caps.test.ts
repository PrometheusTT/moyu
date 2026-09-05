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

/** 假终端：`write` 进来之后按 `reply` 回一段字节，像真终端那样异步到达。 */
function fakeIO(reply: string | null, env: NodeJS.ProcessEnv = {}) {
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
      setImmediate(() => {
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

test('没人回：退半块档，而且不等满超时也能收工（哨兵到了）', async () => {
  const { io } = fakeIO(DA);                     // 只回哨兵，不回 OK
  const t0 = performance.now();
  const c = await probeCaps(io);
  assert.equal(c.tier, 'half');
  assert.equal(c.cellW, DEFAULT_CELL.w, '问不到格像素就用默认值（猜小是安全的那一侧）');
  assert.ok(performance.now() - t0 < 40, '哨兵到了还在等超时，启动会白卡一下');
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
