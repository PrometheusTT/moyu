/**
 * M0 的占位场景：静止背景 + 一条滑动的彩条 + 一群弹跳方块。
 *
 * 它存在的唯一目的是给外壳一个**真实的负载**去驱动。所以"真实"是硬要求：这里的画面特征
 * 必须和最终游戏一致（静态背景 + 少量移动精灵），否则 bench 打出来的字节数就是假数据，
 * 拿它做性能回归的基线会把人骗了。
 *
 * 刻意遵守两条最终版的硬性约束：
 *   - **限定调色板**。颜色都从 `PALETTE` 里取，不做逐像素插值 —— 游程压缩要靠
 *     "相邻格子同色"，每个像素一个独立颜色的话压缩率直接归零（实测差 50 倍）。
 *   - **背景静止**。天空和地面每帧写入同样的值，于是 diff 把它们整片剔掉。
 *
 * 另外提供 `paintStress()`：全宽逐帧滚动的彩带，**故意**让每帧都有一大片脏区。
 * 它不是场景候选，是给 `moyu bench --stress` 用的上界测量 —— 知道最坏情况有多坏，
 * 才知道离墙还有多远。
 *
 * M1 会用真的世界状态替换掉这个文件。
 */

import { rgb } from '../render/canvas.ts';
import type { PixelTarget } from '../render/target.ts';

/** 天空的 4 段渐变 + 地面 + 精灵。限定调色板是硬性要求，不是省事。 */
const SKY = [rgb(12, 14, 30), rgb(20, 22, 46), rgb(30, 30, 62), rgb(44, 38, 74)] as const;
const GROUND = rgb(58, 44, 36);
const GROUND_TOP = rgb(96, 132, 60);
const BALL = rgb(250, 230, 120);
const BALL_EDGE = rgb(210, 120, 60);

const HUES: readonly number[] = [
  rgb(220, 60, 70), rgb(230, 130, 50), rgb(235, 200, 70), rgb(120, 200, 80),
  rgb(70, 190, 180), rgb(80, 130, 230), rgb(140, 100, 220), rgb(210, 90, 170),
];

/** 地面厚度（像素行）。 */
const GROUND_H = 4;
/** 滑动彩条的宽度（像素列）。 */
const BAR_W = 30;
/** 弹跳方块的个数。对齐计划里 bench 场景的"12 个移动精灵"。 */
const SPRITES = 10;

/**
 * 画一帧。`t` 是帧号 —— 用帧号而不是墙上时间，动画就是确定性的，
 * bench 跑出来的字节数每次都一样，性能回归才能被看见。
 */
export function paintScene(cv: PixelTarget, t: number): void {
  const w = cv.pixelW;
  const h = cv.pixelH;
  if (w < 1 || h < 1) return;
  const groundTop = paintBackground(cv, w, h);

  // ── 彩条：一条整体横向滑动的实心色条 ──────────────────────────────
  //
  // 关键是**整条一起动**，而不是让每一列各自换色。整体平移时只有条的前后沿
  // 附近的格子会变，diff 把条的内部剔干净；逐列换色的话整条每帧全脏
  // （那就是 paintStress 干的事，字节数差一个数量级）。
  const barY = Math.max(0, Math.floor(groundTop * 0.52));
  const barH = Math.max(2, Math.floor(groundTop * 0.14));
  const span = w + BAR_W;
  const barX = ((t * 2) % span) - BAR_W;
  const hue = HUES[Math.floor(((t * 2) / span) % HUES.length)]!;
  for (let x = Math.max(0, barX); x < Math.min(w, barX + BAR_W); x++) {
    for (let y = barY; y < Math.min(groundTop, barY + barH); y++) {
      cv.setPixel(x, y, hue);
    }
  }

  // ── 弹跳方块：抛物线，落到地面就反弹。M1 的玩家精灵会长在这个位置 ──
  for (let i = 0; i < SPRITES; i++) {
    // 每个精灵一个不同的周期和起始相位，好让脏区分散在整屏而不是聚成一团。
    const period = 72 + i * 11;
    const phase = ((t + i * 17) % period) / period;
    const bounce = 4 * phase * (1 - phase);              // 0..1 的抛物线
    const size = 3;
    const bx = Math.floor((((t * (0.7 + i * 0.13)) + i * 37) % (w + size * 2)) - size);
    const by = Math.floor((groundTop - size) * (1 - bounce));
    const body = i % 3 === 0 ? HUES[i % HUES.length]! : BALL;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const edge = dy === size - 1 || dx === size - 1;
        cv.setPixel(bx + dx, by + dy, edge ? BALL_EDGE : body);
      }
    }
  }
}

/**
 * 病态负载：全宽彩带每帧平移一列，于是整条带子每帧全脏，且每 3 列就要换一次颜色。
 * 用来量上界，不是用来当场景。
 */
export function paintStress(cv: PixelTarget, t: number): void {
  const w = cv.pixelW;
  const h = cv.pixelH;
  if (w < 1 || h < 1) return;
  const groundTop = paintBackground(cv, w, h);

  const stripeY = Math.max(0, Math.floor(groundTop * 0.3));
  const stripeH = Math.max(2, Math.floor(groundTop * 0.4));
  const period = HUES.length * 3;
  const shift = t % period;
  for (let x = 0; x < w; x++) {
    const c = HUES[Math.floor(((x + shift) % period) / 3)]!;
    for (let y = stripeY; y < Math.min(groundTop, stripeY + stripeH); y++) {
      cv.setPixel(x, y, c);
    }
  }
}

/** 4 段天空 + 地面。每帧写同样的值，diff 会把它整片剔掉。返回地面顶边的像素行。 */
function paintBackground(cv: PixelTarget, w: number, h: number): number {
  const groundTop = Math.max(1, h - GROUND_H);
  for (let y = 0; y < h; y++) {
    let color: number;
    if (y >= groundTop) {
      color = y === groundTop ? GROUND_TOP : GROUND;
    } else {
      const band = Math.min(SKY.length - 1, Math.floor((y / Math.max(1, groundTop)) * SKY.length));
      color = SKY[band]!;
    }
    cv.fillRect(0, y, w, 1, color);
  }
  return groundTop;
}
