import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arcade, BUILTIN_GAMES } from '../../src/platform/arcade.ts';
import { BrailleTarget } from '../../src/render/braille.ts';
import { appendSignal } from '../../src/bridge/signal.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('three built-in cartridges cover action, grid, and falling blocks', () => {
  assert.deepEqual(BUILTIN_GAMES.map((g) => g.manifest.id), ['stick-slash', 'snake', 'blocks']);
  assert.ok(BUILTIN_GAMES.every((g) => g.manifest.apiVersion === 1));
});

test('Tab cycles cartridges through the shared host', () => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  assert.match(a.hud().left, /火柴快斩/);
  a.feed(Uint8Array.of(9)); assert.match(a.hud().left, /贪吃蛇/);
  a.feed(Uint8Array.of(9)); assert.match(a.hud().left, /落块/);
});

test('all cartridges render through the portable target', () => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  const target = new BrailleTarget(60, 12);
  for (let game = 0; game < 3; game++) {
    a.advance(1000); a.advance(1040); a.render(target);
    assert.notEqual(target.encode(2), '', `cartridge ${game} did not render`);
    a.feed(Uint8Array.of(9)); target.invalidate();
  }
});

test('all built-ins have a legible two-row micro composition', () => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  const target = new BrailleTarget(40, 2);
  for (let game = 0; game < 3; game++) {
    a.advance(2000); a.advance(2040); a.render(target, 'micro');
    assert.notEqual(target.encode(2), '', `micro cartridge ${game} did not render`);
    a.feed(Uint8Array.of(9)); target.invalidate();
  }
});

function fullMicroFrame(arcade: Arcade, target: BrailleTarget): string {
  target.invalidate();
  arcade.render(target, 'micro');
  return target.encode(1);
}

test('primary action changes the very next rendered micro frame', () => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  const target = new BrailleTarget(40, 2);
  a.advance(1000);
  const idle = fullMicroFrame(a, target);
  a.feed(Uint8Array.of(0x6a)); // j
  a.advance(1017);
  const windup = fullMicroFrame(a, target);
  assert.notEqual(windup, idle, 'J was accepted but the player silhouette did not react on the next frame');
});

test('two-row diff output stays lightweight enough for an SSH session', () => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  const target = new BrailleTarget(40, 2);
  let now = 1000;
  for (let game = 0; game < 3; game++) {
    let bytes = 0, peak = 0;
    target.invalidate();
    for (let frame = 0; frame < 180; frame++) {
      if (frame % 31 === 0) a.feed(Uint8Array.of(0x6a));
      if (frame % 47 === 0) a.feed(Uint8Array.of(0x64));
      now += 67; // 15fps: the SSH profile's actual cadence
      a.advance(now); a.render(target, 'micro');
      const encoded = target.encode(10);
      const size = Buffer.byteLength(encoded);
      bytes += size; peak = Math.max(peak, size);
    }
    assert.ok(bytes / 180 < 250, `cartridge ${game}: average diff grew to ${Math.round(bytes / 180)} bytes/frame`);
    assert.ok(peak < 600, `cartridge ${game}: a frame grew to ${peak} bytes`);
    a.feed(Uint8Array.of(9));
  }
});

test('task completion is silent, persistent in standby, and cleared when viewed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const a = new Arcade(file);
  try {
    appendSignal('done', file);
    a.advance(1000);
    for (let i = 1; i <= 8; i++) a.advance(1000 + i * 17);
    assert.equal(a.takeAlert(), '', '空串是宿主切回 CLI 的无声事件，不应包含响铃或通知序列');
    assert.equal(a.hud().urgent, true);
    assert.match(a.hud().short, /任务完成/);
    a.resume();
    assert.equal(a.hud().urgent, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
