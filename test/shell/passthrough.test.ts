import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Passthrough, type PassthroughOptions, type Region } from '../../src/shell/passthrough.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 默认区域：真实屏幕 1..30 给内层。 */
const R: Region = { top: 1, bottom: 30 };

function mk(region: Region = R, opts: Partial<Omit<PassthroughOptions, 'region'>> = {}): Passthrough {
  return new Passthrough({ region, cols: 80, ...opts });
}

/** 带尺寸应答的实例 + 一个收集"回给内层"的字节的数组。 */
function mkSize(region: Region = R, cols = 80, cell = { w: 8, h: 17 }): {
  p: Passthrough; replies: string[];
} {
  const replies: string[] = [];
  const p = mk(region, { cols, cell, onSizeQuery: (r) => { replies.push(r); } });
  return { p, replies };
}

/** 一次性喂完，返回输出字符串。 */
function once(input: string, p: Passthrough = mk()): string {
  return dec.decode(p.push(enc.encode(input)));
}

/**
 * 把输入切成 `parts` 段依次喂进去，拼接所有输出。
 * 这是外壳最容易坏的地方 —— PTY 的 read 会在任意位置切断转义序列。
 */
function feedSplit(input: string, cuts: readonly number[], p: Passthrough = mk()): string {
  const bytes = enc.encode(input);
  const out: number[] = [];
  let prev = 0;
  for (const c of [...cuts, bytes.length]) {
    const piece = bytes.subarray(prev, c);
    prev = c;
    if (piece.length === 0) continue;
    for (const b of p.push(piece)) out.push(b);
  }
  return dec.decode(Uint8Array.from(out));
}

test('普通字节原样透传', () => {
  assert.equal(once('hello world'), 'hello world');
  assert.equal(once('中文也一样'), '中文也一样');
});

test('界内的 CSI 序列字节级不变', () => {
  // 不只是"语义相同"，而是**同一串字节** —— 任何重写都是带宽和风险
  for (const s of ['\x1b[1;1H', '\x1b[30;80H', '\x1b[15d', '\x1b[0m', '\x1b[38;2;1;2;3m', '\x1b[2J', '\x1b[K']) {
    assert.equal(once(s), s, s.replace(/\x1b/g, 'ESC'));
  }
});

test('DECSTBM 超界被夹到区域底部', () => {
  assert.equal(once('\x1b[1;45r'), '\x1b[1;30r');
});

test('DECSTBM 界内也会被重写（平移是无条件的）', () => {
  // region.top = 1 时平移量为 0，字节恰好相同
  assert.equal(once('\x1b[5;20r'), '\x1b[5;20r');
});

test('DECSTBM 在非 1 起始的区域里被平移', () => {
  const p = mk({ top: 6, bottom: 20 });
  // 内层以为自己有 15 行，说"滚动区 1..15"，落到真实坐标是 6..20
  assert.equal(once('\x1b[1;15r', p), '\x1b[6;20r');
  assert.equal(once('\x1b[3;99r', p), '\x1b[8;20r');
});

test('裸 CSI r 复位成整个内层区域', () => {
  assert.equal(once('\x1b[r'), '\x1b[1;30r');
  assert.equal(once('\x1b[r', mk({ top: 6, bottom: 20 })), '\x1b[6;20r');
});

test('非法的 DECSTBM 区间退化成整个区域', () => {
  assert.equal(once('\x1b[20;5r'), '\x1b[1;30r', 'top >= bottom');
  assert.equal(once('\x1b[10;10r'), '\x1b[1;30r', '单行区间');
});

test('onScrollRegion 拿到的是内层的原始请求值，不是夹取后的', () => {
  const seen: Array<[number, number]> = [];
  const p = mk(R, { onScrollRegion: (t, b) => seen.push([t, b]) });
  once('\x1b[1;45r', p);
  assert.deepEqual(seen, [[1, 45]]);
});

test('绝对行定位超界被夹住', () => {
  assert.equal(once('\x1b[40;5H'), '\x1b[30;5H');
  assert.equal(once('\x1b[99;1f'), '\x1b[30;1f', 'HVP 保持原本的终结字节');
  assert.equal(once('\x1b[45d'), '\x1b[30d', 'VPA');
});

test('绝对行定位的列号不受影响', () => {
  assert.equal(once('\x1b[40;200H'), '\x1b[30;200H', '列越界交给真实终端自己夹');
});

test('备用屏期间**照样**夹取（实测：真实 claude 整个会话都待在备用屏上）', () => {
  // 这条测试守着一个被实测推翻过的假设。原来的策略是"进备用屏就让屏、停止夹取"，
  // 前提是"切备用屏 = 它想要整屏"。真实 claude 2.1.260 启动时发一次 ?1049h 就再也不回来，
  // 按原策略游戏会永久消失。备用屏只是另一个缓冲区，行数是 TIOCSWINSZ 给的，与缓冲区无关。
  const p = mk();
  assert.equal(once('\x1b[?1049h', p), '\x1b[?1049h', '切屏字节本身不改写');
  assert.equal(p.inAltScreen, true);
  assert.equal(once('\x1b[40;5H', p), '\x1b[30;5H', '备用屏上定位照样夹取');
  assert.equal(once('\x1b[1;45r', p), '\x1b[1;30r', '备用屏上 DECSTBM 照样夹取');
  assert.equal(once('\x1b[?1049l', p), '\x1b[?1049l');
  assert.equal(p.inAltScreen, false);
  assert.equal(once('\x1b[40;5H', p), '\x1b[30;5H', '回主屏后当然也夹');
});

test('ED 2 / ED 3 上报给上层，但字节不改写', () => {
  // 上报是**正确性要求**：ED 不受滚动区约束，会把游戏区一起擦掉，而画布是差分编码的 ——
  // 上层不 invalidate 就以为屏幕上还是上一帧，什么都不重发，游戏区一直黑着。
  for (const [seq, want] of [['\x1b[2J', 1], ['\x1b[3J', 1], ['\x1b[J', 0], ['\x1b[0J', 0], ['\x1b[1J', 0]] as const) {
    let n = 0;
    const p = mk(R, { onFullClear: () => { n++; } });
    assert.equal(once(seq, p), seq, `${seq.replace(/\x1b/g, 'ESC')} 不该被改写`);
    assert.equal(n, want, `${seq.replace(/\x1b/g, 'ESC')} 的上报次数`);
  }
});

test('onAltScreen 只在状态真正翻转时触发', () => {
  const events: boolean[] = [];
  const p = mk(R, { onAltScreen: (on) => events.push(on) });
  once('\x1b[?1049h', p);
  once('\x1b[?1049h', p);   // 重复的 set 不该再报一次
  once('\x1b[?1047h', p);
  once('\x1b[?1049l', p);
  once('\x1b[?1049l', p);
  assert.deepEqual(events, [true, false]);
});

test('?47 和 ?1047 也算备用屏', () => {
  for (const seq of ['\x1b[?47h', '\x1b[?1047h']) {
    const p = mk();
    once(seq, p);
    assert.equal(p.inAltScreen, true, seq);
  }
});

test('别的 DEC 私有模式不碰', () => {
  for (const s of ['\x1b[?25l', '\x1b[?25h', '\x1b[?7h', '\x1b[?2004h', '\x1b[?1006h', '\x1b[?2026h']) {
    const p = mk();
    assert.equal(once(s, p), s);
    assert.equal(p.inAltScreen, false, `${s} 不该被当成备用屏`);
  }
});

test('带中间字节的序列一概不动', () => {
  // DECSCUSR / DECRQM —— 参数位看起来像行号，但语义完全不同，碰了就错
  for (const s of ['\x1b[2 q', '\x1b[?2026$p', '\x1b[40;5$x']) {
    assert.equal(once(s), s, s.replace(/\x1b/g, 'ESC'));
  }
});

test('kitty 键盘协议的私有前缀序列透传', () => {
  for (const s of ['\x1b[>11u', '\x1b[<u', '\x1b[=0;1u', '\x1b[?u']) {
    assert.equal(once(s), s);
  }
});

test('kitty 键盘标志的 push/pop 被数着，好在内层死得不干净的时候替它弹掉', () => {
  // 只数，不改写。不还原的症状离我们很远：用户回到自己的 shell，方向键变成乱码、
  // Ctrl+C 不再产生 SIGINT —— 没人会想到是那个摸鱼游戏干的。
  const p = mk();
  assert.equal(once('\x1b[>5u', p), '\x1b[>5u', '字节必须原样过去 —— 标志仲裁是 M4 的事');
  assert.equal(p.kittyDepth, 1);
  once('\x1b[>1u', p);
  assert.equal(p.kittyDepth, 2);
  once('\x1b[<u', p);
  assert.equal(p.kittyDepth, 1, '裸 pop 缺省弹一层');
  once('\x1b[<3u', p);
  assert.equal(p.kittyDepth, 0, '弹多了不能变成负数 —— 退出时会被当成"弹 -N 层"');
  assert.equal(p.kittySet, false);
  once('\x1b[=5;1u', p);
  assert.equal(p.kittySet, true, '`CSI = … u` 不入栈，只有硬复位收拾得了');
  assert.equal(p.kittyDepth, 0, '`CSI = … u` 不该动栈深度');
  once('\x1b[?u', p);
  assert.equal(p.kittyDepth, 0, '查询不该动栈深度');
});

test('单字节 ESC 序列透传', () => {
  for (const s of ['\x1b7', '\x1b8', '\x1bD', '\x1bE', '\x1bM', '\x1bc', '\x1b(B', '\x1b#8']) {
    assert.equal(once(s), s, s.replace(/\x1b/g, 'ESC'));
  }
});

test('OSC 载荷里的普通字节不被解释', () => {
  // 载荷里出现 '[' '40;5H' 这种看起来像 CSI 的东西，但没有 ESC 引导，就只是文本
  const s = '\x1b]0;[40;5H fake\x07x';
  assert.equal(once(s), s);
});

test('载荷里的裸 ESC 会终结字符串 —— 和真实终端一致', () => {
  // 这是有意的语义，不是漏洞：VT500 状态表里 OSC_STRING 收到 ESC 就转 escape 态。
  // OSC 载荷本来就不能含裸 ESC（所以 OSC 52 用 base64）。真实终端会把后面那段
  // 当成一条新的 CSI，我们必须做同样的判断，否则就会漏掉一次夹取。
  assert.equal(once('\x1b]0;t\x1b[40;5H'), '\x1b]0;t\x1b[30;5H');
});

test('OSC 52 剪贴板长载荷原样通过', () => {
  const payload = 'A'.repeat(4096);
  const s = `\x1b]52;c;${payload}\x1b\\`;
  assert.equal(once(s), s);
});

test('DCS 载荷原样通过，ST 完整吐出', () => {
  const s = '\x1bP+q436f6c6f72\x1b\\y';
  assert.equal(once(s), s);
});

test('畸形超长 CSI 原样吐出，不吞字节', () => {
  const s = `\x1b[${'1;'.repeat(200)}H`;
  const out = once(s);
  assert.equal(out, s);
});

test('半截序列不会被提前吐出去', () => {
  const p = mk();
  assert.equal(once('ab\x1b[1;4', p), 'ab', '未完成的 CSI 留在缓冲里');
  assert.equal(p.hasPending, true);
  assert.equal(once('5r', p), '\x1b[1;30r', '补齐后一次性吐出夹取结果');
  assert.equal(p.hasPending, false);
});

test('在每一个可能的位置切断，结果都一致', () => {
  const input = 'x\x1b[1;45ry\x1b[?1049h\x1b[40;1Hz';
  const expected = 'x\x1b[1;30ry\x1b[?1049h\x1b[30;1Hz';
  const n = enc.encode(input).length;

  assert.equal(once(input), expected, '不切的基准');
  for (let cut = 1; cut < n; cut++) {
    assert.equal(feedSplit(input, [cut]), expected, `在第 ${cut} 字节后切断`);
  }
});

test('逐字节喂入（最坏情况）结果不变', () => {
  const input = 'x\x1b[1;45ry\x1b[?1049h\x1b[40;1Hz';
  const expected = 'x\x1b[1;30ry\x1b[?1049h\x1b[30;1Hz';
  const cuts = Array.from({ length: enc.encode(input).length }, (_, i) => i + 1);
  assert.equal(feedSplit(input, cuts), expected);
});

test('三处切断的组合也一致', () => {
  const input = '\x1b[5;10H\x1b[1;99r\x1b]0;t\x07\x1b[?1049h\x1b[99;9H';
  const expected = '\x1b[5;10H\x1b[1;30r\x1b]0;t\x07\x1b[?1049h\x1b[30;9H';
  const n = enc.encode(input).length;
  for (let a = 1; a < n - 2; a += 3) {
    for (let b = a + 1; b < n - 1; b += 5) {
      for (let c = b + 1; c < n; c += 7) {
        assert.equal(feedSplit(input, [a, b, c]), expected, `切在 ${a},${b},${c}`);
      }
    }
  }
});

test('多字节 UTF-8 被切断也不损坏', () => {
  const input = '你好世界';
  const bytes = enc.encode(input);
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.equal(feedSplit(input, [cut]), input, `UTF-8 在第 ${cut} 字节后切断`);
  }
});

test('区域可以在运行中改（resize / 焦点联动）', () => {
  const p = mk();
  assert.equal(once('\x1b[40;1H', p), '\x1b[30;1H');
  p.region = { top: 1, bottom: 12 };
  assert.equal(once('\x1b[40;1H', p), '\x1b[12;1H');
  assert.equal(once('\x1b[8;1H', p), '\x1b[8;1H', '新区域内的定位照旧不动');
});

test('大块混合内容的吞吐不改字节（除了三类改写）', () => {
  const chunk = 'line one\r\n\x1b[32mgreen\x1b[0m\r\n\x1b[1;1H\x1b[Ktail';
  assert.equal(once(chunk), chunk);
});

test('OSC 没终结符就跟了新序列，新序列照样被夹取', () => {
  assert.equal(once('\x1b]0;t\x1b7\x1b[40;5H'), '\x1b]0;t\x1b7\x1b[30;5H');
});

test('CAN / SUB 中止字符串', () => {
  const p = mk();
  assert.equal(once('\x1b]0;t\x18\x1b[40;5H', p), '\x1b]0;t\x18\x1b[30;5H');
});

test('字符串被打断的场景在任意切点下一致', () => {
  const input = '\x1b]0;t\x1b[40;5H';
  const expected = '\x1b]0;t\x1b[30;5H';
  const n = enc.encode(input).length;
  for (let cut = 1; cut < n; cut++) {
    assert.equal(feedSplit(input, [cut]), expected, `切在第 ${cut} 字节后`);
  }
});

/* ── 尺寸查询（P9）─────────────────────────────────────────────────────
 *
 * 内层问"我有多大"的时候，终端会回**整个窗口** —— 而内层只有上半屏。它照那个数排版
 * 就会算错自己的高度；按窗口高度算出来的一张 kitty 图更会直接溢下来盖住游戏区。
 * 所以这几条查询必须被我们吞掉、由我们回答。下面每一条都断言两件事：
 * 给终端的字节里**一个字节都没有**，以及回给内层的那串数字等于内层真实拿到的那块。
 */

test('CSI 18 t（问文本区字符数）被吞掉，我们按内层区域回答', () => {
  const { p, replies } = mkSize();
  assert.equal(once('\x1b[18t', p), '', '查询漏给终端了 —— 终端会抢答成整屏');
  assert.deepEqual(replies, ['\x1b[8;30;80t']);
});

test('CSI 19 t 也按内层回答（内层能用的就那么大）', () => {
  const { p, replies } = mkSize();
  assert.equal(once('\x1b[19t', p), '');
  assert.deepEqual(replies, ['\x1b[9;30;80t']);
});

test('CSI 14 t（问文本区像素）按内层行数 × 格像素回答', () => {
  // 这条是那张图溢进游戏区的直接来源：内层拿到 45 行的像素高就会画 45 行的图。
  const { p, replies } = mkSize({ top: 1, bottom: 30 }, 80, { w: 16, h: 34 });
  assert.equal(once('\x1b[14t', p), '');
  assert.deepEqual(replies, [`\x1b[4;${30 * 34};${80 * 16}t`]);
});

test('CSI 15 t 和 14 t 同一块区域，只有报头不同', () => {
  const { p, replies } = mkSize({ top: 1, bottom: 10 }, 40, { w: 8, h: 17 });
  assert.equal(once('\x1b[15t', p), '');
  assert.deepEqual(replies, [`\x1b[5;${10 * 17};${40 * 8}t`]);
});

test('CSI 16 t 回探测到的格像素（和图用的是同一个值）', () => {
  const { p, replies } = mkSize(R, 80, { w: 16, h: 34 });
  assert.equal(once('\x1b[16t', p), '');
  assert.deepEqual(replies, ['\x1b[6;34;16t']);
});

test('不给 onSizeQuery 就原样透传 —— 吞掉一条没人回答的查询会让内层干等', () => {
  for (const q of ['\x1b[14t', '\x1b[16t', '\x1b[18t', '\x1b[19t']) {
    assert.equal(once(q), q, q.replace(/\x1b/g, 'ESC'));
  }
});

test('别的 XTWINOPS 不碰（改窗口大小、存取标题）', () => {
  const { p, replies } = mkSize();
  for (const q of ['\x1b[24t', '\x1b[1t', '\x1b[2t', '\x1b[22;0t', '\x1b[23;0t', '\x1b[t', '\x1b[11t']) {
    assert.equal(once(q, p), q, q.replace(/\x1b/g, 'ESC'));
  }
  assert.deepEqual(replies, [], '这些不是尺寸查询，不该由我们回答');
});

test('带前缀/中间字节的 t 序列一概不动', () => {
  const { p, replies } = mkSize();
  for (const q of ['\x1b[?18t', '\x1b[>18t', '\x1b[18 t']) {
    assert.equal(once(q, p), q, q.replace(/\x1b/g, 'ESC'));
  }
  assert.deepEqual(replies, []);
});

test('答案跟着区域和列数变（resize / 收起游戏区）', () => {
  const { p, replies } = mkSize({ top: 1, bottom: 30 }, 80);
  assert.equal(once('\x1b[18t', p), '');
  // 用户按 ^G h 收起游戏区（内层长回来，只剩 1 行给收起条）：答案必须立刻跟上
  p.region = { top: 1, bottom: 45 };
  p.cols = 120;
  assert.equal(once('\x1b[18t', p), '');
  p.cell = { w: 16, h: 34 };
  assert.equal(once('\x1b[14t', p), '');
  assert.deepEqual(replies, ['\x1b[8;30;80t', '\x1b[8;45;120t', `\x1b[4;${45 * 34};${120 * 16}t`]);
});

test('非 1 起始的区域按行数（不是底边行号）回答', () => {
  const { p, replies } = mkSize({ top: 6, bottom: 20 }, 80);
  assert.equal(once('\x1b[18t', p), '');
  assert.deepEqual(replies, ['\x1b[8;15;80t'], '内层以为自己有 15 行，不是 20 行');
});

test('查询被切成两半照样吞掉、照样回答一次', () => {
  const input = 'a\x1b[18tb';
  const n = enc.encode(input).length;
  for (let cut = 1; cut < n; cut++) {
    const { p, replies } = mkSize();
    assert.equal(feedSplit(input, [cut], p), 'ab', `切在第 ${cut} 字节后`);
    assert.deepEqual(replies, ['\x1b[8;30;80t'], `切在第 ${cut} 字节后`);
  }
});

test('查询夹在一串正常输出中间，只有它消失', () => {
  const { p, replies } = mkSize();
  assert.equal(once('\x1b[1;1H\x1b[18thi\x1b[0m', p), '\x1b[1;1Hhi\x1b[0m');
  assert.deepEqual(replies, ['\x1b[8;30;80t']);
});
