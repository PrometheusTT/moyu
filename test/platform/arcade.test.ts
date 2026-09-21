import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arcade, BUILTIN_GAMES, foeColor } from '../../src/platform/arcade.ts';
import { CHAPTER_TITLES, CHAPTER_STORY } from '../../src/core/chapter.ts';
import { BrailleTarget } from '../../src/render/braille.ts';
import { appendSignal } from '../../src/bridge/signal.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GameInstance, GameModule } from '../../src/platform/types.ts';
import { LogicalCanvas } from '../../src/platform/canvas.ts';

function cartridge(id: string, create: GameModule['create']): GameModule {
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

test('built-in Stick Slash consumes the deterministic GameContext seed', () => {
  const seeded: number[] = [];
  const modules = BUILTIN_GAMES.map((module) => module.manifest.id === 'stick-slash' ? {
    ...module,
    create(context: Parameters<GameModule['create']>[0]) {
      seeded.push(context.seed);
      return module.create(context);
    },
  } : module);
  new Arcade('/tmp/moyu-no-events-test', modules, undefined, 0x12345678);
  assert.deepEqual(seeded, [0x12345678]);
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
      a.pollHostEvents(1200); a.render(target, 'micro'); a.takeAction(); void a.status;
      a.hud(); a.pause(); a.resume(); a.enter(); a.takeViewToggle();
    });
    assert.match(a.panel().join(' '), /没有可用游戏/);
    assert.match(a.hud().left, /没有可用游戏/);
  }
});

test('three built-in cartridges cover action, grid, and falling blocks', () => {
  assert.deepEqual(BUILTIN_GAMES.map((g) => g.manifest.id), ['stick-slash', 'snake', 'blocks']);
  assert.ok(BUILTIN_GAMES.every((g) => g.manifest.apiVersion === 1));
});

// 这些用例构造真的 Arcade，会从 MOYU_HOME 读存档。真人玩过火柴快斩后本机就有
// 章节存档，restore 会让 hud() 显示"第 N 章完成"而不是游戏名 —— 不隔离的话，
// "玩过游戏就 npm run check 挂"。给每个用例一个干净的临时 home。
function withFreshHome<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-home-'));
  const before = process.env.MOYU_HOME;
  process.env.MOYU_HOME = dir;
  try { return fn(); }
  finally {
    if (before === undefined) delete process.env.MOYU_HOME; else process.env.MOYU_HOME = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Tab cycles cartridges through the shared host', () => withFreshHome(() => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  assert.match(a.hud().left, /火柴快斩/);
  a.feed(Uint8Array.of(9)); assert.match(a.hud().left, /贪吃蛇/);
  a.feed(Uint8Array.of(9)); assert.match(a.hud().left, /落块/);
}));

test('live HUD 亮出技能冷却，且 火柴快斩/血 都在冷却指示之前', () => {
  const game = stickGame();
  const idle = game.hud?.() ?? '';
  // 就绪态：两个技能都是 ▮。
  assert.match(idle, /火柴快斩/);
  assert.match(idle, /血\d\/4/);
  assert.match(idle, /冲▮ 旋▮/, `就绪时应显示两个 ▮，实际：${idle}`);
  // `火柴快斩` 和 `血` 必须排在冷却指示（冲…旋…）之前，窄屏裁切只裁掉尾部指示器。
  assert.ok(idle.indexOf('火柴快斩') < idle.indexOf('冲'), '火柴快斩 应在冷却指示之前');
  assert.ok(idle.indexOf('血') < idle.indexOf('冲'), '血量 应在冷却指示之前');

  // 放一次冲刺斩（U=secondary）后，冲的指示应转为冷却中 ▯。
  const dash = { left: false, right: false, up: false, down: false,
    jump: false, primary: false, secondary: true };
  game.update(1 / 60, dash);
  assert.match(game.hud?.() ?? '', /冲▯/, '放完冲刺斩后冲的冷却应显示 ▯');
});

test('live HUD：连击数插在血与冲之间、就绪脉冲只在行尾，`冲 旋` 子串始终完整', () => {
  const game = stickGame(41);
  assert.doesNotMatch(game.hud?.() ?? '', /连击/, '开局连击 0，不该显示连击数');
  // 跑一段真实战斗（开局导演在右侧放一对杂兵，向右连劈能打出连击）。
  const slash = { left: false, right: false, up: false, down: false, jump: false, primary: true, secondary: false };
  const walk = { ...slash, primary: false, right: true };
  let sawCombo = false;
  for (let i = 0; i < 900; i++) {
    game.update(1 / 60, i % 5 < 2 ? { ...slash, right: true } : walk);
    const h = game.hud?.() ?? '';
    // 不变式：无论何时，`冲X 旋X` 连续子串必须完整（arcade.test/e2e 的正则钉着它），
    // 就绪脉冲 `就绪✦` 只能出现在它之后。
    assert.match(h, /冲[▮▯] 旋[▮▯]/, `任何一帧 \`冲 旋\` 子串都应完整，实际：${h}`);
    const pulse = h.indexOf('就绪');
    if (pulse >= 0) assert.ok(pulse > h.indexOf('旋'), '就绪脉冲只能追加在冷却指示之后（行尾）');
    const combo = h.match(/连击(\d+)/);
    if (combo) {
      sawCombo = true;
      assert.ok(h.indexOf('血') < h.indexOf('连击'), '连击数应排在血量之后');
      assert.ok(h.indexOf('连击') < h.indexOf('冲'), '连击数应排在冷却指示之前');
    }
  }
  assert.ok(sawCombo, '900 帧向右连劈没能打出任何连击（连击数 HUD 未被覆盖）');
});

test('all cartridges render through the portable target', () => withFreshHome(() => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  const target = new BrailleTarget(60, 12);
  for (let game = 0; game < 3; game++) {
    a.advance(1000); a.advance(1040); a.render(target);
    assert.notEqual(target.encode(2), '', `cartridge ${game} did not render`);
    a.feed(Uint8Array.of(9)); target.invalidate();
  }
}));

test('all built-ins have a legible two-row micro composition', () => withFreshHome(() => {
  const a = new Arcade('/tmp/moyu-no-events-test');
  const target = new BrailleTarget(40, 2);
  for (let game = 0; game < 3; game++) {
    a.advance(2000); a.advance(2040); a.render(target, 'micro');
    assert.notEqual(target.encode(2), '', `micro cartridge ${game} did not render`);
    a.feed(Uint8Array.of(9)); target.invalidate();
  }
}));

function fullMicroFrame(arcade: Arcade, target: BrailleTarget): string {
  target.invalidate();
  arcade.render(target, 'micro');
  return target.encode(1);
}

function stickModule(): GameModule {
  const module = BUILTIN_GAMES.find((candidate) => candidate.manifest.id === 'stick-slash');
  assert.ok(module);
  return module;
}

function stickGame(seed = 1): GameInstance {
  return stickModule().create(Object.freeze({ seed, random: () => 0.5 }));
}

function chapterOneCheckpoint(seed = 1): Record<string, unknown> {
  const game = stickGame(seed);
  const input = { left: false, right: false, up: false, down: false,
    jump: false, primary: false, secondary: false };
  for (let i = 0; i < 1800; i++) game.update(1 / 60, input);
  return game.serialize?.() as Record<string, unknown>;
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

test('Stick Slash v1 persistence separates lifetime records from campaign checkpoints', () => {
  const state = chapterOneCheckpoint(21);
  const checkpoint = state.checkpoint as Record<string, unknown>;
  assert.equal(state.kills, checkpoint.kills);
  assert.equal(state.bestCombo, checkpoint.bestCombo);

  const restored = stickGame(999);
  restored.restore?.(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.serialize?.(), state);

  const lifetime = { ...state, kills: (state.kills as number) + 3,
    bestCombo: Math.max(state.bestCombo as number, 2) };
  restored.restore?.(lifetime);
  assert.deepEqual(restored.serialize?.(), lifetime,
    'lifetime records may exceed the completed-campaign boundary');

  const before = restored.serialize?.();
  restored.restore?.({ ...state, kills: (checkpoint.kills as number) - 1 });
  assert.deepEqual(restored.serialize?.(), before, 'outer totals cannot trail the checkpoint');
  restored.restore?.({ version: 2, kills: 99, bestCombo: 88 });
  assert.deepEqual(restored.serialize?.(), before, 'unknown versions must not fall through to legacy restore');
});

test('Stick Slash restores legacy and v1 pre-checkpoint lifetime records', () => {
  const legacy = stickGame(24);
  legacy.restore?.({ kills: 7, bestCombo: 3 });
  assert.deepEqual(legacy.serialize?.(), {
    version: 1, kills: 7, bestCombo: 3, checkpoint: null,
  });

  const v1 = stickGame(25);
  v1.restore?.({ version: 1, kills: 9, bestCombo: 4, checkpoint: null });
  assert.deepEqual(v1.serialize?.(), {
    version: 1, kills: 9, bestCombo: 4, checkpoint: null,
  });
});

test('Stick Slash result-screen J cannot bypass task completion ownership', () => {
  const game = stickGame(22);
  const none = { left: false, right: false, up: false, down: false,
    jump: false, primary: false, secondary: false };
  const slash = { ...none, primary: true };
  for (let i = 0; i < 1800; i++) game.update(1 / 60, none);
  const before = game.serialize?.() as Record<string, unknown>;
  const checkpoint = before.checkpoint;
  game.onHostEvent?.('task-done');
  game.update(1 / 60, slash);
  const clearing = game.serialize?.() as Record<string, unknown>;
  assert.equal(clearing.checkpoint, checkpoint, 'clear-wave kills must not rewrite the finished chapter');
  assert.ok((clearing.kills as number) >= (before.kills as number));
  assert.match(game.hud?.() ?? '', /第1章完成/);
  assert.match(game.hud?.() ?? '', new RegExp(`『${CHAPTER_TITLES[0]}』`), '完成屏应亮出本章剧情标题');
  assert.match(game.hud?.() ?? '', new RegExp(CHAPTER_STORY[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '完成屏应亮出本章收尾旁白');
  for (let i = 0; i < 300; i++) game.update(1 / 60, slash);
  assert.match(game.hud?.() ?? '', /等待下个任务/);
  game.onHostEvent?.('task-start');
  game.update(1 / 60, slash);
  assert.match(game.hud?.() ?? '', /2\/10/);
});

test('通关演出：章节 settle 起一记冲击波，战斗中不出现、脉冲散尽后收回', () => {
  const game = stickGame(29);
  const none = { left: false, right: false, up: false, down: false,
    jump: false, primary: false, secondary: false };
  const dye = (): number => {
    // 展开档整帧非空像素数：冲击波盖在最上，会额外点亮一批像素。
    const c = new LogicalCanvas(80, 24);
    game.renderExpanded?.(c);
    let lit = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (c.getPixel(x, y) !== 0x090a0e) lit++;
    return lit;
  };
  // 战斗途中（未 settle）：clearPulse 恒 0，没有冲击波。跑到第 1799 步仍在打。
  for (let i = 0; i < 1799; i++) game.update(1 / 60, none);
  assert.doesNotMatch(game.hud?.() ?? '', /第1章完成/, '第 1799 步应还没结算');
  // 第 1800 步 settle：这一帧点亮冲击波。
  game.update(1 / 60, none);
  assert.match(game.hud?.() ?? '', /第1章完成/, '第 1800 步应已结算');
  const atClear = dye();
  // 让脉冲散尽（>1.1s），场景冻结不变，只有冲击波退场。
  for (let i = 0; i < 90; i++) game.update(1 / 60, none);
  const settled = dye();
  assert.ok(atClear > settled, `通关瞬间应比散尽后更亮（冲击波在场）：${atClear} vs ${settled}`);
});

test('Stick Slash final HUD reports cumulative five-minute totals', () => {
  const game = stickGame(23);
  const state = chapterOneCheckpoint(23);
  const first = state.checkpoint as Record<string, unknown>;
  const firstKills = first.kills as number;
  const firstScore = first.score as number;
  const finalResult = { chapter: 10, score: 150, kills: 1, bestCombo: 1 };
  const priorKills = firstKills + 2;
  const priorScore = firstScore + 300;
  const completed = {
    ...first,
    completed: 10,
    score: priorScore + finalResult.score,
    kills: priorKills + finalResult.kills,
    bestCombo: Math.max(first.bestCombo as number, 1),
    result: finalResult,
  };
  game.restore?.({ version: 1, kills: completed.kills,
    bestCombo: completed.bestCombo, checkpoint: completed });
  const hud = game.hud?.() ?? '';
  assert.match(hud, new RegExp(`${completed.score}分`));
  assert.match(hud, new RegExp(`${completed.kills}击破`));
  assert.match(hud, new RegExp(`连击${completed.bestCombo}`));
  assert.notEqual(completed.score, finalResult.score);
  assert.notEqual(completed.kills, finalResult.kills);
  assert.doesNotMatch(hud, new RegExp(`五分钟完成 · ${finalResult.score}分 · ${finalResult.kills}击破`));
});

test('Stick Slash final screen restarts a fresh run on J instead of freezing', () => {
  // 复现玩家反馈：打穿第 10 章后停在"五分钟完成"屏，按 J 完全卡住。
  // 末章 nextChapter 返回 false，得靠 restartRun 兜底：J 应回到第 1 章重开，而不是冻结。
  const game = stickGame(26);
  const state = chapterOneCheckpoint(26);
  const first = state.checkpoint as Record<string, unknown>;
  const finalResult = { chapter: 10, score: 150, kills: 1, bestCombo: 1 };
  const completed = {
    ...first,
    completed: 10,
    score: (first.score as number) + 300 + finalResult.score,
    kills: (first.kills as number) + 2 + finalResult.kills,
    bestCombo: Math.max(first.bestCombo as number, 1),
    result: finalResult,
  };
  game.restore?.({ version: 1, kills: completed.kills,
    bestCombo: completed.bestCombo, checkpoint: completed });
  assert.match(game.hud?.() ?? '', /五分钟完成/, '末章终局屏应先亮出五分钟完成');
  assert.match(game.hud?.() ?? '', /J 再来一局/, '终局屏应给出再来一局的提示');

  const none = { left: false, right: false, up: false, down: false,
    jump: false, primary: false, secondary: false };
  const slash = { ...none, primary: true };
  game.update(1 / 60, slash);
  const after = game.hud?.() ?? '';
  assert.doesNotMatch(after, /五分钟完成/, '按 J 后不该再停在终局屏（卡死）');
  assert.match(after, /火柴快斩 1\/10/, '按 J 应回到第 1 章重开新的一局');
});

test('cartridge random streams are independent of preceding factory consumption', () => {
  const observed: number[] = [];
  const healthy = cartridge('healthy-random', context => {
    observed.push(context.random());
    return visibleGame('a', []);
  });
  new Arcade('/tmp/moyu-no-events-test', [healthy], undefined, 0x12345678);
  const alone = observed.pop();
  const greedy = cartridge('greedy', context => {
    for (let i = 0; i < 100; i++) context.random();
    throw new Error('expected');
  });
  new Arcade('/tmp/moyu-no-events-test', [greedy, healthy], undefined, 0x12345678);
  assert.equal(observed.pop(), alone);
});

test('hidden polling pauses and persists exactly once per task event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const home = path.join(dir, 'home');
  const events: string[] = [];
  let saves = 0;
  const module = cartridge('lifecycle', () => ({
    update() {}, render() {},
    onHostEvent: event => { events.push(event); },
    serialize: () => ({ saves: ++saves }),
  }));
  const beforeHome = process.env.MOYU_HOME;
  process.env.MOYU_HOME = home;
  const a = new Arcade(file, [module]);
  try {
    a.pause();
    assert.equal(saves, 1);
    assert.deepEqual(events, ['pause']);
    appendSignal('notify', file);
    a.pollHostEvents(1000);
    assert.equal(a.status, 'needs-input');
    assert.equal(a.takeAction(), 'return-to-cli');
    assert.equal(saves, 2, 'already-paused event mutations must be saved once without another pause hook');
    assert.deepEqual(events, ['pause', 'task-notify']);
    a.pollHostEvents(1050);
    assert.equal(a.takeAction(), null, 'sub-100ms poll must not replay an action');
    appendSignal('start', file);
    a.pollHostEvents(1100);
    assert.equal(a.status, 'idle', 'task-start acknowledges needs-input status');
    assert.deepEqual(events, ['pause', 'task-notify', 'task-start']);
  } finally {
    if (beforeHome === undefined) delete process.env.MOYU_HOME;
    else process.env.MOYU_HOME = beforeHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('throwing host hooks cannot block later cartridges or required handoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const home = path.join(dir, 'home');
  const observed: string[] = [];
  let saved = 0;
  const broken = cartridge('broken-hook', () => ({
    update() {}, render() {},
    onHostEvent: event => { if (event === 'task-done') throw new Error('hook failed'); },
  }));
  const healthy = cartridge('healthy-hook', () => ({
    update() {}, render() {}, onHostEvent: event => { observed.push(event); },
    serialize: () => ({ saved: ++saved }),
  }));
  const beforeHome = process.env.MOYU_HOME;
  process.env.MOYU_HOME = home;
  const a = new Arcade(file, [broken, healthy], 'healthy-hook');
  try {
    appendSignal('done', file);
    a.pollHostEvents(1000);
    assert.deepEqual(observed, ['task-done', 'pause']);
    assert.equal(a.status, 'task-done');
    assert.equal(a.takeAction(), 'return-to-cli');
    assert.equal(saved, 1);
  } finally {
    if (beforeHome === undefined) delete process.env.MOYU_HOME;
    else process.env.MOYU_HOME = beforeHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backward wall-clock changes rebase host polling without replaying events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const events: string[] = [];
  const a = new Arcade(file, [cartridge('clock', () => ({
    update() {}, render() {}, onHostEvent: event => { events.push(event); },
  }))]);
  try {
    a.pollHostEvents(10_000);
    appendSignal('notify', file);
    a.pollHostEvents(9_000);
    assert.deepEqual(events, ['task-notify', 'pause']);
    assert.equal(a.status, 'needs-input');
    assert.equal(a.takeAction(), 'return-to-cli');
    a.pollHostEvents(9_050);
    assert.deepEqual(events, ['task-notify', 'pause']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('already-paused done and notify batch saves once without replaying pause', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const home = path.join(dir, 'home');
  const events: string[] = [];
  let saves = 0;
  const beforeHome = process.env.MOYU_HOME;
  process.env.MOYU_HOME = home;
  const a = new Arcade(file, [cartridge('paused-batch', () => ({
    update() {}, render() {}, onHostEvent: event => { events.push(event); },
    serialize: () => ({ saves: ++saves }),
  }))]);
  try {
    a.pause();
    appendSignal('done', file);
    appendSignal('notify', file);
    a.pollHostEvents(1000);
    assert.equal(saves, 2);
    assert.deepEqual(events, ['pause', 'task-done', 'task-notify']);
    assert.equal(a.status, 'task-done');
    assert.equal(a.takeAction(), 'return-to-cli');
  } finally {
    if (beforeHome === undefined) delete process.env.MOYU_HOME;
    else process.env.MOYU_HOME = beforeHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('throwing active pause hook cannot block persistence or handoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const home = path.join(dir, 'home');
  const events: string[] = [];
  let saves = 0;
  const beforeHome = process.env.MOYU_HOME;
  process.env.MOYU_HOME = home;
  const a = new Arcade(file, [cartridge('pause-throws', () => ({
    update() {}, render() {},
    onHostEvent: event => {
      events.push(event);
      if (event === 'pause') throw new Error('pause failed');
    },
    serialize: () => ({ saves: ++saves }),
  }))]);
  try {
    appendSignal('done', file);
    a.pollHostEvents(1000);
    assert.deepEqual(events, ['task-done', 'pause']);
    assert.equal(saves, 1);
    assert.equal(a.status, 'task-done');
    assert.equal(a.takeAction(), 'return-to-cli');
  } finally {
    if (beforeHome === undefined) delete process.env.MOYU_HOME;
    else process.env.MOYU_HOME = beforeHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ordered start and notify batches preserve notification type priority', () => {
  for (const order of [['notify', 'start'], ['start', 'notify']] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
    const file = path.join(dir, 'events.log');
    const events: string[] = [];
    const a = new Arcade(file, [cartridge(`order-${order.join('-')}`, () => ({
      update() {}, render() {}, onHostEvent: event => { events.push(event); },
    }))]);
    try {
      for (const event of order) appendSignal(event, file);
      a.pollHostEvents(1000);
      const dispatched: string[] = order.map(event => event === 'start' ? 'task-start' : 'task-notify');
      dispatched.push('pause');
      assert.deepEqual(events, dispatched);
      assert.equal(a.status, 'needs-input', order.join(' -> '));
      assert.equal(a.takeAction(), 'return-to-cli');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a mixed host-event batch preserves done priority while dispatching every event in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const events: string[] = [];
  const a = new Arcade(file, [cartridge('batch', () => ({
    update() {}, render() {}, onHostEvent: event => { events.push(event); },
  }))]);
  try {
    appendSignal('done', file);
    appendSignal('start', file);
    appendSignal('notify', file);
    a.pollHostEvents(1000);
    assert.deepEqual(events, ['task-done', 'task-start', 'task-notify', 'pause']);
    assert.equal(a.status, 'task-done');
    assert.equal(a.takeAction(), 'return-to-cli');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('task completion is silent, persistent in standby, and cleared when viewed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-events-'));
  const file = path.join(dir, 'events.log');
  const a = new Arcade(file);
  try {
    appendSignal('done', file);
    a.pollHostEvents(1000);
    assert.equal(a.takeAction(), 'return-to-cli');
    assert.equal(a.takeAction(), null, '宿主动作只能消费一次');
    assert.equal(a.status, 'task-done');
    assert.equal(a.hud().urgent, true);
    assert.match(a.hud().short, /任务完成/);
    a.resume();
    assert.equal(a.status, 'task-done', '普通恢复不能顺手清掉未查看的任务状态');
    a.enter();
    assert.equal(a.status, 'idle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('变种配色：grunt/runner/brute/boss 四色互不相同（字符档区分度不能塌）', () => {
  const g = foeColor('grunt'), r = foeColor('runner'), b = foeColor('brute'), boss = foeColor('boss');
  const set = new Set([g, r, b, boss]);
  assert.equal(set.size, 4, `四种变种应产出四种不同颜色，实际：${[...set].map((c) => c.toString(16)).join(',')}`);
  assert.equal(foeColor(undefined), g, '无 tag（老 Fighter/玩家）应安全回落到 grunt 本色');
});
