/**
 * 把 `World` 画到一个 `Painter` 上。渲染层**只读**世界，一个字段都不改 —— 模拟和表现分开，
 * 才能无头跑测试、才能在暂停时反复重画同一帧而不推进战斗。
 *
 * ## 为什么改成对 `Painter` 作画
 *
 * 世界的坐标是**虚拟像素**，画笔按 `k = 设备高 / 虚拟高` 放大到设备像素。像素档下
 * 一个 2 行的条是 68 个设备像素高，而世界仍然只有 44 个虚拟像素高 —— 火柴人在世界里
 * 26 个单位高，画到屏幕上是 40 个设备像素。写死设备像素的话视网膜用户的世界会比别人
 * 高一倍（手感和字号绑在一起），所以这一层的坐标必须是虚拟的。见 `painter.ts`。
 *
 * ## 40 像素上"认得出是人"靠的不是分辨率，是这四件事
 *
 * | | 做法 | 没有它会怎样 |
 * |---|---|---|
 * | 描边 | 每条肢体先用暗色画粗一圈，再画本色（**两趟**，不是逐段描边）| 人和背景之间没有边界，深色背景上整个人糊掉 |
 * | 分部位笔宽 | 躯干 `h/15`、四肢 `h/22`、刀 `h/26`、头 `h*0.115` | 一样粗就是一团铁丝，看不出躯干和四肢的层次 |
 * | 关键姿势保持 | 见 `core/stick.ts` 的 `holdK` —— 段内定格，段间快切 | 30fps 下每个中间帧都看不清，动作糊成一团 |
 * | 拖影 + 命中闪白 | 刀光三层递减亮度 + `hitstop` 时整刀变白加粗 | 小尺寸下没有任何"快"的表达，斩击读不出来 |
 *
 * 描边为什么必须是"两趟"而不是"每段画完描一次"：逐段描边会把后画的那条肢体的暗边
 * 盖在前一条的本色上，胳膊上出现一道黑印。先把所有段的粗暗色铺完，再铺所有段的本色，
 * 暗色只可能出现在整个人的**外缘**。
 *
 * ## 背景：只有半块档还受"必须是横向色带"的约束
 *
 * 半块档是帧间 diff 的，震屏 = 整个世界平移，横条的水平平移**一个字节都不产生**；
 * 加一朵云就变成全屏重绘（实测差 14 倍）。像素档每帧整幅重压，字节由 deflate 决定
 * 而不由"变了多少格"决定 —— 于是渐变、云、竖向震屏在那一档是免费的。这里的分支
 * （`p.t.tier`）就是这条约束的边界：像素档用逐设备行的平滑渐变，半块档保持原样的 4 条色带。
 */

import { rgb } from './canvas.ts';
import { arcStroke, disc, dot, rect, stripPainter, stroke, type Painter } from './painter.ts';
import { bodyOf, type Fighter, type Piece, type World } from '../core/world.ts';
import { segments, type Seg } from '../core/stick.ts';
import type { PixelTarget } from './target.ts';

const SKY = [rgb(12, 13, 18), rgb(17, 18, 25), rgb(23, 24, 33), rgb(30, 31, 42)] as const;
const GROUND_HI = rgb(64, 66, 82);
const GROUND = rgb(28, 27, 35);
const GROUND_LO = rgb(20, 19, 25);
/** 玩家：最亮的那个人。"一眼能找到自己"是这个 demo 的基本可用性要求。 */
const BONE = rgb(236, 239, 246);
/** 杂兵：明显暗一档，人多也不会和玩家混在一起。 */
const FOE = rgb(146, 152, 168);
/** 描边色。比最暗的天空（12,13,18）还暗一点 —— 它要在任何背景上都是"边"。 */
const KEY = rgb(6, 6, 9);
/** 飞在空中的断肢 */
const PIECE_AIR = rgb(198, 202, 214);
/** 落地躺平的断肢 —— 尸堆要退到背景里去，不然满屏白线看不清战斗 */
const PIECE_DEAD = rgb(92, 95, 108);
const STEEL = rgb(255, 255, 255);
const TRAIL = rgb(196, 226, 255);
const BLOOD = rgb(214, 34, 46);
const STAIN = rgb(104, 18, 26);
const ACCENT = rgb(228, 56, 52);
const WAVE = rgb(255, 244, 200);

/** 分部位笔宽（**半径** = 身高 × 这个数）。计划里写的 `h/11` 是直径，减半才是半径。 */
const R_LIMB = 1 / 22;
const R_TORSO = 1 / 15;
const R_BLADE = 1 / 26;

/**
 * 描边比本色粗多少（设备像素）。只在本色笔够粗时才描 ——
 * 半块档一条肢体本来就只有 1 个像素宽，描一圈等于把人涂黑。
 */
const KEYLINE = 1;
/** 本色笔的设备半径小于这个数就不描边。 */
const KEYLINE_MIN_R = 1.1;

/** 一帧。`p.vw × p.vh` 必须已经和 `w.w × w.h` 对上（app 负责在 resize 时同步）。 */
export function paintWorld(p: Painter, w: World): void {
  const dx = w.shakeX;
  const dy = w.shakeY;
  const dim = w.phase === 'paused' ? 0.45 : 1;
  const lift = w.flash > 0 ? Math.min(1, w.flash * 6) : 0;

  paintBackdrop(p, w, dy, dim, lift);

  const sr = speckR(p);
  for (const key of w.stains) {
    speck(p, (key % 4096) + dx, Math.floor(key / 4096) + dy, sr, tint(STAIN, dim));
  }

  // 躺平的先画，飞着的后画 —— 空中的断肢盖住尸堆，视觉焦点才在正在发生的事上。
  for (const q of w.pieces) if (q.rest) paintPiece(p, w, q, dx, dy, tint(PIECE_DEAD, dim));
  for (const q of w.pieces) if (!q.rest) paintPiece(p, w, q, dx, dy, tint(q.mine ? BONE : PIECE_AIR, dim));

  for (const e of w.enemies) {
    // 起手的杂兵整个人变红：这是它唯一的预警，看不见就等于偷袭。
    const c = e.windup >= 0 ? mix(FOE, ACCENT, 0.55 + 0.45 * Math.sin(e.windup * 40)) : FOE;
    paintFighter(p, w, e, dx, dy, tint(c, dim), false);
  }

  if (w.respawn <= 0) {
    const f = w.player;
    // 无敌帧闪烁：亮/暗交替。看得出"现在打不到我"，不然会觉得判定不准。
    const blink = f.invuln > 0 && Math.floor(f.invuln * 18) % 2 === 0;
    paintFighter(p, w, f, dx, dy, tint(blink ? FOE : BONE, dim), true);
  }

  for (const s of w.slashes) paintSlash(p, w, s, dx, dy, dim);

  for (const b of w.blood) speck(p, Math.round(b.x) + dx, Math.round(b.y) + dy, sr, BLOOD);

  if (w.waveR !== null) paintWave(p, w, dx, dy);
}

/** 只有一块画布、不需要留着画笔的调用方（`demo` / `bench`）走这个。档位由 target 自己说。 */
export function paintWorldTo(t: PixelTarget, w: World): void {
  paintWorld(stripPainter(t), w);
}

/**
 * 天空 + 地面。
 *
 * 半块档：4 条纯色带 + hline，水平震动零字节（见文件头）。
 * 像素档：逐设备行插值的平滑渐变 —— 一帧整幅重压，渐变不比色带贵，而它让暗色描边
 * 在任何高度上都有对比度可依。
 */
function paintBackdrop(p: Painter, w: World, dy: number, dim: number, lift: number): void {
  const g = w.ground + dy;                       // 地平线（虚拟行）
  const bands = SKY.length;
  const top = mix(SKY[0]!, WAVE, lift * 0.35);
  const bot = mix(SKY[bands - 1]!, WAVE, lift * 0.35);
  if (p.t.tier === 'graphics') {
    const gDev = Math.min(p.t.pixelH, Math.max(0, Math.round(g * p.k)));
    // 一行一次 fillRect：68 次调用，比 43000 次 setPixel 便宜三个数量级。
    for (let y = 0; y < gDev; y++) {
      p.t.fillRect(0, y, p.t.pixelW, 1, tint(mix(top, bot, y / Math.max(1, gDev - 1)), dim));
    }
  } else {
    for (let y = 0; y < w.h && y < g; y++) {
      // 越靠近地平线越亮：地面在下方，光从上面来的话这里该反过来 ——
      // 但"下亮上暗"能把火柴人的轮廓从背景里托出来，可读性优先于物理。
      const i = Math.min(bands - 1, Math.floor((y / Math.max(1, g)) * bands));
      band(p, y, y + 1, tint(mix(SKY[i]!, WAVE, lift * 0.35), dim));
    }
  }
  if (g >= 0 && g < w.h) band(p, g, g + 1, tint(mix(GROUND_HI, WAVE, lift * 0.5), dim));
  if (g + 1 < w.h) band(p, g + 1, Math.min(w.h, g + 3), tint(GROUND, dim));
  if (g + 3 < w.h) band(p, g + 3, w.h, tint(GROUND_LO, dim));
}

/** 一整行（或几行）纯色。虚拟坐标，半开区间。 */
function band(p: Painter, y0: number, y1: number, color: number): void {
  rect(p, 0, Math.max(0, y0), p.vw, Math.min(p.vh, y1), color);
}

/**
 * 一个人。**两趟**：先把所有段按 `r + KEYLINE` 用暗色铺一遍，再按 `r` 铺本色。
 * 逐段描边会在肢体交叠处留下黑印，见文件头。
 */
function paintFighter(p: Painter, w: World, f: Fighter, dx: number, dy: number, color: number, hero: boolean): void {
  const body = bodyOf(f);
  const segs = segments(body);
  const flash = w.hitstop > 0 && f.armed;        // 命中那几帧整刀闪白加粗
  const r = (s: Seg): number => radiusOf(s, body.h, flash);
  // 按**最细的那种笔**（四肢）决定描不描：四肢只有 1 个像素宽时描一圈会把它变成
  // 3 个像素宽的黑块，那一档（半块）宁可不描。
  if (devR(p, body.h * R_LIMB) >= KEYLINE_MIN_R) {
    for (const s of segs) paint1(p, s, dx, dy, r(s), KEY, KEYLINE);
  }
  for (const s of segs) {
    // 刀永远是纯白：屏幕上最亮的东西是即将造成伤害的那条线。
    paint1(p, s, dx, dy, r(s), s.part === 'blade' ? STEEL : color, 0);
    // 红围巾。玩家的第二重识别，而且它会跟着朝向翻 —— 顺带把朝向也说清楚了。
    if (hero && s.part === 'torso') {
      stroke(p, s.x1 + dx, s.y1 + dy, s.x1 + dx - f.face * w.fh * 0.26, s.y1 + dy + w.fh * 0.1,
        body.h * R_LIMB * 0.9, ACCENT);
    }
  }
}

/** 一段。头是圆，其余是带圆头的线段（胶囊）—— 胶囊在肩肘髋处天然接得上，见 `painter.ts`。 */
function paint1(p: Painter, s: Seg, dx: number, dy: number, r: number, color: number, extra: number): void {
  if (s.part === 'head') disc(p, s.x0 + dx, s.y0 + dy, r, color, extra);
  else stroke(p, s.x0 + dx, s.y0 + dy, s.x1 + dx, s.y1 + dy, r, color, extra);
}

/** 分部位笔宽。头的半径由 `segments()` 直接给（它按身高算过了）。 */
function radiusOf(s: Seg, h: number, flash: boolean): number {
  if (s.part === 'head') return s.r;
  if (s.part === 'torso') return h * R_TORSO;
  if (s.part === 'blade') return h * R_BLADE * (flash ? 1.9 : 1);
  return h * R_LIMB;
}

/** 本色笔在设备像素里的半径 —— 用来决定值不值得描边。 */
function devR(p: Painter, r: number): number {
  return r * p.k;
}

/**
 * 一块断肢。计划里的"碎块是肢体形状，不是单像素"就是这里：按 `half` 当半长、
 * 按身高算笔宽画一根带描边的胶囊，`ang` 让它翻滚。
 */
function paintPiece(p: Painter, w: World, q: Piece, dx: number, dy: number, color: number): void {
  const r = q.head ? q.half : Math.max(0.35, w.fh * R_LIMB);
  const key = devR(p, r) >= KEYLINE_MIN_R;
  if (q.head) {
    if (key) disc(p, q.x + dx, q.y + dy, r, KEY, KEYLINE);
    disc(p, q.x + dx, q.y + dy, r, color);
    return;
  }
  const cx = Math.cos(q.ang) * q.half;
  const cy = Math.sin(q.ang) * q.half;
  if (key) stroke(p, q.x - cx + dx, q.y - cy + dy, q.x + cx + dx, q.y + cy + dy, r, KEY, KEYLINE);
  stroke(p, q.x - cx + dx, q.y - cy + dy, q.x + cx + dx, q.y + cy + dy, r, color);
}

/**
 * 刀光。三层递减亮度的残影 —— 小尺寸下这是唯一能读出"快"的手段，而在像素档它是免费的
 * （每帧整幅重压，多画几笔不多花字节）。
 *
 * 层的半径依次收小、亮度依次降低，前缘（`a1` 那头）最亮：眼睛顺着亮度梯度就能读出
 * 挥的方向。`life/max` 衰减时整条弧往前缘收，看起来是拖影在追刀尖。
 */
function paintSlash(p: Painter, w: World, s: World['slashes'][number], dx: number, dy: number, dim: number): void {
  const k = Math.max(0, s.life / s.max);
  const x = s.x + dx;
  const y = s.y + dy;
  const wide = Math.max(0.4, w.fh * R_BLADE * (s.big ? 2.2 : 1.5));
  // 三层：本体（最亮、最外）→ 中层 → 内层（最暗）。收尾阶段只剩本体。
  const layers: Array<[number, number, number]> = [
    [1, 1, k > 0.55 ? 1 : 0.85],
    [0.88, 0.72, 0.55],
    [0.76, 0.5, 0.3],
  ];
  for (const [rf, wf, bright] of layers) {
    if (bright * k <= 0.12) continue;
    // 每层的起点往前缘挪一点：层越里，残影越短 —— 这就是"拖影在追刀尖"。
    const a0 = s.a0 + (s.a1 - s.a0) * (1 - rf * 0.9 + (1 - k) * 0.75);
    const c = mix(TRAIL, STEEL, bright * (k > 0.55 ? 1 : 0.6));
    arcStroke(p, x, y, s.r * rf, a0, s.a1, wide * wf, tint(c, dim * Math.min(1, bright + 0.35)));
  }
}

/** 清屏技的冲击波：两道亮墙从玩家身上往两边推。 */
function paintWave(p: Painter, w: World, dx: number, dy: number): void {
  const r = w.waveR ?? 0;
  for (const side of [-1, 1] as const) {
    const x = Math.round(w.player.x + side * r) + dx;
    for (let i = 0; i < 2; i++) {
      const xi = x + side * i;
      rect(p, xi, dy, xi + 1, w.h + dy, i === 0 ? WAVE : TRAIL);
    }
  }
}

/**
 * 血点 / 血迹的半径。半块档是一个字符半格（`dot`），像素档下那么小的点看不见 ——
 * 按 k 放大成一个小圆。
 */
function speckR(p: Painter): number {
  return p.t.tier === 'graphics' ? 0.45 : 0;
}

function speck(p: Painter, x: number, y: number, r: number, color: number): void {
  if (r <= 0) dot(p, x, y, color);
  else disc(p, x, y, r, color);
}

/** 整体压暗（暂停时用）。只在静止画面上用 —— 它会产生调色板外的颜色。 */
function tint(c: number, k: number): number {
  if (k >= 1) return c;
  const r = Math.round(((c >>> 16) & 255) * k);
  const g = Math.round(((c >>> 8) & 255) * k);
  const b = Math.round((c & 255) * k);
  return rgb(r, g, b);
}

function mix(a: number, b: number, k: number): number {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const r = Math.round(((a >>> 16) & 255) * (1 - k) + ((b >>> 16) & 255) * k);
  const g = Math.round(((a >>> 8) & 255) * (1 - k) + ((b >>> 8) & 255) * k);
  const bl = Math.round((a & 255) * (1 - k) + (b & 255) * k);
  return rgb(r, g, bl);
}
