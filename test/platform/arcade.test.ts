import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arcade, BUILTIN_GAMES } from '../../src/platform/arcade.ts';
import { BrailleTarget } from '../../src/render/braille.ts';
import { appendSignal } from '../../src/bridge/signal.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GameInstance, GameModule } from '../../src/platform/types.ts';

function cartridge(id: string, create: () => GameInstance): GameModule {
  return {
    manifest: {
      id, name: id.toUpperCase(), version: '1', apiVersion: 1, author: 'test', description: id,
      entry: 'builtin', viewport: { width: 16, height: 8 }, microViewport: { width: 16, height: 8 },
      display: { micro: true, minRows: 4 }, palette: ['#090a0e', '#ecf0f8'], controls: [],
    },
    create,
  };
}

function visibleGame(id: string, calls: string[]): GameInstance {
  return {
    update: () => { calls.push(`update:${id}`); },
    render: (canvas) => { calls.push(`render:${id}`); canvas.clear(id === 'a' ? 0xecf0f8 : 0xa67c00); },
    renderMicro: (canvas) => { calls.push(`micro:${id}`); canvas.clear(id === 'a' ? 0xecf0f8 : 0xa67c00); },
    hud: () => id,
  };
}

test('hostile thrown values cannot escape factory quarantine', () => {
  const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile prototype'); } });
  const a = new Arcade('/tmp/moyu-no-events-test', [
    cartridge('hostile-throw', () => { throw hostile; }),
    cartridge('healthy', () => visibleGame('a', [])),
  ]);
  assert.equal(a.available, 1);
  assert.match(a.hud().left, /^a$/);
  assert.ok(a.failureFor('hostile-throw'));
});

test('each factory receives an isolated immutable context', () => {
  const poison: GameModule = {
    ...cartridge('poison', () => visibleGame('a', [])),
    create(context) {
      Object.defineProperty(context, 'random', { value: () => { throw new Error('poisoned context'); } });
      throw new Error('factory failed');
    },
  };
  const healthy: GameModule = {
    ...cartridge('healthy', () => visibleGame('a', [])),
    create(context) { context.random(); return visibleGame('a', []); },
  };
  const a = new Arcade('/tmp/moyu-no-events-test', [poison, healthy]);
  assert.equal(a.available, 1);
  assert.equal(a.failureFor('healthy'), undefined);
});

test('rejected async factories are observed while being quarantined', async () => {
  const { spawnSync } = await import('node:child_process');
  const arcadeUrl = new URL('../../src/platform/arcade.ts', import.meta.url).href;
  const manifest = JSON.stringify(cartridge('async', () => visibleGame('a', [])).manifest);
  const script = `import { Arcade } from ${JSON.stringify(arcadeUrl)};\nconst manifest = ${manifest};\nconst a = new Arcade('/tmp/moyu-no-events-test', [{ manifest, create: () => Promise.reject(new Error('async boom')) }]);\nif (!a.failureFor('async')) process.exit(3);\nawait new Promise((resolve) => setImmediate(resolve));`;
  const run = spawnSync(process.execPath, [
    '--unhandled-rejections=strict', '--experimental-strip-types', '--input-type=module', '--eval', script,
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('non-callable then state remains valid game data', () => {
  for (const [index, then] of [null, false, 0, 'state'].entries()) {
    const id = `state-${index}`;
    const a = new Arcade('/tmp/moyu-no-events-test', [
      cartridge(id, () => ({ ...visibleGame('a', []), then }) as GameInstance),
    ]);
    assert.equal(a.available, 1, id);
    assert.equal(a.failureFor(id), undefined, id);
  }
});

test('callable then accessors are inspected once and never invoked', () => {
  let reads = 0, calls = 0;
  const a = new Arcade('/tmp/moyu-no-events-test', [cartridge('then-getter', () => {
    const game = visibleGame('a', []);
    Object.defineProperty(game, 'then', {
      get() { reads++; return () => { calls++; }; },
    });
    return game;
  })]);
  assert.equal(a.available, 0);
  assert.equal(reads, 1);
  assert.equal(calls, 0);
  assert.ok(a.failureFor('then-getter'));
});

test('throwing then accessors are quarantined without hiding later cartridges', () => {
  const broken = cartridge('then-throws', () => {
    const game = visibleGame('a', []);
    Object.defineProperty(game, 'then', { get() { throw new Error('then getter failed'); } });
    return game;
  });
  const a = new Arcade('/tmp/moyu-no-events-test', [broken, cartridge('healthy', () => visibleGame('a', []))]);
  assert.equal(a.available, 1);
  assert.match(a.failureFor('then-throws') ?? '', /then getter failed/);
  assert.equal(a.failureFor('healthy'), undefined);
});

test('factory failures and invalid instances are quarantined as atomic cartridge slots', () => {
  const calls: string[] = [];
  const factories: string[] = [];
  const make = (id: string, value: () => unknown): GameModule => cartridge(id, () => {
    factories.push(id);
    return value() as GameInstance;
  });
  const modules = [
    make('a', () => visibleGame('a', calls)),
    make('throws', () => { throw 'plain failure'; }),
    make('missing-update', () => ({ render() {} })),
    make('missing-render', () => ({ update() {} })),
    make('thenable', () => ({ then() {}, update() {}, render() {} })),
    make('bad-hook', () => ({ update() {}, render() {}, hud: true })),
    make('hostile', () => new Proxy({}, { get: () => { throw new Error('hostile getter'); } })),
    make('c', () => visibleGame('c', calls)),
  ];
  const a = new Arcade('/tmp/moyu-no-events-test', modules, 'c');
  assert.deepEqual(factories, modules.map((m) => m.manifest.id), 'each factory runs exactly once');
  assert.match(a.hud().left, /^c$/);
  assert.match(a.failureFor('throws') ?? '', /plain failure/);
  for (const id of ['missing-update', 'missing-render', 'thenable', 'bad-hook', 'hostile']) assert.ok(a.failureFor(id), id);
  assert.equal(a.failureFor('a'), undefined);
  a.feed(Uint8Array.of(9));
  assert.match(a.hud().left, /^a$/);
  a.advance(1000); a.feed(Buffer.from('j'), 1000); a.advance(1017);
  a.render(new BrailleTarget(16, 4));
  assert.ok(calls.includes('update:a') && calls.includes('render:a'), 'active instance and canvas remain aligned');
});

test('failed startId falls back to first survivor rather than a stale module index', () => {
  const modules = [
    cartridge('bad', () => { throw new Error('nope'); }),
    cartridge('a', () => visibleGame('a', [])),
    cartridge('c', () => visibleGame('c', [])),
  ];
  const failed = new Arcade('/tmp/moyu-no-events-test', modules, 'bad');
  assert.match(failed.hud().left, /^a$/);
  const selected = new Arcade('/tmp/moyu-no-events-test', modules, 'c');
  assert.match(selected.hud().left, /^c$/);
});

test('empty and all-failed arcades keep every public operation total', () => {
  for (const a of [
    new Arcade('/tmp/moyu-no-events-test', []),
    new Arcade('/tmp/moyu-no-events-test', [cartridge('bad', () => { throw new Error('broken'); })]),
  ]) {
    const target = new BrailleTarget(16, 2);
    assert.equal(a.playable(), false);
    assert.equal(a.feed(Buffer.from('q')), true);
    assert.doesNotThrow(() => {
      a.resize(80, 24); a.keys.clear(); a.feed(Buffer.from('\t')); a.feed(Buffer.from('j'));
      a.setDisplay(2, 'braille'); a.panel(); void a.showingInstructions; a.advance(1000); a.advance(1200);
      a.render(target, 'micro'); a.takeAlert(); a.hud(); a.pause(); a.resume(); a.takeViewToggle();
    });
    assert.match(a.panel().join(' '), /没有可用游戏/);
    assert.match(a.hud().left, /没有可用游戏/);
  }
});

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
