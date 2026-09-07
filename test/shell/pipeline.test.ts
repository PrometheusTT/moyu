import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Passthrough } from '../../src/shell/passthrough.ts';
import { VtCursor } from '../../src/shell/vtcursor.ts';
import { computeLayout, assertLayout, scrollRegionSeq, adjustGameRows, expandedGameRows, DEFAULT_GAME_ROWS, MIN_GAME_ROWS, MAX_GAME_ROWS } from '../../src/shell/regions.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 外壳的真实数据流：内层字节 → Passthrough 改写 → 真实终端，**同时**喂给 VtCursor。
 *
 * 喂给 VtCursor 的必须是**改写后**的字节，不是内层的原始字节。理由：
 * 我们要还原的是真实终端光标的位置，而真实终端看到的就是改写后的那一版。
 * 喂原始字节的话，一条被夹取的定位会让跟踪值和终端实际状态分叉，
 * 而这个分叉恰好只在"内层试图越界"时发生 —— 也就是最需要还原正确的时候。
 */
class Pipe {
  readonly pass: Passthrough;
  readonly vt: VtCursor;
  /** 真实终端收到的全部字节。累积成字节再解码 —— 分块解码会把切断的 UTF-8 变成 U+FFFD。 */
  private bytes: number[] = [];

  constructor(cols: number, innerRows: number) {
    this.pass = new Passthrough({ region: { top: 1, bottom: innerRows }, cols });
    this.vt = new VtCursor({ cols, rows: innerRows });
  }

  get wire(): string {
    return dec.decode(Uint8Array.from(this.bytes));
  }

  /** 清掉已记录的线上字节，方便只断言接下来那一段。 */
  clearWire(): void {
    this.bytes = [];
  }

  /** 内层吐出一个 chunk（字节接口 —— 切点可能落在 UTF-8 字符中间）。 */
  innerBytes(b: Uint8Array): this {
    const rewritten = this.pass.push(b);
    this.vt.feed(rewritten);
    for (const x of rewritten) this.bytes.push(x);
    return this;
  }

  /** 内层吐出一个 chunk。 */
  inner(s: string): this {
    return this.innerBytes(enc.encode(s));
  }

  /** 一帧游戏：跑到游戏区去画，然后按 VtCursor 的快照还原。 */
  frame(gameTop: number, paint: string): string {
    const seq = `\x1b[${gameTop};1H${paint}` + this.vt.restoreSeq();
    for (const x of enc.encode(seq)) this.bytes.push(x);
    return seq;
  }
}

test('分屏几何自洽', () => {
  for (const cols of [60, 80, 100, 200]) {
    for (const rows of [11, 18, 24, 30, 45, 60, 100]) {
      const r = computeLayout({ cols, rows });
      assert.equal(r.kind, 'split', `${cols}×${rows} 应该能分屏`);
      if (r.kind === 'split') assertLayout(r.layout);
    }
  }
});

test('太小的终端不分屏', () => {
  assert.equal(computeLayout({ cols: 40, rows: 40 }).kind, 'too-small', '列数不够');
  // 游戏条只要 1 行，所以门槛是 MIN_INNER_ROWS + 1 = 11 行。
  assert.equal(computeLayout({ cols: 100, rows: 10 }).kind, 'too-small', '行数不够');
  assert.equal(computeLayout({ cols: 100, rows: 11 }).kind, 'split', '11 行刚好够');
});

test('游戏条恒定 2 行，而且不跟焦点联动', () => {
  // 焦点联动尺寸这件事**故意删掉了**：它要 pty.resize()，而 resize 让内层 TUI
  // 全量重绘，切一次焦点抖一次。现在切焦点只改按键路由。
  for (const rows of [11, 24, 45, 120]) {
    const r = computeLayout({ cols: 100, rows });
    assert.ok(r.kind === 'split');
    if (r.kind === 'split') {
      assert.equal(r.layout.gameRows, Math.min(DEFAULT_GAME_ROWS, rows - 10), `${rows} 行`);
      assert.equal(r.layout.innerTop, 1);
      assert.equal(r.layout.gameTop, r.layout.rows - r.layout.gameRows + 1, '游戏条必须贴在最底下');
    }
  }
});

test('手动调高度服从掌机上限，而且给 HUD 留着列', () => {
  const rows = 40;
  let cur = DEFAULT_GAME_ROWS;
  for (let i = 0; i < 100; i++) cur = adjustGameRows(rows, cur, 1);
  assert.equal(cur, MAX_GAME_ROWS, '往上撞到掌机上限为止');
  for (let i = 0; i < 100; i++) cur = adjustGameRows(rows, cur, -1);
  assert.equal(cur, MIN_GAME_ROWS, '往下撞到 1 行为止');
  for (const cols of [60, 80, 120, 400]) {
    const r = computeLayout({ cols, rows });
    assert.ok(r.kind === 'split');
    if (r.kind === 'split') {
      const l = r.layout;
      assert.ok(l.fieldCols <= 40, `场地不该那么宽：${l.fieldCols}`);
      assert.equal(l.fieldCols, 40, '窄终端也保留原生 80×8；完整帮助使用临时全宽文字');
      // 最后一列必须没人碰 —— 写屏幕右下角会置上延迟换行标志，下一个字符就滚屏。
      assert.ok(l.fieldCols + (l.cols - l.fieldCols - 1) < l.cols);
    }
  }
});

test('展开是偷玩窗口，不会再占掉接近半屏', () => {
  for (const [rows, want] of [[24, 5], [41, 7], [60, 8], [100, 8]] as const) {
    assert.equal(expandedGameRows(rows), want, `${rows} 行终端的展开高度`);
  }
});

test('滚动区序列把内层锁在上半屏', () => {
  const r = computeLayout({ cols: 100, rows: 45 });
  assert.ok(r.kind === 'split');
  if (r.kind === 'split') {
    assert.equal(scrollRegionSeq(r.layout), `\x1b[1;${r.layout.innerRows}r`);
    assert.ok(r.layout.innerRows < 45);
  }
});

test('内层越界的定位不会落到游戏区', () => {
  const p = new Pipe(100, 30);
  p.inner('\x1b[45;10H');
  assert.ok(p.vt.row <= 30, `跟踪到的行 ${p.vt.row} 必须在内层区域内`);
  assert.match(p.wire, /\x1b\[30;10H/);
});

test('内层设的过大滚动区被夹在内层区域内', () => {
  const p = new Pipe(100, 30);
  p.inner('\x1b[1;45r');
  assert.equal(p.wire, '\x1b[1;30r');
  assert.equal(p.vt.scrollBot, 30, 'VtCursor 看到的是改写后的值，和真实终端一致');
});

test('画完一帧游戏后光标精确回到内层的位置（M0 通过标准 ①）', () => {
  const p = new Pipe(100, 30);
  // 内层写了点东西，留在一个非平凡的状态：有颜色、光标隐藏、位置在半中间
  p.inner('\x1b[?25l\x1b[38;2;200;100;50m\x1b[12;37Hprompt> ');
  const before = { row: p.vt.row, col: p.vt.col, visible: p.vt.visible };
  assert.deepEqual(before, { row: 12, col: 45, visible: false });

  const seq = p.frame(31, '\x1b[48;2;10;20;30m' + ' '.repeat(20) + '\x1b[0m');

  // 还原序列必须无条件带齐三样：SGR、光标位置、可见性。
  // 少任何一样，下一次内层输出就会用错的颜色画在错的地方。
  assert.match(seq, /\x1b\[0[;m]/, '带 SGR 复位');
  assert.match(seq, /38;2;200;100;50/, '内层的前景色被重放');
  assert.ok(seq.endsWith('\x1b[12;45H\x1b[?25l'), `定位 + 隐藏光标结尾，实际：${JSON.stringify(seq.slice(-24))}`);
});

test('还原序列是幂等的：连续两帧产出同一串字节', () => {
  const p = new Pipe(100, 30);
  p.inner('\x1b[1;31m\x1b[7;13Hx');
  const a = p.vt.restoreSeq();
  const b = p.vt.restoreSeq();
  assert.equal(a, b);
});

test('还原不会误发 DECSTBM —— 那是我们的夹取值，不是内层的请求', () => {
  const p = new Pipe(100, 30);
  p.inner('\x1b[1;45r\x1b[5;5H');
  const seq = p.vt.restoreSeq();
  assert.doesNotMatch(seq, /\x1b\[\d*;?\d*r/, '还原序列里不该出现滚动区设置');
});

test('内层切备用屏后**照样**夹取，游戏照样能画', () => {
  // 备用屏在真实 claude 下是**稳态**不是瞬时事件（启动切过去，退出才切回来），
  // 所以"进备用屏就让屏"等于游戏永久消失。备用屏只是另一个缓冲区，
  // 内层有多少行是 TIOCSWINSZ 给的，跟缓冲区无关 —— 夹取在两边都必须成立。
  const p = new Pipe(100, 30);
  p.inner('\x1b[?1049h');
  assert.equal(p.pass.inAltScreen, true);
  assert.equal(p.vt.altScreen, true, '两个解析器对备用屏状态的判断必须一致');

  p.clearWire();
  p.inner('\x1b[45;10H');
  assert.equal(p.wire, '\x1b[30;10H', '备用屏上的越界定位照样被夹回内层区域');
  assert.ok(p.vt.row <= 30, `跟踪到的行 ${p.vt.row} 必须在内层区域内`);

  // 备用屏上画一帧游戏 —— 这是真实 claude 下"同屏合成"唯一成立的形态
  const seq = p.frame(31, 'GAME');
  assert.ok(seq.endsWith('\x1b[30;10H\x1b[?25h'), `帧尾要把内层光标还原：${JSON.stringify(seq.slice(-20))}`);

  p.inner('\x1b[?1049l');
  assert.equal(p.pass.inAltScreen, false);
  assert.equal(p.vt.altScreen, false);
  p.clearWire();
  p.inner('\x1b[45;10H');
  assert.equal(p.wire, '\x1b[30;10H', '回主屏后当然也夹');
});

test('resize 后两层的区域一起改，跟踪值不越界', () => {
  const p = new Pipe(100, 30);
  p.inner('\x1b[28;90Hxx');

  const r = computeLayout({ cols: 80, rows: 24 });
  assert.ok(r.kind === 'split');
  if (r.kind === 'split') {
    p.pass.region = { top: 1, bottom: r.layout.innerRows };
    p.vt.resize(r.layout.cols, r.layout.innerRows);
    assert.ok(p.vt.row <= r.layout.innerRows, `行 ${p.vt.row} <= ${r.layout.innerRows}`);
    assert.ok(p.vt.col <= r.layout.cols);
    p.clearWire();
    p.inner('\x1b[40;1H');
    assert.equal(p.wire, `\x1b[${r.layout.innerRows};1H`);
  }
});

test('两个解析器在"字符串被 ESC 打断"上的判断一致', () => {
  // 这是最容易让两边分叉的地方：如果 Passthrough 认为 ESC 终结了 OSC 而
  // VtCursor 认为没有（或反之），被夹取的那条定位就只有一边算进了光标位置。
  const p = new Pipe(100, 30);
  p.inner('\x1b]0;title\x1b[40;7H');
  assert.equal(p.wire, '\x1b]0;title\x1b[30;7H');
  assert.deepEqual({ row: p.vt.row, col: p.vt.col }, { row: 30, col: 7 });
});

test('内层输出被任意切碎，最终的光标跟踪值不变', () => {
  const script = '\x1b[?25l\x1b[1;45r\x1b[12;37Hhello 世界\x1b]0;t\x07\x1b[38;5;42m!';
  const bytes = enc.encode(script);

  const ref = new Pipe(100, 30);
  ref.inner(script);
  const want = { row: ref.vt.row, col: ref.vt.col, visible: ref.vt.visible, wire: ref.wire };

  // 走字节接口，绝不把半个 UTF-8 字符经过 string 中转 —— 那会被替换成 U+FFFD，
  // 测出来的就是测试自己的 bug 而不是被测代码的。
  for (let cut = 1; cut < bytes.length; cut++) {
    const p = new Pipe(100, 30);
    p.innerBytes(bytes.subarray(0, cut));
    p.innerBytes(bytes.subarray(cut));
    assert.deepEqual(
      { row: p.vt.row, col: p.vt.col, visible: p.vt.visible, wire: p.wire },
      want,
      `在第 ${cut} 字节后切断`,
    );
  }
});
