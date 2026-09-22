// Render production canvases into a contact sheet; no browser or game-state files needed.
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { World, NO_INTENT } from '../src/core/world.ts';
import { GraphicsTarget } from '../src/render/graphics.ts';
import { NativePixelCanvas } from '../src/platform/pixel-canvas.ts';
import { paintPixelWorld } from '../src/render/pixel-scene.ts';
import { sceneForChapter } from '../src/render/theme.ts';
import { BUILTIN_GAMES } from '../src/platform/arcade.ts';
import { LogicalCanvas } from '../src/platform/canvas.ts';
import { SWORD_FORMS } from '../src/core/martial.ts';
import { poseWindup, poseSlash } from '../src/core/stick.ts';

const out = path.resolve(process.argv[2] ?? '/private/tmp/moyu-wuxia-qa');
fs.mkdirSync(out, { recursive: true });
const previewArt = Object.hasOwn(SWORD_FORMS, process.argv[3] ?? '') ? process.argv[3] : null;
const wide = process.argv.includes('--wide');
const forms = process.argv.includes('--forms');
const duel = process.argv.includes('--duel');
const clean = process.argv.includes('--clean');
const schools = process.argv.includes('--schools');
const formRows = Object.entries(SWORD_FORMS).flatMap(([art, entries]) => entries.map((_, formIndex) => ({ art, formIndex })));
const width = wide ? 1200 : 720, rowHeight = wide ? 120 : 180;
const rows = schools ? 8 : duel ? 5 : forms ? formRows.length + 1 : previewArt ? SWORD_FORMS[previewArt].length + 2 : 17;
const rgb = Buffer.alloc(width * rowHeight * rows * 3);
function copyRow(target, row, scale = 1) {
  for (let y = 0; y < rowHeight; y++) for (let x = 0; x < width; x++) {
    const color = target.getPixel(Math.floor(x / scale), Math.floor(y / scale));
    const at = ((row * rowHeight + y) * width + x) * 3;
    rgb[at] = color >>> 16; rgb[at + 1] = color >>> 8; rgb[at + 2] = color;
  }
}
for (let row = 0; row < rows - 1; row++) {
  const world = new World(31, { automaticSpawns: false });
  world.resize(width * 48 / rowHeight, 44); world.biome = row < 6 ? row : 2;
  world.beginChapter(); world.player.invuln = 0;
  world.player.x = 65;
  for (const [i, tag] of ['grunt', 'runner', 'brute', 'boss'].entries()) {
    world.spawnFormation({ kind: 'single', side: 'right' });
    const foe = world.enemies.at(-1);
    foe.tag = tag; foe.x = 90 + i * 23; foe.h = tag === 'boss' ? 35 : 23; foe.walk = i * 0.15;
    if (row < 6 && tag !== 'boss') foe.species = [
      ['scarab', 'mantis'], ['crab', 'eel'], ['idol', 'mantis'],
      ['scorpion', 'scarab'], ['wolf', 'crystal'], ['bat', 'idol'],
    ][row][i % 2];
    if (tag === 'boss') { foe.hp = 3; foe.maxHp = 5; }
  }
  if (!previewArt && row >= 6 && row <= 12) {
    world.swordCast = { art: ['dugu', 'liumai', 'taiji', 'feixian', 'wanjian', 'getsuga', 'hinokami'][row - 6], x: 65, y: 27,
      face: 1, age: 0.45, pulse: 1, level: 1, full: true };
    world.player.atk = 0.16;
  }
  if (!previewArt && !forms && row >= 13) {
    const boss = world.enemies.at(-1); boss.x = 110;
    if (row === 13) boss.hurt = 0.23;
    if (row === 14) { boss.windup = 0.5; boss.quakeX = world.player.x; }
    if (row === 15) world.hazards = [-1, 0, 1].map(s => ({ x: world.player.x + s * world.fh * 1.5,
      radius: world.fh * 0.48, timer: 0, life: 0.4, hit: false }));
  }
  if (previewArt) world.swordCast = { art: previewArt, x: 65, y: 27, face: 1,
    formIndex: Math.min(row, SWORD_FORMS[previewArt].length - 1), full: row === SWORD_FORMS[previewArt].length,
    age: clean ? 0.27 : 0.45, pulse: row, level: 1 };
  if (forms) world.swordCast = { ...formRows[row], x: 65, y: 27, face: 1, age: 0.3, pulse: 0, level: 1 };
  if (schools) {
    const art = Object.keys(SWORD_FORMS)[row];
    world.swordCast = { art, formIndex: [1, 0, 8, 3, 5, 6, 8][row], x: 65, y: 27, face: 1, age: 0.27, pulse: 0, level: 1 };
  }
  if (duel) {
    world.enemies.length = 0;
    world.spawnDuelist('right', row < 2 ? 9 : 18, true);
    const e = world.enemies[0]; e.x = 125;
    e.pose = row % 2 === 0 ? poseWindup(0.7) : poseSlash(0.45);
    if (row % 2 === 0) { e.guard = 0.4; e.windup = 0.5; }
    else e.enemyCast = { art: row < 2 ? 'dugu' : 'liumai', formIndex: row < 2 ? 3 : 5,
      x: e.x, y: 27, face: -1, age: 0.3, pulse: 0, level: 1 };
  }
  if (clean) {
    world.enemies.length = 0;
    world.player.pose = poseSlash(0.38, previewArt === 'liumai' ? 'lunge' : 'sweep');
  }
  const t = new GraphicsTarget(80, 6, width / 80, rowHeight / 6);
  paintPixelWorld(new NativePixelCanvas(t), world, { view: 'expanded', interpolation: 1, theme: 'dark' }, undefined, false, sceneForChapter(!forms && row < 6 ? row + 1 : 1));
  copyRow(t, row);
}
const game = BUILTIN_GAMES[0].create({ seed: 31, random: () => 0.5 });
const logicalScale = rowHeight / 20;
const logical = new LogicalCanvas(Math.ceil(width / logicalScale), 20);
game.configureViewport?.(logical.width, logical.height, 'braille');
game.renderExpanded(logical); copyRow(logical, rows - 1, logicalScale);

function chunk(type, data) {
  const name = Buffer.from(type), crcData = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of crcData) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), tail = Buffer.alloc(4);
  size.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, tail]);
}
const height = rowHeight * rows, header = Buffer.alloc(13);
header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const scan = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) rgb.copy(scan, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
fs.writeFileSync(path.join(out, 'contact.png'), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]));

const metrics = [];
for (const chapter of [1, 2, 3, 4, 5, 6]) {
  const w = new World(31); w.resize(180, 44); w.biome = chapter - 1; w.taskStart(); w.enemyLimit = 6;
  const t = new GraphicsTarget(40, 2, 16, 34), c = new NativePixelCanvas(t);
  const times = [], sizes = [];
  for (let frame = 0; frame < 600; frame++) {
    const move = frame % 120 < 60 ? 1 : -1;
    w.step(1 / 60, { ...NO_INTENT, move, slash: frame % 18 === 0 });
    w.step(1 / 60, { ...NO_INTENT, move });
    const start = performance.now();
    paintPixelWorld(c, w, { view: 'micro', interpolation: 1, theme: 'dark' }, undefined, false, sceneForChapter(chapter));
    sizes.push(Buffer.byteLength(t.encode(1))); times.push(performance.now() - start);
  }
  times.sort((a,b) => a-b);
  metrics.push({ chapter, p95Ms: +times[569].toFixed(3), averageBytes: Math.round(sizes.reduce((a,b)=>a+b)/sizes.length), peakBytes: Math.max(...sizes) });
}
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify({ out, metrics }, null, 2));
