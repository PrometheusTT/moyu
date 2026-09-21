// Development-only QA for production Kitty render/encode work and decoded visual captures.
// node --experimental-strip-types scripts/pixel-qa.mjs [output-directory]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { Arcade, BUILTIN_GAMES } from '../src/platform/arcade.ts';
import { NativePixelCanvas } from '../src/platform/pixel-canvas.ts';
import { GraphicsTarget, IMAGE_ID, deleteImageSeq } from '../src/render/graphics.ts';

const out = path.resolve(process.argv[2] ?? '/tmp/moyu-pixel-qa');
const capturesDir = path.join(out, 'captures');
fs.mkdirSync(capturesDir, { recursive: true });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-pixel-qa-state-'));
const priorHome = process.env.MOYU_HOME;
const priorTheme = process.env.MOYU_THEME;
const priorReduce = process.env.MOYU_REDUCE_MOTION;
process.env.MOYU_HOME = stateDir;

const ESC = '\x1b';
const KEYS_FIRST = new Set(['a', 'f', 's', 'v', 'o', 'i', 'p', 'c', 'r', 'q', 'C', 'm']);
const SEED = 0x1234abcd;
const EMPTY = Object.freeze({ left: false, right: false, up: false, down: false,
  jump: false, primary: false, secondary: false });
const stick = BUILTIN_GAMES.find(module => module.manifest.id === 'stick-slash');
assert.ok(stick, 'built-in stick-slash cartridge is missing');

function ns(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { value, ns: Number(process.hrtime.bigint() - start) };
}
function parseKeys(source, first) {
  const keys = new Map();
  if (source === '') return keys;
  for (const pair of source.split(',')) {
    const at = pair.indexOf('=');
    assert.ok(at > 0, `invalid Kitty key/value ${JSON.stringify(pair)}`);
    const key = pair.slice(0, at);
    assert.ok(KEYS_FIRST.has(key), `unexpected Kitty key ${JSON.stringify(key)}`);
    if (!first) assert.equal(key, 'm', `continuation chunk contains ${key}=`);
    assert.ok(!keys.has(key), `duplicate Kitty key ${key}`);
    keys.set(key, pair.slice(at + 1));
  }
  return keys;
}
function decodeFrame(encoded, target) {
  const cup = /^\x1b\[(\d+);(\d+)H/.exec(encoded);
  assert.ok(cup, `frame must begin with CUP: ${JSON.stringify(encoded.slice(0, 16))}`);
  assert.equal(cup[2], '1', 'Kitty image must start in column one');
  let at = cup[0].length;
  const chunks = [];
  while (at < encoded.length) {
    assert.equal(encoded.slice(at, at + 3), `${ESC}_G`, `chunk ${chunks.length + 1} lacks APC`);
    const end = encoded.indexOf(`${ESC}\\`, at + 3);
    assert.ok(end >= 0, `chunk ${chunks.length + 1} lacks ST`);
    const body = encoded.slice(at + 3, end);
    const semi = body.indexOf(';');
    assert.ok(semi >= 0, 'Kitty chunk lacks key/payload separator');
    const payload = body.slice(semi + 1);
    assert.ok(payload.length <= 4096, `Kitty payload chunk is ${payload.length} bytes`);
    assert.match(payload, /^[A-Za-z0-9+/=]*$/, 'Kitty payload is not Base64');
    chunks.push({ keys: parseKeys(body.slice(0, semi), chunks.length === 0), payload });
    at = end + 2;
  }
  assert.ok(chunks.length > 0, 'frame contains no Kitty APC');
  const first = chunks[0].keys;
  const expected = {
    a: 'T', f: '24', s: String(target.pixelW), v: String(target.pixelH), o: 'z',
    i: String(IMAGE_ID), p: '1', c: String(target.cols), r: String(target.rows), q: '2', C: '1',
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(first.get(key), value, `${key}= mismatch`);
  assert.equal(first.size, Object.keys(expected).length + (chunks.length > 1 ? 1 : 0),
    'first Kitty chunk has missing or extra keys');
  for (let i = 0; i < chunks.length; i++) {
    const keys = chunks[i].keys;
    if (chunks.length === 1) assert.equal(keys.has('m'), false, 'single chunk must omit m=');
    else {
      assert.equal(keys.get('m'), i + 1 < chunks.length ? '1' : '0', `chunk ${i + 1} has wrong m=`);
      if (i > 0) assert.equal(keys.size, 1, `continuation chunk ${i + 1} has extra keys`);
    }
  }
  const compressed = Buffer.from(chunks.map(chunk => chunk.payload).join(''), 'base64');
  const rgb = inflateSync(compressed);
  assert.equal(rgb.length, target.pixelW * target.pixelH * 3, 'inflated RGB length mismatch');
  return { row: Number(cup[1]), rgb, compressedBytes: compressed.length, chunks: chunks.length };
}

function percentile(values, fraction) {
  assert.ok(values.length > 0);
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function timing(values) {
  const ms = value => +(value / 1e6).toFixed(3);
  return {
    p50Ms: ms(percentile(values, 0.50)),
    p95Ms: ms(percentile(values, 0.95)),
    p99Ms: ms(percentile(values, 0.99)),
    maxMs: ms(Math.max(...values)),
  };
}
function payload(values, chunks) {
  return {
    averageBytes: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    peakBytes: Math.max(...values),
    maxApcChunks: Math.max(...chunks),
  };
}
function sha(rgb) { return crypto.createHash('sha256').update(rgb).digest('hex'); }
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, name, data, crc]);
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function writePng(file, width, height, rgb) {
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(scanlines, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}
function createGame(seed) {
  let source = seed >>> 0;
  const random = () => {
    source ^= source << 13; source ^= source >>> 17; source ^= source << 5;
    source >>>= 0; return source / 0x100000000;
  };
  return stick.create(Object.freeze({ seed: seed >>> 0, random }));
}
function scriptedInput(step) {
  return {
    ...EMPTY,
    left: Math.floor(step / 241) % 2 === 1,
    right: Math.floor(step / 241) % 2 === 0,
    jump: step % 317 === 71,
    primary: step % 37 === 0,
  };
}
function paint(game, canvas, theme) {
  assert.ok(game.renderPixels, 'stick-slash must expose renderPixels()');
  game.renderPixels(canvas, { view: 'micro', interpolation: 1, theme });
}
function runScenario({ width, height, theme, reduced }) {
  process.env.MOYU_THEME = theme;
  process.env.MOYU_REDUCE_MOTION = reduced ? '1' : '0';
  const target = new GraphicsTarget(40, 2, width / 40, height / 2);
  assert.equal(target.pixelW, width); assert.equal(target.pixelH, height);
  const canvas = new NativePixelCanvas(target);
  const game = createGame(SEED);
  const renderNs = [], encodeNs = [], combinedNs = [], bytes = [], chunkCounts = [];
  const captures = [];
  let currentRgb = null;
  const captureSteps = new Set([0, 179, 719, 1319, 1799]);
  for (let step = 0; step < 1800; step++) {
    game.update(1 / 60, scriptedInput(step));
    const started = process.hrtime.bigint();
    paint(game, canvas, theme);
    const rendered = process.hrtime.bigint();
    const encoded = target.encode(1);
    const finished = process.hrtime.bigint();
    renderNs.push(Number(rendered - started));
    encodeNs.push(Number(finished - rendered));
    combinedNs.push(Number(finished - started));
    bytes.push(Buffer.byteLength(encoded));
    let decoded = null;
    if (encoded !== '') {
      decoded = decodeFrame(encoded, target);
      chunkCounts.push(decoded.chunks);
      currentRgb = decoded.rgb;
    } else {
      assert.equal(target.lastBytes, 0);
      chunkCounts.push(0);
    }
    assert.ok(currentRgb, `frame ${step} has no RGB source`);
    if (captureSteps.has(step)) {
      const rgb = Buffer.from(currentRgb);
      captures.push({ step, rgb, hash: sha(rgb) });
    }
  }
  // 固定1800帧仍作为性能基线；截止后的敌人必须实际打完，不能靠超时拿检查点。
  let cleanupSteps = 0;
  while (!game.serialize?.().checkpoint && cleanupSteps < 3600) {
    const w = game.world;
    const target = w.enemies[0];
    game.update(1 / 60, { ...EMPTY, left: !!target && target.x < w.player.x,
      right: !!target && target.x >= w.player.x, primary: cleanupSteps % 18 === 0,
      special: cleanupSteps % 100 === 0 });
    cleanupSteps++;
  }
  const checkpoint = game.serialize?.().checkpoint;
  assert.ok(checkpoint && checkpoint.completed === 1, 'full chapter did not produce checkpoint 1');
  assert.equal(game.hud?.().includes('第1章完成'), true, 'chapter result HUD is missing');
  paint(game, canvas, theme);
  const finalFrame = target.encode(1);
  if (finalFrame) currentRgb = decodeFrame(finalFrame, target).rgb;
  paint(game, canvas, theme);
  const frozen = target.encode(1);
  assert.equal(frozen, '', 'stable result frame emitted bytes');
  assert.equal(target.lastBytes, 0, 'stable result frame did not reset lastBytes');
  const unchangedNs = [];
  for (let i = 0; i < 200; i++) {
    paint(game, canvas, theme);
    const encoded = ns(() => target.encode(1));
    assert.equal(encoded.value, ''); assert.equal(target.lastBytes, 0);
    unchangedNs.push(encoded.ns);
  }
  const resultRgb = Buffer.from(currentRgb);
  captures.push({ step: 'result', rgb: resultRgb, hash: sha(resultRgb) });
  return {
    target, game, checkpoint, resultHash: sha(resultRgb), captures,
    metrics: {
      width, height, theme, reducedMotion: reduced, frames: bytes.length, cleanupSteps,
      render: timing(renderNs), encode: timing(encodeNs), combined: timing(combinedNs),
      payload: payload(bytes, chunkCounts), unchangedEncode: timing(unchangedNs),
    },
  };
}
function lifecycle(width, height) {
  process.env.MOYU_THEME = 'dark'; process.env.MOYU_REDUCE_MOTION = '0';
  const events = path.join(stateDir, 'lifecycle-events.log');
  const arcade = new Arcade(events, [stick], 'stick-slash', SEED);
  const target = new GraphicsTarget(40, 2, width / 40, height / 2);
  arcade.setDisplay(2, 'graphics'); arcade.enter();
  arcade.feed(Buffer.from('j'), 1000);
  let now = 1000;
  for (let i = 0; i < 120; i++) { now += 1000 / 60; arcade.advance(now); }
  arcade.render(target, 'micro');
  const active = target.encode(1);
  assert.notEqual(active, '');
  const activeDecoded = decodeFrame(active, target);
  arcade.pause();
  const disposal = target.disposeSeq();
  assert.equal(disposal, deleteImageSeq(), 'hide did not delete owned Kitty image');
  const before = arcade.hud().left;
  const hidden = now + 10_000;
  arcade.advance(hidden);
  assert.equal(arcade.hud().left, before, 'hidden advance changed game state');
  const hiddenTarget = new GraphicsTarget(40, 2, width / 40, height / 2);
  arcade.render(hiddenTarget, 'micro');
  const hiddenFrame = hiddenTarget.encode(1);
  assert.equal(sha(decodeFrame(hiddenFrame, hiddenTarget).rgb), sha(activeDecoded.rgb),
    'hidden advance changed the framebuffer');
  arcade.resume(); arcade.advance(hidden);
  target.invalidate();
  const first = ns(() => {
    arcade.render(target, 'micro');
    return target.encode(1);
  });
  assert.notEqual(first.value, '');
  const decoded = decodeFrame(first.value, target);
  const repeat = ns(() => {
    arcade.render(target, 'micro');
    return target.encode(1);
  });
  assert.equal(repeat.value, ''); assert.equal(target.lastBytes, 0);
  return {
    hiddenMs: 10_000,
    statePreserved: true,
    deleteBytes: Buffer.byteLength(disposal),
    firstResumedFrameMs: +(first.ns / 1e6).toFixed(3),
    firstResumedBytes: Buffer.byteLength(first.value),
    firstResumedChunks: decoded.chunks,
    immediateRepeatMs: +(repeat.ns / 1e6).toFixed(3),
    immediateRepeatBytes: 0,
  };
}
function captureName(width, height, theme, reduced, step) {
  return `${width}x${height}-${theme}-${reduced ? 'reduced' : 'normal'}-${step}.png`;
}
function writePreview(entries) {
  const cards = entries.flatMap(entry => entry.captures.map(capture => ({
    label: `${entry.metrics.width}×${entry.metrics.height} · ${entry.metrics.theme} · ${entry.metrics.reducedMotion ? 'reduced' : 'normal'} · ${capture.step}`,
    file: `captures/${captureName(entry.metrics.width, entry.metrics.height, entry.metrics.theme,
      entry.metrics.reducedMotion, capture.step)}`,
  })));
  const html = `<!doctype html><meta charset="utf-8"><title>Moyu pixel QA</title>
<style>body{margin:24px;background:#15171d;color:#eef1f5;font:14px system-ui}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(680px,1fr));gap:18px}figure{margin:0;padding:12px;background:#222630;border-radius:8px}img{width:100%;height:auto;image-rendering:pixelated;background:#0d0f13}figcaption{margin-top:8px;color:#b6bdca}</style>
<h1>Moyu native-pixel QA</h1><p>Images are inflated from actual timed Kitty RGB frames. Browser scaling is for inspection, not terminal certification.</p><main>${cards.map(card => `<figure><img src="${card.file}"><figcaption>${card.label}</figcaption></figure>`).join('')}</main>`;
  fs.writeFileSync(path.join(out, 'preview.html'), html);
}
const runs = [];
try {
  for (const [width, height] of [[320, 34], [640, 68]]) {
    for (const theme of ['dark', 'light']) for (const reduced of [false, true]) {
      const run = runScenario({ width, height, theme, reduced });
      runs.push(run);
      for (const capture of run.captures) {
        writePng(path.join(capturesDir, captureName(width, height, theme, reduced, capture.step)),
          width, height, capture.rgb);
      }
    }
  }
  for (const [width, height] of [[320, 34], [640, 68]]) {
    const comparable = runs.filter(run => run.metrics.width === width);
    const checkpoints = comparable.map(run => JSON.stringify(run.checkpoint));
    assert.equal(new Set(checkpoints).size, 1, `${width} theme/motion changed deterministic checkpoint`);
    const normalDark = comparable.find(run => run.metrics.theme === 'dark' && !run.metrics.reducedMotion);
    const reducedDark = comparable.find(run => run.metrics.theme === 'dark' && run.metrics.reducedMotion);
    assert.equal(normalDark.checkpoint.completed, 1);
    assert.equal(reducedDark.checkpoint.completed, 1);
  }
  // Retain measurements even when a gate fails so intentional art revisions can be reviewed.
  fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(runs.map(run => run.metrics), null, 2));
  const baselines = new Map([
    // 2026-09-21: intentional scenery + articulated creature revision.
    // Measurements and bandwidth tradeoff are recorded in docs/terminal-qa.md.
    ['320x34:dark:false', [0.202, 3278, 4429]],
    ['320x34:dark:true', [0.214, 3219, 4325]],
    ['320x34:light:false', [0.199, 3305, 4549]],
    ['320x34:light:true', [0.197, 3248, 4313]],
    ['640x68:dark:false', [0.652, 7086, 9654]],
    ['640x68:dark:true', [0.661, 6958, 9430]],
    ['640x68:light:false', [0.656, 7376, 9690]],
    ['640x68:light:true', [0.653, 7251, 9686]],
  ]);
  for (const run of runs) {
    const key = `${run.metrics.width}x${run.metrics.height}:${run.metrics.theme}:${run.metrics.reducedMotion}`;
    const baseline = baselines.get(key);
    assert.ok(baseline, `missing native baseline for ${key}`);
    const [encodeP95, averageBytes, peakBytes] = baseline;
    assert.ok(run.metrics.encode.p95Ms <= encodeP95 * 1.15,
      `${key} encode p95 ${run.metrics.encode.p95Ms} ms exceeds 15% gate`);
    assert.ok(run.metrics.payload.averageBytes <= averageBytes * 1.15,
      `${key} average ${run.metrics.payload.averageBytes} B exceeds 15% gate`);
    assert.ok(run.metrics.payload.peakBytes <= peakBytes * 1.15,
      `${key} peak ${run.metrics.payload.peakBytes} B exceeds 15% gate`);
  }
  const lifecycleRuns = [[320, 34], [640, 68]]
    .map(([width, height]) => ({ width, height, ...lifecycle(width, height) }));
  const resumeGateMs = process.env.SSH_CONNECTION || process.env.SSH_TTY ? 100 : 50;
  for (const run of lifecycleRuns) assert.ok(run.firstResumedFrameMs <= resumeGateMs,
    `${run.width}x${run.height} resumed in ${run.firstResumedFrameMs} ms; gate is ${resumeGateMs} ms`);
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    methodology: {
      productionTiming: 'game renderPixels and GraphicsTarget.encode only; protocol decode and PNG export excluded',
      percentiles: 'nearest-rank over 1800 fixed 60 Hz updates; zero-byte unchanged frames included',
      wireValidation: 'strict Kitty keys, APC/ST framing, 4096-byte chunk cap, continuation markers, zlib RGB size',
      fixture: `stick-slash seed ${SEED}, 1800 scheduled steps plus bounded combat cleanup`,
      gates: 'native encode p95 and average/peak payload <= 115% of checked-in baseline; resume <= 50 ms local / 100 ms SSH',
    },
    scenarios: runs.map(run => ({ ...run.metrics, checkpoint: run.checkpoint,
      resultHash: run.resultHash, captureHashes: Object.fromEntries(run.captures.map(c => [c.step, c.hash])) })),
    lifecycle: lifecycleRuns,
  };
  fs.writeFileSync(path.join(out, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
  writePreview(runs);
  console.log(JSON.stringify({ output: out, scenarios: report.scenarios.map(s => ({
    size: `${s.width}x${s.height}`, theme: s.theme, reducedMotion: s.reducedMotion,
    combined: s.combined, payload: s.payload, unchangedEncode: s.unchangedEncode,
  })), lifecycle: report.lifecycle }, null, 2));
} finally {
  if (priorHome === undefined) delete process.env.MOYU_HOME; else process.env.MOYU_HOME = priorHome;
  if (priorTheme === undefined) delete process.env.MOYU_THEME; else process.env.MOYU_THEME = priorTheme;
  if (priorReduce === undefined) delete process.env.MOYU_REDUCE_MOTION; else process.env.MOYU_REDUCE_MOTION = priorReduce;
  fs.rmSync(stateDir, { recursive: true, force: true });
}
