import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../../src/shell/regions.ts';
import { GraphicsTarget } from '../../src/render/graphics.ts';
import { Canvas, rgb } from '../../src/render/canvas.ts';
import { stripPainter, type Painter } from '../../src/render/painter.ts';
import { paintWorld } from '../../src/render/scene.ts';
import { sceneForChapter, type SceneTheme } from '../../src/render/theme.ts';
import { World, NO_INTENT, type Intent } from '../../src/core/world.ts';
import { CHAPTER_COUNT } from '../../src/core/chapter.ts';
import type { PixelTarget } from '../../src/render/target.ts';

/**
 * 每章氛围主题的**可读性回归**：background/props/敌人配色一旦掺得过头，就会破坏
 * `legibility.test.ts` 钉死的三条合同 —— 最暗必是描边 KEY、最亮 ≥ 玩家 BONE、BONE 描边隔离。
 * 那个文件走**裸 World（无 scene）**，这个文件专门把 `sceneForChapter(n)` 传进去、跑遍十章，
 * 确保"把剧情画到背景上"没有把人糊进背景里。
 */

const CELL = { w: 16, h: 34 };
const L = (() => {
  const r = computeLayout({ cols: 100, rows: 40, manualGameRows: 2 });
  assert.equal(r.kind, 'split', '100×40 应该能分屏');
  return r.kind === 'split' ? r.layout : null!;
})();

const BONE = rgb(236, 239, 246);
const KEY = rgb(6, 6, 9);
const BLOOD = rgb(214, 34, 46);
const lum = (c: number): number =>
  0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);
const WARMUP = 45;

type Rig = { t: PixelTarget; p: Painter; w: World };
function rig(target: PixelTarget, seed: number): Rig {
  const p = stripPainter(target);
  const w = new World(seed);
  w.resize(p.vw, p.vh);
  for (let i = 0; i < WARMUP; i++) w.step(1 / 60, NO_INTENT);
  return { t: target, p, w };
}
const gfx = (seed: number): Rig => rig(new GraphicsTarget(L.fieldCols, L.gameRows, CELL.w, CELL.h), seed);

function fight(r: Rig, frames: number, scene: SceneTheme): void {
  r.w.taskStart();
  for (let f = 0; f < frames; f++) {
    const move: -1 | 0 | 1 = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
    const i: Intent = { move, jump: f % 53 === 0, slash: f % 11 === 0 };
    r.w.step(1 / 60, i);
    r.w.step(1 / 60, { move, jump: false, slash: false });
  }
  paintWorld(r.p, r.w, scene);
}

test('sceneForChapter：十章各有主题、确定、越界安全、且不碰 World', () => {
  const w = new World(1);
  const rngBefore = w.rng.snapshot();
  for (let ch = 1; ch <= CHAPTER_COUNT; ch++) {
    const a = sceneForChapter(ch);
    const b = sceneForChapter(ch);
    assert.equal(a, b, `第 ${ch} 章主题对同一入参应恒等（同一冻结对象）`);
    assert.ok(a.props.length > 0, `第 ${ch} 章应有布景`);
    assert.ok(a.skyMix > 0 && a.skyMix < 0.5, `第 ${ch} 章天空掺色比例应克制`);
  }
  // 越界回落到第 1 章，绝不 undefined。
  assert.equal(sceneForChapter(0), sceneForChapter(1));
  assert.equal(sceneForChapter(99), sceneForChapter(1));
  assert.equal(w.rng.snapshot(), rngBefore, 'sceneForChapter 不该动 World 的随机流');
});

test('传入每章主题后仍守住可读性：最暗=描边、最亮≥主角、BONE 描边不贴中间调', () => {
  for (let ch = 1; ch <= CHAPTER_COUNT; ch++) {
    const scene = sceneForChapter(ch);
    for (const frames of [0, 300]) {
      const g = gfx(7 + ch);
      if (frames === 0) paintWorld(g.p, g.w, scene); else fight(g, frames, scene);
      let lo = 0xffffff, hi = 0;
      const bad: string[] = [];
      for (let y = 0; y < g.t.pixelH; y++) {
        for (let x = 0; x < g.t.pixelW; x++) {
          const c = g.t.getPixel(x, y);
          if (lum(c) < lum(lo)) lo = c;
          if (lum(c) > lum(hi)) hi = c;
          if (c !== BONE) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= g.t.pixelW || ny >= g.t.pixelH) continue;
            const n = g.t.getPixel(nx, ny);
            if (n === BLOOD) continue;
            const l = lum(n);
            if (l > 8 && l < 90) bad.push(`(${x},${y})→(${nx},${ny}) 亮度 ${l.toFixed(1)}`);
          }
        }
      }
      const at = `第 ${ch} 章 第 ${frames} 帧`;
      assert.equal(lo, KEY, `${at}：最暗像素 #${lo.toString(16).padStart(6, '0')} 不是描边色（背景掺色掺过头了）`);
      assert.ok(lum(hi) >= lum(BONE), `${at}：最亮像素亮度 ${lum(hi).toFixed(1)} < 主角 ${lum(BONE).toFixed(1)}（布景/背景压过角色）`);
      assert.deepEqual(bad.slice(0, 3), [], `${at}：${bad.length} 处描边破口 —— 布景贴到了角色边缘`);
    }
  }
});

test('半块档传入主题不炸、仍能读出主角', () => {
  // 半块档背景是横向色带（帧差敏感）；这里只验证掺色/布景不破坏主角可读性。
  const scene = sceneForChapter(4);
  const half = rig(new Canvas(L.fieldCols, L.gameRows), 7);
  paintWorld(half.p, half.w, scene);
  let bone = 0;
  for (let y = 0; y < half.t.pixelH; y++) {
    for (let x = 0; x < half.t.pixelW; x++) if (half.t.getPixel(x, y) === BONE) bone++;
  }
  assert.ok(bone > 0, '半块档传入主题后一个 BONE 都扫不到');
});

test('像素档传入主题后仍留在字节预算内、且不分块（布景是矮剪影，不打断天空渐变）', () => {
  // graphics.test.ts 走裸 World，测不到 scene 路径；布景一旦画成通天大柱，会把逐设备行的
  // 平滑天空渐变切碎、顶爆每帧字节并分块。这条守住真机（视网膜 16×34）那一档的实测预算。
  for (let ch = 1; ch <= CHAPTER_COUNT; ch++) {
    const scene = sceneForChapter(ch);
    const t = new GraphicsTarget(40, 2, 16, 34);
    const p = stripPainter(t);
    const w = new World(0x1234abcd);
    w.resize(p.vw, p.vh);
    w.taskStart();
    let total = 0, peak = 0, chunks = 0;
    for (let f = 0; f < 300; f++) {
      const move: -1 | 0 | 1 = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
      w.step(1 / 60, { move, jump: f % 53 === 0, slash: f % 11 === 0 });
      w.step(1 / 60, { move, jump: false, slash: false });
      paintWorld(p, w, scene);
      const s = t.encode(1);
      total += t.lastBytes;
      if (t.lastBytes > peak) peak = t.lastBytes;
      chunks = Math.max(chunks, (s.match(/\x1b_G/g) ?? []).length);
    }
    const avg = total / 300;
    const at = `第 ${ch} 章`;
    // 裸档基线是 avg 1.95 / peak 3.22 KB；主题最多再加一档余量，留在 2.6 / 4.6 里。
    assert.ok(avg < 2.6 * 1024, `${at}：平均 ${(avg / 1024).toFixed(2)} KB/帧，超出预算（布景太重）`);
    assert.ok(peak < 4.6 * 1024, `${at}：最差 ${(peak / 1024).toFixed(2)} KB/帧，超出预算`);
    assert.equal(chunks, 1, `${at}：真机战斗帧分了 ${chunks} 块 —— 布景打断了天空渐变`);
  }
});
