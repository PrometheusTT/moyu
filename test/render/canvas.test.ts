import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, rgb } from '../../src/render/canvas.ts';

/**
 * 把 `encode()` 吐出来的字节**放回**一张虚拟屏幕上，然后断言这张屏幕和画布一致。
 *
 * 这是这个文件里唯一重要的手段。diff + 游程压缩是渲染层最容易出静默错误的地方 ——
 * 少发一个格子、SGR 状态跟丢一次，屏幕上就是一块残留的脏色，而单测如果只断言
 * "字节数变小了"根本发现不了。往回解码之后，正确性就变成一条可断言的等式：
 *
 *   放完 N 帧的字节 → 屏幕内容 === 第 N 帧的画布内容
 *
 * 而且解码器**遇到不认识的序列就抛** —— 于是它顺带锁死了编码器的输出词汇表：
 * 哪天有人往里加一条没想清楚的转义序列，这里会立刻红。
 */
class Screen {
  /** [row][col] → 上/下像素颜色。-1 = 这个格子从没被写过。 */
  private cells: Array<Array<{ top: number; bot: number }>>;
  private fg = -1;
  private bg = -1;
  private row = 1;
  private col = 1;
  private readonly cols: number;
  private readonly rows: number;

  // 不用参数属性 —— Node 的类型剥离是纯删除，不生成赋值语句（见 shell/teardown.ts 同处注释）。
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows + 1 }, () =>
      Array.from({ length: cols + 1 }, () => ({ top: -1, bot: -1 })));
  }

  cell(row: number, col: number): { top: number; bot: number } {
    return this.cells[row]![col]!;
  }

  apply(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        assert.equal(s[i + 1], '[', `只该出现 CSI，实际 ESC ${s[i + 1]}`);
        let j = i + 2;
        while (j < s.length && !/[a-zA-Z]/.test(s[j]!)) j++;
        const params = s.slice(i + 2, j);
        const final = s[j]!;
        i = j + 1;
        if (final === 'H') this.cup(params);
        else if (final === 'm') this.sgr(params);
        else assert.fail(`编码器发了一条意料之外的序列：CSI ${params}${final}`);
        continue;
      }
      i++;
      if (ch === '▀') this.put(this.fg, this.bg);
      else if (ch === ' ') this.put(this.bg, this.bg);
      else assert.fail(`编码器发了一个意料之外的字符：${JSON.stringify(ch)}`);
    }
  }

  private cup(params: string): void {
    const [r, c] = params.split(';');
    this.row = r === undefined || r === '' ? 1 : Number(r);
    this.col = c === undefined || c === '' ? 1 : Number(c);
  }

  /** 只认我们真的会发的三种：复位、38;2 真彩前景、48;2 真彩背景。 */
  private sgr(params: string): void {
    if (params === '' || params === '0') { this.fg = -1; this.bg = -1; return; }
    const p = params.split(';').map(Number);
    let k = 0;
    while (k < p.length) {
      const code = p[k]!;
      assert.ok(code === 38 || code === 48, `意料之外的 SGR 参数 ${code}`);
      assert.equal(p[k + 1], 2, '只该用 38;2 / 48;2 真彩形式');
      const color = rgb(p[k + 2]!, p[k + 3]!, p[k + 4]!);
      if (code === 38) this.fg = color; else this.bg = color;
      k += 5;
    }
  }

  private put(top: number, bot: number): void {
    assert.ok(this.row >= 1 && this.row <= this.rows, `写到了屏幕外的第 ${this.row} 行`);
    assert.ok(this.col >= 1 && this.col <= this.cols, `写到了屏幕外的第 ${this.col} 列`);
    this.cells[this.row]![this.col] = { top, bot };
    this.col++;
  }
}

/** 断言虚拟屏幕逐格等于画布。`screenTop` 要和 encode 时传的一致。 */
function assertMatches(sc: Screen, cv: Canvas, screenTop: number, msg: string): void {
  for (let r = 0; r < cv.rows; r++) {
    for (let x = 0; x < cv.cols; x++) {
      const got = sc.cell(screenTop + r, x + 1);
      const want = { top: cv.getPixel(x, r * 2), bot: cv.getPixel(x, r * 2 + 1) };
      assert.deepEqual(got, want, `${msg}：格子 (行 ${screenTop + r}, 列 ${x + 1}) 不一致`);
    }
  }
}

const A = rgb(10, 20, 30);
const B = rgb(200, 100, 50);
const C = rgb(0, 255, 128);

test('首帧全量重绘，解码回来和画布逐格一致', () => {
  const cv = new Canvas(8, 3);
  cv.fill(A);
  cv.setPixel(2, 1, B);
  cv.setPixel(5, 4, C);
  const sc = new Screen(8, 3);
  sc.apply(cv.encode(1));
  assertMatches(sc, cv, 1, '首帧');
});

test('没有任何变化的帧一个字节都不发', () => {
  const cv = new Canvas(8, 3);
  cv.fill(A);
  cv.encode(1);
  assert.equal(cv.encode(1), '', '内容没变却发了字节 —— diff 失效了');
  assert.equal(cv.lastBytes, 0);
});

test('连续多帧只发 diff，屏幕仍然逐格正确', () => {
  const cv = new Canvas(20, 4);
  const sc = new Screen(20, 4);
  cv.fill(A);
  sc.apply(cv.encode(1));

  // 每帧动一个 3×3 的方块，其它地方保持不变 —— 就是最终游戏的画面特征。
  for (let f = 0; f < 12; f++) {
    cv.fill(A);
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) cv.setPixel(f + dx, dy + 1, dx === 2 ? C : B);
    }
    sc.apply(cv.encode(1));
    assertMatches(sc, cv, 1, `第 ${f} 帧`);
  }
});

test('invalidate 之后重发整帧', () => {
  const cv = new Canvas(6, 2);
  cv.fill(A);
  cv.encode(1);
  assert.equal(cv.encode(1), '');
  cv.invalidate();
  const s = cv.encode(1);
  assert.notEqual(s, '', 'invalidate 之后必须全量重绘');
  const sc = new Screen(6, 2);
  sc.apply(s);
  assertMatches(sc, cv, 1, 'invalidate 后');
});

test('resize 强制全量重绘，且尺寸跟着变', () => {
  const cv = new Canvas(6, 2);
  cv.fill(A);
  cv.encode(1);
  cv.resize(10, 3);
  assert.deepEqual({ cols: cv.cols, rows: cv.rows, px: cv.pixelHeight }, { cols: 10, rows: 3, px: 6 });
  cv.fill(B);
  const sc = new Screen(10, 3);
  sc.apply(cv.encode(1));
  assertMatches(sc, cv, 1, 'resize 后');
});

test('screenTop 把画布整体下移到游戏区', () => {
  const cv = new Canvas(4, 2);
  cv.fill(A);
  const sc = new Screen(4, 12);
  sc.apply(cv.encode(9));           // 画布第一行落在屏幕第 9 行
  assertMatches(sc, cv, 9, 'screenTop=9');
  assert.deepEqual(sc.cell(1, 1), { top: -1, bot: -1 }, '不该碰游戏区上方的行');
});

test('上下同色的格子用空格 + 只发背景色', () => {
  // 这一条是最大的一笔字节节省（游戏画面里大片纯色占多数），所以按字节断言 ——
  // 哪天它被改回"总是发前景色 + ▀"，带宽会静默翻倍，只有这里会红。
  const cv = new Canvas(4, 1);
  cv.fill(A);
  const s = cv.encode(1);
  assert.ok(s.includes('    '), `同色行该是 4 个空格，实际：${JSON.stringify(s)}`);
  assert.ok(!s.includes('▀'), '同色格子不该发 ▀');
  assert.ok(!s.includes('38;2'), '同色格子不该发前景色');
});

test('上下不同色时前景背景合成一条 SGR', () => {
  const cv = new Canvas(1, 1);
  cv.setPixel(0, 0, B);
  cv.setPixel(0, 1, C);
  const s = cv.encode(1);
  assert.ok(s.includes('38;2;200;100;50;48;2;0;255;128m'), `该合成一条 SGR，实际：${JSON.stringify(s)}`);
});

test('每帧开头发一次 SGR 复位', () => {
  // 内层可能留着下划线/反显开着。我们只设颜色的话，它的属性会被继承到游戏区里。
  const cv = new Canvas(2, 1);
  cv.fill(A);
  assert.ok(cv.encode(1).startsWith('\x1b[m'), '每帧必须以 SGR 复位开头');
});

test('越界写像素静默丢弃，不抛也不越界污染', () => {
  const cv = new Canvas(3, 1);
  cv.fill(A);
  cv.setPixel(-1, 0, B);
  cv.setPixel(3, 0, B);
  cv.setPixel(0, -1, B);
  cv.setPixel(0, 2, B);          // pixelHeight = 2，所以 y=2 越界
  const sc = new Screen(3, 1);
  sc.apply(cv.encode(1));
  assertMatches(sc, cv, 1, '越界写之后');
  assert.equal(cv.getPixel(5, 5), 0, '越界读返回 0');
});

test('碎片化的一行不会被切成一堆 CUP', () => {
  // 编码器允许脏区间里夹几个干净格子。隔一格变一个色的病态行如果每个格子都发一条 CUP，
  // 字节数会爆。这里断言它没有退化成那样。
  const cv = new Canvas(40, 1);
  cv.fill(A);
  cv.encode(1);
  for (let x = 0; x < 40; x += 2) { cv.setPixel(x, 0, B); cv.setPixel(x, 1, B); }
  const s = cv.encode(1);
  const cups = (s.match(/\x1b\[\d+;\d+H/g) ?? []).length;
  assert.ok(cups <= 2, `40 列的碎片化行发了 ${cups} 条 CUP，定位开销失控了`);
  const sc = new Screen(40, 1);
  cv.invalidate();
  sc.apply(cv.encode(1));
  assertMatches(sc, cv, 1, '碎片化行');
});

test('出货尺寸（40×2 的条）跑真实战斗时每帧字节数留在预算里', async () => {
  // 这条守的是"字节是唯一的瓶颈"那个前提在**出货的那个配置上**成立。
  // 160×45 的基线测的是编码器，但装进外壳之后没人会看到 45 行的画布 ——
  // 条形区域一帧只有 80 个格子，任何一个把整条搞成每帧全脏的改动都会在这里现形。
  const { World } = await import('../../src/core/world.ts');
  const { paintWorldTo } = await import('../../src/render/scene.ts');
  const cv = new Canvas(40, 2);
  const w = new World(0x1234abcd);
  w.resize(cv.cols, cv.pixelHeight);
  w.taskStart();
  let total = 0;
  let peak = 0;
  for (let f = 0; f < 300; f++) {
    const move: -1 | 0 | 1 = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
    w.step(1 / 60, { move, jump: f % 53 === 0, slash: f % 11 === 0 });
    w.step(1 / 60, { move, jump: false, slash: false });
    paintWorldTo(cv, w);
    cv.encode(1);
    total += cv.lastBytes;
    if (cv.lastBytes > peak) peak = cv.lastBytes;
  }
  const avg = total / 300;
  assert.ok(avg > 0, '一个字节都没发 —— 这条测试自己坏了（世界没在动？）');
  assert.ok(avg < 1024, `平均 ${(avg / 1024).toFixed(2)} KB/帧，实测基线是 0.29 KB`);
  assert.ok(peak < 4096, `最差 ${(peak / 1024).toFixed(2)} KB/帧，实测基线是 0.90 KB`);
});
