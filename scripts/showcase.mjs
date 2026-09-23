// Deterministic, bilingual Stick Slash showcase for recording in a graphics terminal.
// Run: npm run showcase:en | npm run showcase:zh; q exits, r replays.
import assert from 'node:assert/strict';
import { World, NO_INTENT } from '../src/core/world.ts';
import { SWORD_ARTS, SWORD_FORMS } from '../src/core/martial.ts';
import { artName } from '../src/i18n.ts';
import { NativePixelCanvas } from '../src/platform/pixel-canvas.ts';
import { GraphicsTarget } from '../src/render/graphics.ts';
import { probeCaps } from '../src/render/caps.ts';
import { paintPixelWorld } from '../src/render/pixel-scene.ts';
import { sceneForChapter } from '../src/render/theme.ts';
import { fitRow } from '../src/render/text.ts';
import { Teardown } from '../src/shell/teardown.ts';

const ARTS = ['dugu', 'liumai', 'taiji', 'getsuga', 'feixian', 'hinokami', 'wanjian'];
const SCENES = [1, 2, 4, 7, 6, 10, 3];
const INTRO = 120;
const EACH = 192;
const OUTRO = 90;
const TOTAL = INTRO + ARTS.length * EACH + OUTRO;
const INPUT = { ...NO_INTENT };
const SEED = 0x5eed2026;
const langArg = process.argv.indexOf('--lang');
const lang = langArg < 0 ? 'en' : process.argv[langArg + 1];
if (!['en', 'zh'].includes(lang)) {
  process.stderr.write('Usage: node --experimental-strip-types scripts/showcase.mjs --lang en|zh [--dry-run]\n');
  process.exitCode = 2;
} else {
  process.env.MOYU_LANG = lang;
  if (process.argv.includes('--dry-run')) dryRun();
  else process.exitCode = await play();
}

function makeWorld(index) {
  const world = new World(SEED + index, { automaticSpawns: false });
  world.resize(180, 44);
  world.resizeArena(160);
  world.phase = 'fight';
  world.player.x = world.w * 0.36;
  world.player.face = 1;
  world.player.hp = world.player.maxHp = 7;
  world.enemyLimit = 11;
  world.cultivation.insight = 540;
  world.qi = 300;
  if (index < 0) world.spawnFormation({ kind: 'pair', side: 'right' });
  else {
    const art = ARTS[index];
    world.formProgress[art][2] = SWORD_FORMS[art].length / 3 - 1;
    if (index === ARTS.length - 1) {
      world.spawnBoss('right', 3, 'mantis');
      world.enemies[0].x = world.player.x + world.fh * 2;
      world.enemies[0].cool = 1.2;
    } else world.spawnFormation({ kind: 'pair', side: 'right' });
  }
  for (const enemy of world.enemies) enemy.cool = Math.max(enemy.cool, 1.3);
  return world;
}

function runStep(world, index, local) {
  if (index < 0) {
    world.step(1 / 60, { ...INPUT, slash: local === 12 || local === 42,
      dash: local === 72, spin: local === 103 });
    return;
  }
  const art = ARTS[index];
  if (local === 98) world.spawnFormation({ kind: 'pair', side: 'right' });
  world.step(1 / 60, { ...INPUT, art: local === 20 || local === 108 ? art : undefined,
    artFace: 1, slash: local === 165 });
}

function moment(step) {
  if (step < INTRO) return { index: -1, local: step };
  const afterIntro = step - INTRO;
  if (afterIntro < ARTS.length * EACH) return {
    index: Math.floor(afterIntro / EACH), local: afterIntro % EACH };
  return { index: ARTS.length, local: afterIntro - ARTS.length * EACH };
}

function title(index) {
  if (index < 0) return lang === 'zh'
    ? { top: '摸鱼 · 火柴快斩', sub: '七套剑法 · 自动演示', bottom: '快斩  ·  冲刺斩  ·  旋斩', keys: '接下来：剑法谱' }
    : { top: 'MOYU · STICK SLASH', sub: 'SEVEN SWORD ARTS · AUTOMATED SHOWCASE',
      bottom: 'QUICK SLASH  ·  DASH SLASH  ·  SPIN SLASH', keys: 'NEXT: THE SWORD ARTS' };
  if (index >= ARTS.length) return lang === 'zh'
    ? { top: '摸鱼 · 火柴快斩', sub: '七套剑法，全部展示', bottom: '在终端里，痛快出剑。', keys: 'R 重播  ·  Q 退出' }
    : { top: 'MOYU · STICK SLASH', sub: 'ALL SEVEN SWORD ARTS',
      bottom: 'YOUR TERMINAL. YOUR SWORD.', keys: 'R REPLAY  ·  Q QUIT' };
  const art = ARTS[index];
  const keys = SWORD_ARTS[art].keys.replaceAll('>', ' → ').replaceAll('+', ' → ');
  return lang === 'zh'
    ? { top: '摸鱼 · 火柴快斩', sub: `剑法 ${String(index + 1).padStart(2, '0')} / 07`,
      bottom: artName(art), keys }
    : { top: 'MOYU · STICK SLASH', sub: `SWORD ART ${String(index + 1).padStart(2, '0')} / 07`,
      bottom: artName(art).toUpperCase(), keys };
}

function dryRun() {
  for (let index = 0; index < ARTS.length; index++) {
    const world = makeWorld(index);
    const art = ARTS[index];
    for (let local = 0; local < EACH; local++) runStep(world, index, local);
    assert.ok(world.cultivation.mastery[art] >= 2, `${art} was not cast twice`);
    assert.ok(world.kills >= 2, `${art} did not land enough hits`);
    if (index === ARTS.length - 1) assert.ok(!world.enemies.some(enemy => enemy.tag === 'boss'), 'final boss survived');
    const target = new GraphicsTarget(60, 8, 8, 16);
    paintPixelWorld(new NativePixelCanvas(target), world,
      { view: 'expanded', interpolation: 1, theme: 'dark' }, undefined, false, sceneForChapter(SCENES[index]));
    assert.ok(target.encode(3).includes('\x1b_G'), `${art} did not render`);
    process.stdout.write(`${artName(art)}: ${world.cultivation.mastery[art]} casts, ${world.kills} defeats\n`);
  }
  assert.equal(TOTAL / 60, 25.9);
}

async function play() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(lang === 'zh' ? '请在支持高清的交互式终端运行。\n'
      : 'Run this in an interactive graphics terminal.\n');
    return 2;
  }
  const originalRaw = process.stdin.isRaw;
  let imageStarted = false;
  let timer;
  let done = false;
  let target;
  let world = makeWorld(-1);
  let index = -1;
  let step = 0;
  let paused = false;
  let blocked = false;
  let resolve;
  const teardown = new Teardown(() => ({ deleteImage: imageStarted }));
  const stop = async (code) => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    process.stdin.off('data', onData);
    process.stdout.off('resize', onResize);
    process.stdout.off('drain', onDrain);
    teardown.run();
    await teardown.released().catch(() => {});
    resolve?.(code);
  };
  const replay = () => {
    world = makeWorld(-1); index = -1; step = 0; paused = false;
    target?.invalidate();
    if (!timer) timer = setInterval(frame, 1000 / 30);
  };
  const onData = (data) => {
    if (data.includes(3) || data.includes(27) || data.includes(113)) { void stop(0); return; }
    if (data.includes(114)) replay();
    if (data.includes(32)) paused = !paused;
  };
  const onResize = () => {
    if (target) process.stdout.write(target.disposeSeq());
    target = undefined;
    process.stdout.write('\x1b[2J');
  };
  const onDrain = () => { blocked = false; };
  const frame = () => {
    if (done || blocked) return;
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    if (cols < 60 || rows < 12) {
      process.stdout.write(`\x1b[1;1H${lang === 'zh' ? '终端窗口至少需要 60 列 × 12 行。' : 'Terminal needs at least 60 columns × 12 rows.'}\x1b[K`);
      return;
    }
    if (!target || target.cols !== cols || target.rows !== rows - 4) {
      target = new GraphicsTarget(cols, rows - 4, caps.cellW, caps.cellH);
      process.stdout.write('\x1b[2J');
    }
    if (!paused && step < TOTAL) for (let n = 0; n < 2; n++) {
      const now = moment(step);
      if (now.index !== index && now.index < ARTS.length) {
        index = now.index;
        world = makeWorld(index);
      }
      if (now.index < ARTS.length) runStep(world, now.index, now.local);
      else world.step(1 / 60, INPUT);
      step++;
    }
    if (step >= TOTAL && timer) { clearInterval(timer); timer = undefined; }
    const current = moment(Math.min(step, TOTAL - 1));
    const card = title(current.index);
    paintPixelWorld(new NativePixelCanvas(target), world,
      { view: 'expanded', interpolation: 1, theme: 'dark' }, undefined, false,
      sceneForChapter(SCENES[Math.max(0, Math.min(current.index, SCENES.length - 1))]));
    imageStarted = true;
    const row = (y, value, fg, bg) => `\x1b[${y};1H\x1b[38;2;${fg}m\x1b[48;2;${bg}m${fitRow(value, '', cols)}\x1b[0m`;
    const output = row(1, card.top, '239;242;246', '16;18;24')
      + row(2, card.sub, '232;192;112', '16;18;24')
      + target.encode(3)
      + row(rows - 1, card.bottom, '255;237;195', '27;24;29')
      + row(rows, card.keys, '244;150;118', '27;24;29');
    blocked = !process.stdout.write(output);
  };

  teardown.install();
  teardown.onRestore(() => {
    if (timer) clearInterval(timer);
    try { process.stdin.setRawMode(originalRaw); } catch { /* terminal gone */ }
    process.stdin.pause();
  });
  await teardown.acquire({});
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const caps = await probeCaps({ stdin: process.stdin, write: value => process.stdout.write(value),
    env: process.env, cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24, tty: true });
  if (caps.tier !== 'graphics') {
    teardown.run(); await teardown.released().catch(() => {});
    process.stderr.write(lang === 'zh' ? `当前未进入高清档：${caps.why}\n请改用 Kitty、Ghostty、WezTerm 或 iTerm2。\n`
      : `High-resolution mode unavailable: ${caps.why}\nTry Kitty, Ghostty, WezTerm, or iTerm2.\n`);
    return 2;
  }
  if (caps.leftover.includes(3) || caps.leftover.includes(27) || caps.leftover.includes(113)) {
    teardown.run(); await teardown.released().catch(() => {});
    return 0;
  }
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?7l\x1b[?25l');
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
  process.stdout.on('drain', onDrain);
  frame();
  timer = setInterval(frame, 1000 / 30);
  return new Promise(r => { resolve = r; });
}
