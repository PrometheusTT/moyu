/** Portable high-density renderer: one terminal cell becomes a 2 x 4 bitmap. */
import type { PixelTarget, Tier } from './target.ts';

const DOT = [1, 2, 4, 64, 8, 16, 32, 128] as const;
type Glyph = { char: string; swap?: true };

/**
 * Braille is excellent for limbs and diagonals, but rectangular pixels rendered with round dots
 * look like perforated cardboard. Common axis-aligned masks get solid Unicode block glyphs;
 * irregular silhouettes stay Braille. Both paths retain the same two exact colors.
 */
const SOLID_GLYPH = new Map<number, Glyph>([
  [255, { char: '█' }],
  [9, { char: '▔' }], [192, { char: '▁' }],
  [27, { char: '▀' }], [228, { char: '▄' }],
  [71, { char: '▌' }], [184, { char: '▐' }],
  [3, { char: '▘' }], [24, { char: '▝' }], [68, { char: '▖' }], [160, { char: '▗' }],
  [95, { char: '▛' }], [187, { char: '▜' }], [231, { char: '▙' }], [252, { char: '▟' }],
  [163, { char: '▚' }], [92, { char: '▞' }],
  [63, { char: '▁', swap: true }], [246, { char: '▔', swap: true }],
]);
function sgrFg(c: number): string { return `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`; }
function sgrBg(c: number): string { return `\x1b[48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`; }
const DEFAULT_SGR = -2;
function distance(a: number, b: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const dr = ar - br, dg = ag - bg, db = ab - bb;
  return dr * dr * 3 + dg * dg * 4 + db * db * 2;
}

export class BrailleTarget implements PixelTarget {
  readonly tier: Tier = 'braille';
  cols: number; rows: number; lastBytes = 0;
  private pixels: Uint32Array;
  private mask: Uint8Array; private fg: Uint32Array; private bg: Uint32Array;
  private prevMask: Uint8Array; private prevFg: Uint32Array; private prevBg: Uint32Array;
  private dirtyAll = true;
  private glyphStyle: 'dots' | 'blocks' = 'blocks';
  /** 每帧 `fill()` 给出的画布底色。前景即使填满 2×4 也不能被误写成背景空格。 */
  private frameMatte = 0;
  /** 内嵌在 coding CLI 时继承用户主题，不在输入框上方贴一块固定黑色矩形。 */
  private readonly defaultBackground: boolean;
  /** 指定的画布颜色改用 ANSI 默认前景色，使主角在深浅主题里都保持对比。 */
  private readonly defaultForeground: number | null;

  constructor(cols: number, rows: number, options: { defaultBackground?: boolean; defaultForeground?: number } = {}) {
    this.cols = Math.max(1, cols); this.rows = Math.max(1, rows);
    this.defaultBackground = options.defaultBackground === true;
    this.defaultForeground = options.defaultForeground ?? null;
    this.pixels = new Uint32Array(0); this.mask = new Uint8Array(0);
    this.fg = new Uint32Array(0); this.bg = new Uint32Array(0);
    this.prevMask = new Uint8Array(0); this.prevFg = new Uint32Array(0); this.prevBg = new Uint32Array(0);
    this.alloc();
  }
  get pixelW(): number { return this.cols * 2; }
  get pixelH(): number { return this.rows * 4; }
  private alloc(): void {
    this.pixels = new Uint32Array(this.pixelW * this.pixelH);
    const n = this.cols * this.rows;
    this.mask = new Uint8Array(n); this.fg = new Uint32Array(n); this.bg = new Uint32Array(n);
    this.prevMask = new Uint8Array(n); this.prevFg = new Uint32Array(n); this.prevBg = new Uint32Array(n);
    this.dirtyAll = true;
  }
  resize(cols: number, rows: number): void {
    const c = Math.max(1, cols), r = Math.max(1, rows);
    if (c === this.cols && r === this.rows) return;
    this.cols = c; this.rows = r; this.alloc();
  }
  fill(color: number): void { this.frameMatte = color; this.pixels.fill(color); }
  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.pixelW, x + w), y1 = Math.min(this.pixelH, y + h);
    for (let yy = y0; yy < y1; yy++) this.pixels.fill(color, yy * this.pixelW + x0, yy * this.pixelW + x1);
  }
  setPixel(x: number, y: number, color: number): void {
    if (x < 0 || x >= this.pixelW || y < 0 || y >= this.pixelH) return;
    this.pixels[y * this.pixelW + x] = color;
  }
  getPixel(x: number, y: number): number {
    if (x < 0 || x >= this.pixelW || y < 0 || y >= this.pixelH) return 0;
    return this.pixels[y * this.pixelW + x]!;
  }
  invalidate(): void { this.dirtyAll = true; }
  setGlyphStyle(style: 'dots' | 'blocks'): void {
    if (this.glyphStyle !== style) { this.glyphStyle = style; this.invalidate(); }
  }
  disposeSeq(): string { return ''; }

  private quantizeCell(col: number, row: number, at: number): void {
    const colors: number[] = [], counts: number[] = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 4; y++) {
      const c = this.pixels[(row * 4 + y) * this.pixelW + col * 2 + x]!;
      const found = colors.indexOf(c);
      if (found < 0) { colors.push(c); counts.push(1); } else counts[found] = counts[found]! + 1;
    }
    // `fill()` 是渲染管线对“这一帧的底色”的明确声明，比“八个点里哪个颜色最多”可靠。
    // 后者会把一个填满单元格的角色身体判成背景，最终输出彩色空格，轮廓变成大矩形。
    const bg = this.frameMatte;
    let fg = bg, best = -1;
    for (let i = 0; i < colors.length; i++) {
      if (colors[i] === bg) continue;
      const score = distance(colors[i]!, bg) * counts[i]!;
      if (score > best) { best = score; fg = colors[i]!; }
    }
    let mask = 0;
    if (fg !== bg) {
      let n = 0;
      for (let x = 0; x < 2; x++) for (let y = 0; y < 4; y++, n++) {
        const c = this.pixels[(row * 4 + y) * this.pixelW + col * 2 + x]!;
        if (distance(c, fg) <= distance(c, bg)) mask |= DOT[n]!;
      }
    }
    this.bg[at] = bg; this.fg[at] = fg; this.mask[at] = mask;
  }

  encode(screenTop: number): string {
    const n = this.cols * this.rows;
    for (let i = 0; i < n; i++) this.quantizeCell(i % this.cols, Math.floor(i / this.cols), i);
    const out: string[] = []; let curFg = -1, curBg = -1; const full = this.dirtyAll;
    for (let row = 0; row < this.rows; row++) {
      const base = row * this.cols; let col = 0;
      while (col < this.cols) {
        if (!full) {
          while (col < this.cols && this.mask[base + col] === this.prevMask[base + col]
            && this.fg[base + col] === this.prevFg[base + col]
            && this.bg[base + col] === this.prevBg[base + col]) col++;
          if (col >= this.cols) break;
        }
        const start = col; let clean = 0, end = col;
        while (col < this.cols) {
          const same = !full && this.mask[base + col] === this.prevMask[base + col]
            && this.fg[base + col] === this.prevFg[base + col]
            && this.bg[base + col] === this.prevBg[base + col];
          if (same) { if (++clean > 4) break; } else { clean = 0; end = col; }
          col++;
        }
        end++; out.push(`\x1b[${screenTop + row};${start + 1}H`);
        for (let x = start; x < end; x++) {
          const i = base + x, m = this.mask[i]!, f = this.fg[i]!, b = this.bg[i]!;
          // 反色近似字形要把“画布底色”塞进 glyph 前景；透明模式里 ANSI 没有“默认背景色
          // 作为前景色”的表示法，所以此时宁可用精确 Braille mask，也不要画出一块错误色块。
          const candidate = this.glyphStyle === 'dots' ? undefined : SOLID_GLYPH.get(m);
          const glyph = this.defaultBackground && candidate?.swap === true ? undefined : candidate;
          const ef = glyph?.swap === true ? b : f;
          const eb = glyph?.swap === true ? f : b;
          const bgKey = this.defaultBackground && eb === this.frameMatte ? DEFAULT_SGR : eb;
          if (bgKey !== curBg) { out.push(bgKey === DEFAULT_SGR ? '\x1b[49m' : sgrBg(eb)); curBg = bgKey; }
          if (m === 0) { out.push(' '); continue; }
          const fgKey = (this.defaultBackground && ef === this.frameMatte) || ef === this.defaultForeground ? DEFAULT_SGR : ef;
          if (fgKey !== curFg) { out.push(fgKey === DEFAULT_SGR ? '\x1b[39m' : sgrFg(ef)); curFg = fgKey; }
          out.push(glyph?.char ?? String.fromCodePoint(0x2800 + m));
        }
      }
    }
    this.prevMask.set(this.mask); this.prevFg.set(this.fg); this.prevBg.set(this.bg);
    this.dirtyAll = false;
    if (out.length > 0) out.unshift('\x1b[m');
    const encoded = out.join(''); this.lastBytes = Buffer.byteLength(encoded); return encoded;
  }
}
