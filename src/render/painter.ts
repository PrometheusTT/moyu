/**
 * 画笔 —— 在**虚拟坐标**里作画，落到任意档位的像素上。
 *
 * ## 为什么要有虚拟坐标这一层
 *
 * 像素档的分辨率跟着终端的格像素尺寸走：同样 2 行的条，视网膜屏是 68 个设备像素高，
 * 非视网膜是 34，八分块档是 8，半块档是 4。如果直接把设备像素喂给模拟，**视网膜用户
 * 的世界会比别人高一倍** —— 跳跃高度、走路速度、身高全都跟字号绑在一起，手感没法调。
 *
 * 所以模拟永远跑在一个**固定虚拟高度**上（条形 = 44），作画时统一乘
 * `k = 设备高 / 虚拟高`。物理、碰撞、波次全部留在虚拟空间里，`core/` 继续零 I/O 可无头单测。
 *
 * 缩放**必须是各向同性的**（一个 `k`，不是 `kx`/`ky`）：两个方向不同的话头会变成椭圆、
 * 斜着的四肢角度全错，比分辨率低更难认。代价是虚拟宽度由高度反推出来
 * （`vw = pixelW / k`），宿主要拿 `p.vw` 去 `world.resize`，不能自己算一个。
 *
 * ## 为什么图元是胶囊而不是 Bresenham 线
 *
 * 老的 `lineW` 是"沿法线再画 w-1 条 Bresenham 线"，在 1 像素宽时没问题，但 4 像素宽的
 * 斜线会**留出对角缝**（每条线各自走整数格，相邻两条错开一格就漏光），而且端点是平的 ——
 * 肩、肘、髋三处接头会出现缺口。改成"到线段的距离 ≤ 半径"的填充：天然圆头圆尾、
 * 天然无缝、天然可以任意粗。
 *
 * 半径下限**夹在 0.5 设备像素**：`k = 1`、笔宽算出来接近 0 的时候（半块档的 3 像素火柴人）
 * 它退化成一条恰好连通的 1 像素线 —— 也就是保底档现在的样子，不会因为换了图元变糊。
 */

import type { PixelTarget } from './target.ts';

export type Painter = {
  readonly t: PixelTarget;
  /** 设备像素 / 虚拟像素。 */
  readonly k: number;
  /** 虚拟画布尺寸。**这两个数就是要喂给 `World.resize` 的那两个。** */
  readonly vw: number;
  readonly vh: number;
};

/** 按"虚拟高度 = vh"给 target 配一支画笔。 */
export function painterFor(t: PixelTarget, vh: number): Painter {
  const k = t.pixelH / Math.max(1, vh);
  return { t, k, vw: Math.max(8, Math.floor(t.pixelW / k)), vh: Math.max(2, vh) };
}

/**
 * 条形形态的虚拟世界高度。
 *
 * 模拟**不能**直接跑在设备像素上：那样视网膜用户的世界会比别人高一倍，手感和字号绑死。
 * 所以世界永远是 44 个虚拟像素高，屏幕上有多少像素只决定 `k`。44 这个数是反推出来的 ——
 * `World.resize` 按"地面以上可用高度"算身高，44 给出 `fh = 26`、`head = 13`、跳跃顶点
 * 正好 13 像素（头永远不出条）。换成别的数要重新验 `test/game/strip.test.ts` 里那几条不变量。
 *
 * 半块档不用它：那一档一共只有 4 个像素行，`k = 4/44` 会把整个世界压成亚像素。
 * 它只能让世界等于画布本身（`k = 1`），也就是"看不出是人"的那一档 —— 这正是要往上爬的原因。
 */
export const STRIP_VH = 44;

/** 按档位给 target 配画笔：像素档跑固定虚拟高度，半块档退化成 `k = 1`。 */
export function stripPainter(t: PixelTarget): Painter {
  return painterFor(t, t.tier === 'graphics' ? STRIP_VH : t.pixelH);
}

/** 设备像素半径：虚拟半径 × k，加上描边的额外设备像素，夹在 0.5 以上。 */
function devR(p: Painter, r: number, extra: number): number {
  return Math.max(0.5, r * p.k + extra);
}

export function clear(p: Painter, color: number): void {
  p.t.fill(color);
}

/** 实心矩形，虚拟坐标**半开区间** `[x0,x1) × [y0,y1)`。 */
export function rect(p: Painter, x0: number, y0: number, x1: number, y1: number, color: number): void {
  const ax = Math.max(0, Math.round(Math.min(x0, x1) * p.k));
  const bx = Math.min(p.t.pixelW, Math.round(Math.max(x0, x1) * p.k));
  const ay = Math.max(0, Math.round(Math.min(y0, y1) * p.k));
  const by = Math.min(p.t.pixelH, Math.round(Math.max(y0, y1) * p.k));
  if (bx > ax && by > ay) p.t.fillRect(ax, ay, bx - ax, by - ay, color);
}

/**
 * 整幅宽的横带，虚拟行 `[y0, y1)`。背景就是几条这个 —— 相邻两带共用边界，
 * 所以取整之后既不留缝也不重叠。
 */
export function band(p: Painter, y0: number, y1: number, color: number): void {
  const ay = Math.max(0, Math.round(y0 * p.k));
  const by = Math.min(p.t.pixelH, Math.round(y1 * p.k));
  if (by > ay) p.t.fillRect(0, ay, p.t.pixelW, by - ay, color);
}

/** 一个虚拟像素。`k = 1` 时就是一个设备像素（血点、污渍这种）。 */
export function dot(p: Painter, x: number, y: number, color: number): void {
  rect(p, Math.floor(x), Math.floor(y), Math.floor(x) + 1, Math.floor(y) + 1, color);
}

/** 胶囊：以 `r` 为半径、连接两点的圆头粗线。`extra` 是描边用的额外设备像素。 */
export function stroke(
  p: Painter, x0: number, y0: number, x1: number, y1: number,
  r: number, color: number, extra = 0,
): void {
  const ax = (x0 + 0.5) * p.k;
  const ay = (y0 + 0.5) * p.k;
  const bx = (x1 + 0.5) * p.k;
  const by = (y1 + 0.5) * p.k;
  if (!Number.isFinite(ax + ay + bx + by)) return;      // 姿态里出现 NaN 时别把整帧废掉
  const R = devR(p, r, extra);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const lo = Math.max(0, Math.floor(Math.min(ax, bx) - R));
  const hi = Math.min(p.t.pixelW - 1, Math.ceil(Math.max(ax, bx) + R));
  const top = Math.max(0, Math.floor(Math.min(ay, by) - R));
  const bot = Math.min(p.t.pixelH - 1, Math.ceil(Math.max(ay, by) + R));
  const R2 = R * R + 1e-6;
  for (let y = top; y <= bot; y++) {
    const py = y + 0.5;
    for (let x = lo; x <= hi; x++) {
      const px = x + 0.5;
      // 点到线段的距离²。len2 = 0（退化成一点）时就是到端点的距离。
      let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - (ax + dx * t);
      const qy = py - (ay + dy * t);
      if (qx * qx + qy * qy <= R2) p.t.setPixel(x, y, color);
    }
  }
}

/** 实心圆（头）。 */
export function disc(p: Painter, cx: number, cy: number, r: number, color: number, extra = 0): void {
  stroke(p, cx, cy, cx, cy, r, color, extra);
}

/**
 * 带厚度的圆弧（刀光）。`w` 是**设备像素**厚度。
 *
 * 按环带填充而不是沿弧采样：采样在半径大、厚度大的时候要么留缝要么重复画几千次，
 * 环带只在一个薄壳里做角度判断，成本和弧长成正比而不是和面积成正比。
 */
export function arcStroke(
  p: Painter, cx: number, cy: number, r: number,
  a0: number, a1: number, w: number, color: number,
): void {
  const X = (cx + 0.5) * p.k;
  const Y = (cy + 0.5) * p.k;
  const R = r * p.k;
  if (!Number.isFinite(X + Y + R) || R < 0.5) return;
  const hw = Math.max(0.5, w) / 2;
  const inner = Math.max(0, R - hw);
  const outer = R + hw;
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  const i2 = inner * inner;
  const o2 = outer * outer;
  const x0 = Math.max(0, Math.floor(X - outer));
  const x1 = Math.min(p.t.pixelW - 1, Math.ceil(X + outer));
  const y0 = Math.max(0, Math.floor(Y - outer));
  const y1 = Math.min(p.t.pixelH - 1, Math.ceil(Y + outer));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - Y;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - X;
      const d2 = dx * dx + dy * dy;
      if (d2 < i2 || d2 > o2) continue;
      // atan2 只对通过半径筛的那一薄层像素算 —— 这是这个循环便宜的原因。
      const a = Math.atan2(dy, dx);
      if ((a >= lo && a <= hi) || (a + TAU >= lo && a + TAU <= hi) || (a - TAU >= lo && a - TAU <= hi)) {
        p.t.setPixel(x, y, color);
      }
    }
  }
}

const TAU = Math.PI * 2;
