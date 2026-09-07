import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/core/world.ts';
import { poseAir, poseHurt, poseIdle, poseSlash, segments } from '../../src/core/stick.ts';
import { GraphicsTarget } from '../../src/render/graphics.ts';
import { NativePixelCanvas, blendCoverage } from '../../src/platform/pixel-canvas.ts';
import { interpolateFighter, paintPixelWorld, pixelCamera, PIXEL_PALETTES, snapshotFighters } from '../../src/render/pixel-scene.ts';
import { PixelSample } from '../../src/platform/pixel-sample.ts';

test('coverage blends in linear light and preserves exact endpoint colors', () => {
  assert.equal(blendCoverage(0, 0xffffff, 0), 0);
  assert.equal(blendCoverage(0, 0xffffff, 1), 0xffffff);
  assert.equal(blendCoverage(0, 0xffffff, 0.5), 0xbcbcbc);
});

test('native drawing clips fractional geometry and ignores invalid primitives', () => {
  const target = new GraphicsTarget(4, 2, 8, 17), c = new NativePixelCanvas(target);
  c.clear(0);
  c.rect(-10, -10, 12, 12, 0xffffff);
  assert.equal(target.getPixel(0, 0), 0xffffff);
  assert.equal(target.getPixel(1, 1), 0xffffff);
  assert.equal(target.getPixel(2, 2), 0);
  c.clear(0);
  c.stroke(-5, -5, 12.3, 12.6, 0.9, 0xffffff);
  const colors = new Set<number>();
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) colors.add(target.getPixel(x, y));
  assert.ok(colors.size > 2, 'subpixel coverage must exist at edges');
  target.encode(1);
  c.stroke(NaN, 0, 5, 5, 1, 0xffffff);
  c.stroke(0, 0, Infinity, 5, 1, 0xffffff);
  c.circle(1, 1, -3, 0xffffff); c.rect(0, 0, -2, 10, 0xffffff); c.pixel(NaN, 3, 0xffffff);
  assert.equal(target.encode(1), '', 'invalid input must not corrupt the framebuffer');
});

test('camera scales with device height, not arena width; doubling density doubles geometry', () => {
  const w = new World(1); w.resize(180, 44);
  const a = pixelCamera(320, 34, w), b = pixelCamera(640, 68, w);
  assert.equal(b.scale, a.scale * 2);
  assert.equal(b.x(w.player.x), a.x(w.player.x) * 2);
  assert.equal(b.y(w.ground), a.y(w.ground) * 2);
  w.w = 1000;
  assert.equal(pixelCamera(320, 34, w).scale, a.scale, 'a wider level must not shrink the hero');
  const zoom = pixelCamera(640, 204, w);
  assert.ok(zoom.scale > b.scale * 2.9, 'expanded mode must actually increase character detail');
});

test('interpolation moves continuously but does not morph discrete combat poses or teleportations', () => {
  const w = new World(1); w.resize(180, 44);
  const previous = { ...w.player, pose: poseIdle(0), x: 30, y: 40 };
  const current = { ...previous, pose: poseIdle(0.1), x: 34 };
  assert.equal(interpolateFighter(current, previous, 0.5).x, 32);
  current.atk = 0.22; current.pose = poseSlash(0.35);
  assert.deepEqual(interpolateFighter(current, previous, 0.5).pose, current.pose);
  current.hurt = 0.2; current.pose = poseHurt(1);
  assert.deepEqual(interpolateFighter(current, previous, 0.5).pose, current.pose);
  current.x = 160;
  assert.equal(interpolateFighter(current, previous, 0).x, current.x);
});

test('standing and airborne heads remain inside the two-row pixel canvas', () => {
  const w = new World(1); w.resize(180, 44);
  const camera = pixelCamera(640, 68, w);
  const apex = w.jumpV ** 2 / (2 * w.fh * 26);
  for (const [air, pose] of [[false, poseIdle(0)], [true, poseAir(true)], [true, poseAir(false)],
    [true, poseSlash(0.2)], [true, poseHurt(1)]] as const) {
    const head = segments({ ...w.player, y: w.ground - (air ? apex : 0), pose }).find(s => s.part === 'head')!;
    assert.ok(camera.y(head.y0 - head.r) >= 0.5, 'head lost at jump apex');
    assert.ok(camera.y(head.y0 + head.r) < 68);
  }
});

test('native scene fills the strip and leaves state unchanged in both themes', () => {
  const w = new World(1); w.resize(180, 44); w.player.pose = poseSlash(0.35);
  const before = JSON.stringify(w), previous = snapshotFighters(w);
  for (const theme of ['dark', 'light'] as const) {
    const t = new GraphicsTarget(40, 2, 16, 34);
    paintPixelWorld(new NativePixelCanvas(t), w, { view: 'micro', theme, interpolation: 0.5 }, previous);
    const p = PIXEL_PALETTES[theme], y = Math.floor(pixelCamera(640, 68, w).y(w.ground));
    assert.equal(t.getPixel(0, 0), p.bg); assert.equal(t.getPixel(639, 0), p.bg);
    assert.equal(t.getPixel(0, y), p.floor); assert.equal(t.getPixel(639, y), p.floor);
    let hero = 0, blade = 0;
    for (let y = 0; y < 68; y++) for (let x = 0; x < 640; x++) {
      if (t.getPixel(x, y) === p.hero) hero++;
      if (t.getPixel(x, y) === p.blade) blade++;
    }
    assert.ok(hero > 70); assert.ok(blade > 5);
  }
  assert.equal(JSON.stringify(w), before);
});

test('deterministic A/B uses the same simulation and reset reproduces exact output', () => {
  const sample = new PixelSample(), t = new GraphicsTarget(40, 2, 8, 17);
  for (let i = 0; i < 80; i++) sample.step();
  const state = JSON.stringify(sample.world);
  sample.render(t, false, 'dark'); t.invalidate(); const initial = t.encode(1);
  sample.render(t, true, 'dark');
  assert.equal(JSON.stringify(sample.world), state);
  assert.notEqual(t.encode(1), initial);
  sample.reset(); for (let i = 0; i < 80; i++) sample.step();
  sample.render(t, false, 'dark'); t.invalidate(); assert.equal(t.encode(1), initial);
});
