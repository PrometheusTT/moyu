import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fighter } from '../../src/core/world.ts';
import { BrailleTarget } from '../../src/render/braille.ts';
import { LogicalCanvas } from '../../src/platform/canvas.ts';
import { drawMicroFighter, microPoseFor, MICRO_FIGHTER, type MicroFighterPose } from '../../src/platform/micro-sprites.ts';
import { BUILTIN_GAMES } from '../../src/platform/arcade.ts';

const BG = 0x090a0e, BODY = 0xecf0f8, BLADE = 0xa67c00;

function fighter(overrides: Partial<Fighter> = {}): Fighter {
  return {
    kind: 'player', x: 40, y: 20, vx: 0, vy: 0, h: 12, face: 1, onGround: true,
    hp: 4, walk: 0, anim: 0, atk: -1, atkHit: false, atkQueued: false, hurt: 0,
    land: 0, invuln: 0, windup: -1, cool: 0, speed: 20, pose: {
      lean: 0, armA: 0, elbowA: 0, armB: 0, elbowB: 0, hipA: 0, kneeA: 0,
      hipB: 0, kneeB: 0, blade: 0, crouch: 0,
    }, armed: true, ...overrides,
  };
}

function glyphSignature(pose: MicroFighterPose, face: 1 | -1 = 1): string {
  const state: Record<MicroFighterPose, Partial<Fighter>> = {
    idle: {}, runA: { vx: 4, walk: 0.1 }, runB: { vx: 4, walk: 0.7 },
    jump: { onGround: false }, windup: { atk: 0.1 }, strike: { atk: 0.3 },
    recover: { atk: 0.5 }, hurt: { hurt: 1 },
  };
  const canvas = new LogicalCanvas(32, 8);
  canvas.clear(BG);
  drawMicroFighter(canvas, fighter({ ...state[pose], face }), 16, BODY, BLADE);
  // Match the real wrapped-CLI path: transparent terminal background and theme-adaptive player.
  const target = new BrailleTarget(16, 2, { defaultBackground: true, defaultForeground: BODY });
  target.setGlyphStyle('dots');
  canvas.blit(target);
  return target.encode(1)
    .replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replaceAll(/\s/g, '');
}

test('micro fighter keyframes fit eight pixels and include separated limbs', () => {
  for (const [name, rows] of Object.entries(MICRO_FIGHTER)) {
    assert.equal(rows.length, 8, `${name}: must fit the eight logical rows`);
    assert.equal(new Set(rows.map((row) => row.length)).size, 1, `${name}: ragged sprite`);
    const body = rows.flatMap((row, y) => [...row].flatMap((mark, x) => mark === '#' ? [[x, y] as const] : []));
    assert.ok(body.length >= 17, `${name}: silhouette is too thin (${body.length} pixels)`);
    assert.ok(new Set(body.map(([x]) => x)).size >= 6, `${name}: limbs collapse into a vertical line`);
    assert.ok(new Set(body.filter(([, y]) => y >= 6).map(([x]) => x)).size >= 2 || name === 'jump',
      `${name}: grounded pose needs two separated feet`);
  }
});

test('every key action survives Braille quantization as a distinct multi-cell silhouette', () => {
  const signatures = (Object.keys(MICRO_FIGHTER) as MicroFighterPose[]).map((pose) => [pose, glyphSignature(pose)] as const);
  assert.equal(new Set(signatures.map(([, sig]) => sig)).size, signatures.length,
    `two poses collapse to the same terminal glyphs: ${JSON.stringify(signatures)}`);
  for (const [pose, sig] of signatures) assert.ok([...sig].length >= 6, `${pose}: only ${[...sig].length} visible cells remain`);
  assert.ok([...glyphSignature('strike')].length > [...glyphSignature('idle')].length,
    'strike must extend farther than idle after terminal quantization');
});

test('left-facing frames are true mirrors and pose selection has stable action thresholds', () => {
  assert.notEqual(glyphSignature('strike', 1), glyphSignature('strike', -1));
  assert.equal(microPoseFor(fighter({ atk: 0.19 })), 'windup');
  assert.equal(microPoseFor(fighter({ atk: 0.30 })), 'strike');
  assert.equal(microPoseFor(fighter({ atk: 0.50 })), 'recover');
  assert.equal(microPoseFor(fighter({ hurt: 0.1, atk: 0.30 })), 'hurt', 'hurt feedback wins over attack');
  assert.equal(microPoseFor(fighter({ onGround: false })), 'jump');
});

function microPixels(game: ReturnType<(typeof BUILTIN_GAMES)[number]['create']>): Uint32Array {
  const canvas = new LogicalCanvas(80, 8);
  game.renderMicro?.(canvas);
  return Uint32Array.from({ length: 80 * 8 }, (_, i) => canvas.getPixel(i % 80, Math.floor(i / 80)));
}

test('snake turn changes the two-row image without losing its five-segment body', () => {
  const game = BUILTIN_GAMES[1]!.create({ seed: 1, random: () => 0.5 });
  const before = microPixels(game);
  game.update(0.14, { left: false, right: false, up: true, down: false, jump: false, primary: false, secondary: false });
  const after = microPixels(game);
  assert.notDeepEqual(after, before, 'turn input must be visible on the very next snake step');
  const occupied = [...after].filter((p) => p === BODY || p === BLADE).length;
  assert.ok(occupied >= 18, `snake collapsed after turning: only ${occupied} player-colored pixels remain`);
});

function headPixel(game: ReturnType<(typeof BUILTIN_GAMES)[number]['create']>): [number, number] {
  const pixels = microPixels(game);
  const amber = [...pixels].flatMap((p, i) => p === BLADE ? [[i % 80, Math.floor(i / 80)] as [number, number]] : []);
  assert.ok(amber.length > 0, 'snake head is missing');
  return [Math.min(...amber.map(([x]) => x)), Math.min(...amber.map(([, y]) => y))];
}

test('snake accepts at most one turn before each grid movement', () => {
  const game = BUILTIN_GAMES[1]!.create({ seed: 1, random: () => 0.5 });
  const none = { left: false, right: false, up: false, down: false, jump: false, primary: false, secondary: false };
  game.update(0.01, { ...none, up: true });
  game.update(0.01, { ...none, left: true });
  game.update(0.13, none);
  assert.deepEqual(headPixel(game), [31, 3], '先按上再按左，本格只能向上走');

  game.update(0.01, { ...none, down: true });
  game.update(0.13, none);
  assert.deepEqual(headPixel(game), [31, 2], '相对 committed 上方向的反向下必须被拒绝');
});

test('falling block visibly descends before the micro camera begins following it', () => {
  const game = BUILTIN_GAMES[2]!.create({ seed: 1, random: () => 0.5 });
  const ys = (): number[] => [...microPixels(game)].flatMap((p, i) => p === BODY ? [Math.floor(i / 80)] : []);
  const start = Math.min(...ys());
  const down = { left: false, right: false, up: false, down: true, jump: false, primary: false, secondary: false };
  for (let i = 0; i < 4; i++) game.update(0.7, down);
  const moved = Math.min(...ys());
  assert.ok(moved >= start + 3, `fall input moved from row ${start} only to ${moved}`);
});
