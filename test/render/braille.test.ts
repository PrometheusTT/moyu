import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrailleTarget } from '../../src/render/braille.ts';

test('Braille target provides 2×4 pixels per terminal cell', () => {
  const t = new BrailleTarget(40, 2);
  assert.deepEqual({ w: t.pixelW, h: t.pixelH, tier: t.tier }, { w: 80, h: 8, tier: 'braille' });
});

test('single high-contrast pixel maps to the correct Braille dot', () => {
  const t = new BrailleTarget(1, 1);
  t.fill(0x000000); t.setPixel(0, 0, 0xffffff);
  const out = t.encode(3);
  assert.match(out, /⠁/);
  assert.match(out, /\x1b\[3;1H/);
});

test('axis-aligned pixel edges use solid block glyphs instead of dotted Braille', () => {
  const horizontal = new BrailleTarget(1, 1);
  horizontal.fill(0x000000);
  horizontal.fillRect(0, 0, 2, 2, 0xffffff);
  assert.match(horizontal.encode(1), /[▀▄]/, '水平边缘应该是连续色块');

  const vertical = new BrailleTarget(1, 1);
  vertical.fill(0x000000);
  vertical.fillRect(0, 0, 1, 4, 0xffffff);
  assert.match(vertical.encode(1), /[▌▐]/, '垂直边缘应该是连续色块');
});

test('a foreground that fills one cell remains a pixel glyph instead of becoming a colored background space', () => {
  const t = new BrailleTarget(1, 1);
  t.fill(0x090a0e);
  t.fillRect(0, 0, 2, 4, 0xecf0f8);
  const out = t.encode(1);
  assert.match(out, /█/, '实心像素应为连续实心字形，不应变成空心点阵');
  assert.match(out, /48;2;9;10;14m/, '背景仍然是声明过的画布底色');
});

test('embedded mode inherits the terminal background instead of painting a dark rectangle', () => {
  const t = new BrailleTarget(2, 1, { defaultBackground: true, defaultForeground: 0xffffff });
  t.fill(0x090a0e);
  t.setPixel(0, 0, 0xffffff);
  const out = t.encode(1);
  assert.match(out, /\x1b\[49m/, 'matte cells should select the terminal default background');
  assert.match(out, /\x1b\[39m/, 'the primary sprite color should select the terminal default foreground');
  assert.doesNotMatch(out, /\x1b\[48;2;9;10;14m/, 'the game matte must not become an opaque overlay');
  assert.doesNotMatch(out, /\x1b\[38;2;255;255;255m/, 'a light theme must not receive a hard-coded white player');
});

test('embedded mode keeps three-quarter cells as exact dots instead of an invalid reverse-color block', () => {
  const t = new BrailleTarget(1, 1, { defaultBackground: true, defaultForeground: 0xffffff });
  t.fill(0x090a0e);
  t.fillRect(0, 0, 2, 3, 0xffffff);
  const out = t.encode(1);
  assert.match(out, /⠿/, 'the exact six-dot mask should survive');
  assert.doesNotMatch(out, /▁/, 'reverse-color approximation cannot represent a transparent matte');
});

test('unchanged Braille frames emit zero bytes and invalidate redraws', () => {
  const t = new BrailleTarget(3, 2);
  t.fill(0x112233); assert.notEqual(t.encode(1), '');
  assert.equal(t.encode(1), '');
  t.invalidate(); assert.notEqual(t.encode(1), '');
});
