import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arcade } from '../../src/platform/arcade.ts';
import type { GameInput, GameModule } from '../../src/platform/types.ts';
import { BrailleTarget } from '../../src/render/braille.ts';
import { PlaySurface } from '../../src/platform/surface.ts';

function recorder(micro = true, minRows = 4) {
  const steps: GameInput[] = [];
  const module: GameModule = {
    manifest: { id: 'qa-recorder', name: '测试游戏', version: '1', apiVersion: 1, author: 'QA',
      description: 'QA', entry: 'builtin', viewport: { width: 80, height: 24 },
      display: { micro, minRows }, controls: [{ action: 'primary', label: '砍', keys: ['J'] }], palette: ['#090a0e', '#ecf0f8'] },
    create: () => ({ update: (_dt, input) => steps.push({ ...input }),
      render: c => { c.clear(0x090a0e); c.rect(10, 4, 2, 8, 0xecf0f8); },
      renderMicro: c => { c.clear(0x090a0e); c.rect(10, 1, 2, 6, 0xecf0f8); } }),
  };
  return { game: new Arcade('/tmp/moyu-no-events-qa', [module]), steps };
}

test('help is visible before first input, remains without a timeout, and is removed by a real action', () => {
  const { game, steps } = recorder();
  const surface = new PlaySurface(), target = new BrailleTarget(40, 2);
  let first = surface.render(game, target, 10, 60, 2);
  assert.match(first, /J 砍/); assert.match(first, /Esc 返回/);
  game.advance(1000); game.advance(5000);
  assert.equal(steps.length, 0);
  game.feed(Buffer.from('p'), 5000);
  assert.equal(game.showingInstructions, true, 'unknown keys must not dismiss instructions');
  game.feed(Buffer.from('j'), 5000); game.advance(5017);
  assert.equal(steps.length, 1);
  first = surface.render(game, target, 10, 60, 2);
  assert.match(first, /Esc退/);
  assert.match(first, /[\u2580-\u259f\u2800-\u28ff]/);
});

test('held direction applies to every 60Hz step at both 15fps and 30fps; action fires once', () => {
  for (const interval of [1000 / 15, 1000 / 30]) {
    const { game, steps } = recorder();
    game.advance(1000); game.feed(Buffer.from('dj'), 1000);
    game.advance(1000 + interval + 0.001);
    assert.equal(steps.length, Math.round(interval / (1000 / 60)));
    assert.ok(steps.every(s => s.right));
    assert.equal(steps.filter(s => s.primary).length, 1);
  }
});

test('overlapping horizontal holds use the most recently pressed direction', () => {
  const { game, steps } = recorder();
  game.advance(1000);
  game.feed(Buffer.from('d'), 1000);
  game.feed(Buffer.from('a'), 1005);
  game.advance(1017);
  assert.deepEqual(steps.at(-1), {
    left: true, right: false, up: false, down: false,
    jump: false, primary: false, secondary: false,
  });

  game.feed(Buffer.from('d'), 1020);
  game.advance(1034);
  assert.equal(steps.at(-1)?.left, false);
  assert.equal(steps.at(-1)?.right, true, '再次按右必须更新重叠期间的胜者');
});

test('sub-step frames do not consume an attack', () => {
  const { game, steps } = recorder();
  game.advance(1000); game.feed(Buffer.from('j'), 1000);
  game.advance(1005); game.advance(1010);
  assert.equal(steps.length, 0);
  game.advance(1017);
  assert.equal(steps.filter(s => s.primary).length, 1);
});

test('hidden and help states pause simulation without catch-up on return', () => {
  const { game, steps } = recorder();
  game.advance(1000); game.feed(Buffer.from('j'), 1000); game.advance(1017);
  game.pause(); game.advance(5000); game.advance(9000);
  assert.equal(steps.length, 1);
  game.resume(); game.feed(Buffer.from('j'), 10000); game.advance(10000); game.advance(10017);
  assert.equal(steps.length, 2);
  game.feed(Buffer.from('?'), 10020); game.advance(20000);
  assert.equal(steps.length, 2);
});

test('unsupported micro mode is an explicit paused entry, not a shrunken live board', () => {
  const { game, steps } = recorder(false, 6);
  game.setDisplay(2, 'braille'); game.advance(1000); game.feed(Buffer.from('j'), 1000); game.advance(1100);
  assert.equal(game.playable(), false); assert.equal(steps.length, 0);
  assert.match(game.panel()[1], /E 展开.*6行/);
  game.setDisplay(4, 'braille'); assert.equal(game.playable(), false);
  game.setDisplay(6, 'braille'); assert.equal(game.playable(), true);
  game.feed(Buffer.from('E')); assert.equal(game.takeViewToggle(), true); assert.equal(game.takeViewToggle(), false);
});
