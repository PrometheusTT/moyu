import type { PixelTarget } from '../render/target.ts';
import type { PixelCanvas } from './types.ts';

// Linear-light coverage, with bounded lookup tables instead of pow() in the raster loop.
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const s = i / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});
const SRGB = Uint8Array.from({ length: 4097 }, (_, i) => {
  const l = i / 4096;
  return Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
});

export function blendCoverage(bg: number, fg: number, coverage: number): number {
  if (coverage <= 0) return bg;
  if (coverage >= 1) return fg;
  let color = 0;
  for (const shift of [16, 8, 0]) {
    const b = LINEAR[(bg >> shift) & 255]!, f = LINEAR[(fg >> shift) & 255]!;
    color |= SRGB[Math.round((b + (f - b) * coverage) * 4096)]! << shift;
  }
  return color;
}

/** Draw straight into the host's device framebuffer. No intermediate resampling. */
export class NativePixelCanvas implements PixelCanvas {
  private readonly target: PixelTarget;
  constructor(target: PixelTarget) { this.target = target; }
  get width(): number { return this.target.pixelW; }
  get height(): number { return this.target.pixelH; }
  clear(color: number): void { this.target.fill(color); }
  pixel(x: number, y: number, color: number): void {
    if (!Number.isFinite(x + y)) return;
    x = Math.floor(x); y = Math.floor(y);
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.target.setPixel(x, y, color);
  }
  rect(x: number, y: number, w: number, h: number, color: number): void {
    if (!Number.isFinite(x + y + w + h) || w <= 0 || h <= 0) return;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w)), y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 > x0 && y1 > y0) this.target.fillRect(x0, y0, x1 - x0, y1 - y0, color);
  }
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    this.stroke(x0, y0, x1, y1, 0.5, color);
  }
  circle(x: number, y: number, radius: number, color: number): void {
    this.stroke(x, y, x, y, radius, color);
  }
  stroke(ax: number, ay: number, bx: number, by: number, radius: number, color: number): void {
    if (!Number.isFinite(ax + ay + bx + by + radius) || radius <= 0) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 0.5));
    const x1 = Math.min(this.width - 1, Math.ceil(Math.max(ax, bx) + radius + 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius - 0.5));
    const y1 = Math.min(this.height - 1, Math.ceil(Math.max(ay, by) + radius + 0.5));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = px - ax - t * dx, ey = py - ay - t * dy;
      const distance = Math.sqrt(ex * ex + ey * ey) - radius;
      if (distance >= 0.5) continue;
      // Quantized edge coverage is stable from frame to frame and compresses efficiently.
      const coverage = Math.min(1, Math.round((0.5 - distance) * 16) / 16);
      if (coverage <= 0) continue;
      this.target.setPixel(x, y, coverage >= 1 ? color : blendCoverage(this.target.getPixel(x, y), color, coverage));
    }
  }
}
