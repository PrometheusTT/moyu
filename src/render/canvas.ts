/**
 * 半块画布 + 帧间 diff + SGR 游程压缩。
 *
 * 这是渲染层的核心，M0 只用它画一条彩带，但结构就是最终版要用的：
 *
 *   - 一个字符格 = 两个上下堆叠的像素。用 `▀`（U+2580 上半块）：**前景色 = 上像素、
 *     背景色 = 下像素**。这是唯一一种零颜色损失的亚字符技巧 —— 一个格子本来就能带两个颜色，
 *     四分块/六分块能换来更高分辨率，但会把精灵的明暗压掉。
 *   - **帧间 diff + 游程压缩是硬性要求，不是优化**。实测数据：160×90 画布整帧 19.5 KB，
 *     diff 后平均 4.8 KB；而不做游程压缩、每格颜色都不同的病态情况是 256 KB/帧
 *     （30fps ≈ 7.7 MB/s，直接不可行）。差距全在这两件事上。
 *
 * 像素坐标系：`(x, y)`，`y` 从 0 到 `rows * 2 - 1`。`y` 是偶数 → 前景，奇数 → 背景。
 *
 * 它是 `PixelTarget` 的**保底档**实现（`tier: 'half'`）：任何真彩终端都能画，不需要探测、
 * 没有终端侧状态要清理。分辨率是三档里最低的（2 行条只有 4 个像素行），所以只在
 * 像素档探测失败时才用它 —— 但它必须永远能用，这是"不崩"的下限。
 */

/** 上半块。前景画上像素，背景画下像素。 */
const HALF = '▀';

/** 打包成 0xRRGGBB。渲染热路径上不想碰对象。 */
export function rgb(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

import type { PixelTarget, Tier } from './target.ts';

export class Canvas implements PixelTarget {
  readonly tier: Tier = 'half';
  cols: number;
  /** 字符行数。像素高度 = rows * 2。 */
  rows: number;

  /** 上像素颜色，按 row * cols + col 索引。 */
  private top: Uint32Array;
  /** 下像素颜色。 */
  private bot: Uint32Array;
  /** 上一帧，用于 diff。 */
  private pTop: Uint32Array;
  private pBot: Uint32Array;
  /** 下一次 encode 是否全量重绘（首帧、resize、让屏恢复后都必须全量）。 */
  private dirtyAll = true;

  /** 上一帧实际写出的字节数。bench 和 HUD 用。 */
  lastBytes = 0;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    const n = this.cols * this.rows;
    this.top = new Uint32Array(n);
    this.bot = new Uint32Array(n);
    this.pTop = new Uint32Array(n);
    this.pBot = new Uint32Array(n);
  }

  get pixelHeight(): number {
    return this.rows * 2;
  }

  get pixelW(): number {
    return this.cols;
  }

  get pixelH(): number {
    return this.rows * 2;
  }

  /** 半块档没有终端侧状态（图、缓存）要清 —— 字节写出去就完了。 */
  disposeSeq(): string {
    return '';
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    const n = c * r;
    this.top = new Uint32Array(n);
    this.bot = new Uint32Array(n);
    this.pTop = new Uint32Array(n);
    this.pBot = new Uint32Array(n);
    this.dirtyAll = true;
  }

  /** 强制下一帧全量重绘。 */
  invalidate(): void {
    this.dirtyAll = true;
  }

  fill(color: number): void {
    this.top.fill(color);
    this.bot.fill(color);
  }

  /** 写一个像素。越界静默丢弃 —— 渲染层不该因为一个飞出屏幕的粒子而崩。 */
  setPixel(x: number, y: number, color: number): void {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows * 2) return;
    const i = (y >> 1) * this.cols + x;
    if ((y & 1) === 0) this.top[i] = color;
    else this.bot[i] = color;
  }

  /** 实心矩形（半开区间）。逐像素写 —— 半块档一帧最多几千个像素，不值得特化。 */
  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    const x1 = x + w;
    const y1 = y + h;
    for (let yy = y; yy < y1; yy++) {
      for (let xx = x; xx < x1; xx++) this.setPixel(xx, yy, color);
    }
  }

  getPixel(x: number, y: number): number {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows * 2) return 0;
    const i = (y >> 1) * this.cols + x;
    return ((y & 1) === 0 ? this.top[i] : this.bot[i])!;
  }

  /**
   * 编码成终端字节。`screenTop` 是画布第一行在真实屏幕上的行号（1-based）。
   *
   * 只输出变化的格子。每一行找出脏区间，区间内用 CUP 定位一次，然后靠
   * SGR-on-change 把连续同色的格子压成一段。
   *
   * 三条省字节的手段，按收益排序：
   *   1. **上下同色的格子用空格 + 背景色**。这时前景色根本看不见，发它是纯浪费。
   *      游戏画面里大片纯色（天空、地面、墙）占多数，这一条的收益最大 ——
   *      每个这样的格子省掉一整条 `\x1b[38;2;R;G;Bm`（最多 19 字节）外加 2 字节的
   *      `▀`（3 字节）与空格（1 字节）之差。
   *   2. **前景背景都变时合成一条 SGR**。省掉一组 `ESC [` 和 `m`。
   *   3. **每帧开头发一次 SGR 复位**。不是省字节，是正确性：内层可能留着下划线/反显
   *      之类的属性开着，我们只设颜色的话会把它的属性继承到游戏区里。
   *      每帧的颜色状态从零开始跟踪（`curFg/curBg` 是局部变量），所以复位是免费的。
   */
  encode(screenTop: number): string {
    const out: string[] = [];
    let curFg = -1;
    let curBg = -1;
    const full = this.dirtyAll;

    for (let r = 0; r < this.rows; r++) {
      const base = r * this.cols;
      let c = 0;
      while (c < this.cols) {
        // 找脏区间起点
        if (!full) {
          while (c < this.cols && this.top[base + c] === this.pTop[base + c] && this.bot[base + c] === this.pBot[base + c]) c++;
          if (c >= this.cols) break;
        }
        const spanStart = c;
        // 找脏区间终点。允许区间里夹几个干净格子 —— 重发一个格子（1~4 字节，同色时更少）
        // 比重发一条 CUP（~8 字节）便宜，所以碎片化的行不该被切成十几段。
        let clean = 0;
        let end = c;
        while (c < this.cols) {
          const same = !full
            && this.top[base + c] === this.pTop[base + c]
            && this.bot[base + c] === this.pBot[base + c];
          if (same) {
            if (++clean > 4) break;
          } else {
            clean = 0;
            end = c;
          }
          c++;
        }
        end += 1;

        out.push(`\x1b[${screenTop + r};${spanStart + 1}H`);
        for (let k = spanStart; k < end; k++) {
          const f = this.top[base + k]!;
          const b = this.bot[base + k]!;

          if (f === b) {
            // 上下同色 → 前景色不可见，一个空格就够。
            if (b !== curBg) { out.push(`\x1b[48;2;${(b >> 16) & 0xff};${(b >> 8) & 0xff};${b & 0xff}m`); curBg = b; }
            out.push(' ');
            continue;
          }
          if (f !== curFg && b !== curBg) {
            out.push(`\x1b[38;2;${(f >> 16) & 0xff};${(f >> 8) & 0xff};${f & 0xff};48;2;${(b >> 16) & 0xff};${(b >> 8) & 0xff};${b & 0xff}m`);
            curFg = f;
            curBg = b;
          } else if (f !== curFg) {
            out.push(`\x1b[38;2;${(f >> 16) & 0xff};${(f >> 8) & 0xff};${f & 0xff}m`);
            curFg = f;
          } else if (b !== curBg) {
            out.push(`\x1b[48;2;${(b >> 16) & 0xff};${(b >> 8) & 0xff};${b & 0xff}m`);
            curBg = b;
          }
          out.push(HALF);
        }
      }
    }

    this.pTop.set(this.top);
    this.pBot.set(this.bot);
    this.dirtyAll = false;

    if (out.length > 0) out.unshift('\x1b[m');
    const s = out.join('');
    this.lastBytes = Buffer.byteLength(s, 'utf8');
    return s;
  }
}
