import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arcade } from '../../src/platform/arcade.ts';
import { GraphicsTarget } from '../../src/render/graphics.ts';
import { BrailleTarget } from '../../src/render/braille.ts';
import { PlaySurface } from '../../src/platform/surface.ts';
import type { GameModule, PixelRenderContext } from '../../src/platform/types.ts';

test('native path receives the actual pixel viewport and interpolation; legacy render remains a fallback', () => {
  const contexts: PixelRenderContext[] = []; let legacy = 0;
  const module: GameModule = {
    manifest: { id: 'pixel-fixture', name: 'Pixel fixture', version: '1', apiVersion: 1, author: 'QA',
      description: 'QA', entry: 'builtin', viewport: { width: 180, height: 44 },
      display: { micro: true, minRows: 4 }, palette: ['#000000', '#ffffff'], controls: [] },
    create: () => ({ update: () => {}, render: c => { legacy++; c.clear(0); }, renderMicro: c => { legacy++; c.clear(0); },
      renderPixels: (c, context) => {
        assert.equal(c.width, 640); assert.equal(c.height, 68); contexts.push(context);
        c.clear(0); c.pixel(639, 67, 0xffffff);
      } }),
  };
  const a = new Arcade('/tmp/moyu-no-pixel-events', [module]), t = new GraphicsTarget(40, 2, 16, 34);
  a.setDisplay(2, 'graphics'); a.feed(Buffer.from('j'), 1000); a.advance(1000); a.render(t, 'micro');
  assert.equal(contexts.at(-1)!.interpolation, 1, 'clock reset must not replay a stale previous state');
  a.advance(1025); a.render(t, 'micro');
  assert.ok(Math.abs(contexts.at(-1)!.interpolation - 0.5) < 1e-8);
  assert.equal(contexts.at(-1)!.view, 'micro'); assert.equal(legacy, 0);
  assert.equal(t.getPixel(639, 67), 0xffffff, 'native output was resampled or letterboxed');
  a.render(new BrailleTarget(40, 2), 'micro'); assert.equal(legacy, 1);
  const old = { ...module, create: () => ({ update: () => {}, render: () => { legacy++; } }) };
  new Arcade('/tmp/moyu-no-pixel-events', [old]).render(t); assert.equal(legacy, 2);
});

test('graphics instructions use text cells, never an opaque image covering the controls', () => {
  const game = new Arcade('/tmp/moyu-no-pixel-events'), t = new GraphicsTarget(40, 2, 16, 34), surface = new PlaySurface();
  const help = surface.render(game, t, 5, 80, 2);
  assert.match(help, /J 砍/); assert.ok(!help.includes('\x1b_Ga=T'));
  game.feed(Buffer.from('j')); game.advance(1000); game.advance(1034);
  assert.ok(surface.render(game, t, 5, 80, 2).includes('\x1b_Ga=T'));
  game.feed(Buffer.from('?'));
  const reopened = surface.render(game, t, 5, 80, 2);
  assert.ok(reopened.includes('a=d')); assert.ok(!reopened.includes('a=T'));
  assert.match(reopened, /J 砍/);
});

test('a native micro cartridge can play without a character renderer, but cannot claim text support', () => {
  const module: GameModule = {
    manifest: { id: 'native-only-fixture', name: 'Native fixture', version: '1', apiVersion: 1,
      author: 'QA', description: 'QA', entry: 'builtin', viewport: { width: 180, height: 44 },
      display: { micro: true, minRows: 4 }, palette: ['#000000'], controls: [] },
    create: () => ({ update: () => {}, render: c => c.clear(0), renderPixels: c => c.clear(0) }),
  };
  const game = new Arcade('/tmp/moyu-no-pixel-events', [module]);
  game.setDisplay(2, 'graphics'); assert.equal(game.playable(), true);
  game.setDisplay(2, 'braille'); assert.equal(game.playable(), false);
  game.setDisplay(2, 'half'); assert.equal(game.playable(), false);
});
