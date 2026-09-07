import type { PixelTarget, Tier } from '../render/target.ts';
import type { GameCanvas } from './types.ts';

/** Logical framebuffer shared by every cartridge and every terminal renderer. */
export class LogicalCanvas implements GameCanvas, PixelTarget {
  readonly tier: Tier = 'graphics';
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly pixelW: number;
  readonly pixelH: number;
  readonly lastBytes = 0;
  private readonly pixels: Uint32Array;

  constructor(width: number, height: number) {
    this.width = this.cols = this.pixelW = Math.max(8, Math.floor(width));
    this.height = this.rows = this.pixelH = Math.max(8, Math.floor(height));
    this.pixels = new Uint32Array(this.width * this.height);
  }
  clear(color: number): void { this.pixels.fill(color); }
  fill(color: number): void { this.clear(color); }
  pixel(x: number, y: number, color: number): void { this.setPixel(x, y, color); }
  setPixel(x: number, y: number, color: number): void {
    x = Math.floor(x); y = Math.floor(y);
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) this.pixels[y * this.width + x] = color;
  }
  getPixel(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return this.pixels[Math.floor(y) * this.width + Math.floor(x)]!;
  }
  rect(x: number, y: number, w: number, h: number, color: number): void { this.fillRect(x, y, w, h, color); }
  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w)), y1 = Math.min(this.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) this.pixels.fill(color, yy * this.width + x0, yy * this.width + x1);
  }
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    let ax = Math.round(x0), ay = Math.round(y0), bx = Math.round(x1), by = Math.round(y1);
    const dx = Math.abs(bx - ax), sx = ax < bx ? 1 : -1, dy = -Math.abs(by - ay), sy = ay < by ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(ax, ay, color);
      if (ax === bx && ay === by) break;
      const e2 = err * 2;
      if (e2 >= dy) { err += dy; ax += sx; }
      if (e2 <= dx) { err += dx; ay += sy; }
    }
  }
  resize(_cols: number, _rows: number): void { /* logical cartridges have a fixed viewport */ }
  invalidate(): void { /* host target owns frame history */ }
  encode(_screenTop: number): string { return ''; }
  disposeSeq(): string { return ''; }

  blit(target: PixelTarget, matte = 0x090a0e): void {
    target.fill(matte);
    const scale = Math.min(target.pixelW / this.width, target.pixelH / this.height);
    const dw = Math.max(1, Math.floor(this.width * scale));
    const dh = Math.max(1, Math.floor(this.height * scale));
    const ox = Math.floor((target.pixelW - dw) / 2), oy = Math.floor((target.pixelH - dh) / 2);
    for (let y = 0; y < dh; y++) {
        // Sample pixel centers. Edge-based floor sampling biases shrunken sprites toward their
        // top-left edge and makes equal grid cells alternate between one and two output pixels.
        const sy = Math.min(this.height - 1, Math.floor((y + 0.5) * this.height / dh));
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(this.width - 1, Math.floor((x + 0.5) * this.width / dw));
        target.setPixel(ox + x, oy + y, this.pixels[sy * this.width + sx]!);
      }
    }
  }
}
