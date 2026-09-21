import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTER_COUNT, CHAPTER_STEPS, CHAPTER_TITLES, CHAPTER_STORY, OPENING_END, ORDINARY_END, PINCER_END,
  ChapterDirector, chapterBand, chapterPressure, parseChapterCheckpoint,
} from '../../src/core/chapter.ts';
import { Rng } from '../../src/core/rng.ts';
import { NO_INTENT, World, type Intent, type SpawnFormation } from '../../src/core/world.ts';

const STEP = 1 / 60;

function setup(seed = 1): { world: World; director: ChapterDirector } {
  const world = new World(seed, { automaticSpawns: false });
  world.resize(180, 44);
  world.enemyLimit = 3;
  const director = new ChapterDirector(seed);
  director.start(world);
  return { world, director };
}

function snapshot(world: World, director: ChapterDirector): unknown {
  return {
    chapter: director.chapter, step: director.activeStep, result: director.result,
    kills: world.kills, best: world.bestCombo, deaths: world.deaths,
    player: [world.player.x, world.player.y, world.player.hp, world.player.atk],
    enemies: world.enemies.map((e) => [e.x, e.y, e.face, e.windup]),
  };
}

function gameplaySnapshot(world: World, director: ChapterDirector): unknown {
  const state = snapshot(world, director) as Record<string, unknown>;
  const { deaths: _deaths, ...gameplay } = state;
  return gameplay;
}

test('每章编队严格落在导演日程帧，种类、方向和压力间隔都可复现', () => {
  for (const chapter of [1, 4]) {
    const { world, director } = setup(0x12345678);
    const calls: Array<{ step: number; formation: SpawnFormation }> = [];
    const spawn = world.spawnFormation.bind(world);
    world.spawnFormation = (formation): boolean => {
      calls.push({ step: director.activeStep, formation });
      return spawn(formation);
    };
    for (let current = 1; current < chapter; current++) {
      while (director.result === null) director.step(world, STEP, NO_INTENT);
      assert.equal(director.nextChapter(world), true);
      calls.length = 0;
    }
    while (director.result === null) director.step(world, STEP, NO_INTENT);

    const pressure = chapterPressure(chapter);
    const expected: Array<{ step: number; formation: SpawnFormation }> = [];
    const side = (slot: number): 'left' | 'right' => {
      let x = (director.runSeed ^ Math.imul(chapter, 0x9e3779b1)
        ^ Math.imul(slot + 1, 0x85ebca6b)) >>> 0;
      x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15;
      return (x >>> 0) % 2 === 0 ? 'left' : 'right';
    };
    const ordinary = 140 - pressure * 12;
    for (let step = OPENING_END; step < ORDINARY_END; step += ordinary) {
      const slot = (step - OPENING_END) / ordinary;
      expected.push({ step, formation: slot % 2 === 0
        ? { kind: 'pincer' }
        : { kind: 'single', side: side(slot) } });
    }
    const pincer = 240 - pressure * 20;
    for (let step = ORDINARY_END; step < PINCER_END; step += pincer) {
      const slot = (step - ORDINARY_END) / pincer;
      expected.push({ step, formation: slot % 2 === 0 ? { kind: 'pincer' }
        : { kind: 'single', side: side(slot + 11) } });
    }
    const closing = 150 - pressure * 15;
    for (let step = PINCER_END; step < CHAPTER_STEPS; step += closing) {
      expected.push({ step, formation: { kind: 'fill',
        side: side((step - PINCER_END) / closing + 23) } });
    }
    assert.deepEqual(calls, expected);
  }
});

test('Rng 恢复只接受有效的非零 uint32 快照且失败不改状态', () => {
  const rng = new Rng(17);
  const before = rng.snapshot();
  for (const state of [0, -1, 1.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => rng.restore(state), RangeError);
    assert.equal(rng.snapshot(), before);
  }
  rng.restore(0xffffffff);
  assert.equal(rng.snapshot(), 0xffffffff);
});

test('章节分段边界精确落在 3、12、22、30 秒', () => {
  assert.equal(chapterBand(0), 'opening');
  assert.equal(chapterBand(OPENING_END - 1), 'opening');
  assert.equal(chapterBand(OPENING_END), 'ordinary');
  assert.equal(chapterBand(ORDINARY_END - 1), 'ordinary');
  assert.equal(chapterBand(ORDINARY_END), 'pincer');
  assert.equal(chapterBand(PINCER_END - 1), 'pincer');
  assert.equal(chapterBand(PINCER_END), 'closing');
  assert.equal(chapterBand(CHAPTER_STEPS - 1), 'closing');
  assert.throws(() => chapterBand(CHAPTER_STEPS), RangeError);
});

test('开场给一刀多杀机会，定向编队原子执行且永不超过三人', () => {
  const { world, director } = setup(3);
  assert.equal(world.enemies.length, 2);
  director.step(world, STEP, { move: 0, jump: false, slash: true });
  for (let i = 1; i < 30; i++) director.step(world, STEP, NO_INTENT);
  assert.equal(world.kills, 2, '开场两人必须都在同一刀判定内');
  assert.ok(world.bestCombo >= 2);

  assert.equal(world.spawnFormation({ kind: 'fill', side: 'left' }), true);
  const before = world.enemies.map((e) => e.x);
  assert.equal(world.spawnFormation({ kind: 'pincer' }), false);
  assert.deepEqual(world.enemies.map((e) => e.x), before, '放不下的整队不能只刷一半');
  assert.ok(world.enemies.length <= 3);
});

test('第 1800 个活动更新结束章节，结果态冻结，J 只打开下一章', () => {
  const { world, director } = setup(5);
  for (let i = 0; i < CHAPTER_STEPS - 1; i++) assert.equal(director.step(world, STEP, NO_INTENT), true);
  assert.equal(director.result, null);
  assert.equal(director.step(world, STEP, NO_INTENT), true);
  assert.equal(director.activeStep, CHAPTER_STEPS);
  assert.deepEqual(director.result, { chapter: 1, score: 0, kills: 0, bestCombo: 0 });
  const frozen = snapshot(world, director);
  for (let i = 0; i < 600; i++) assert.equal(director.step(world, STEP, NO_INTENT), false);
  assert.deepEqual(snapshot(world, director), frozen);
  assert.equal(director.nextChapter(world), true);
  assert.equal(director.chapter, 2);
  assert.equal(director.activeStep, 0);
  assert.equal(director.result, null);
  assert.equal(world.player.atk, -1, '下一章的 J 不得同时出刀');
});

test('十章恰好消耗 18000 个活动更新，压力封顶且末章不可继续', () => {
  const { world, director } = setup(7);
  let active = 0;
  for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter++) {
    while (director.result === null) {
      if (director.step(world, STEP, NO_INTENT)) active++;
      assert.ok(world.enemies.length <= 3);
    }
    assert.equal(director.result.chapter, chapter);
    if (chapter < CHAPTER_COUNT) assert.equal(director.nextChapter(world), true);
  }
  assert.equal(active, 18_000);
  assert.equal(director.nextChapter(world), false);
  assert.equal(chapterPressure(4), chapterPressure(10));
});

test('同种子与输入在完整五分钟内产生相同结果和检查点', () => {
  const a = setup(0x12345678);
  const b = setup(0x12345678);
  const intent = (i: number): Intent => ({ move: Math.floor(i / 91) % 2 === 0 ? 1 : -1,
    jump: i % 137 === 0, slash: i % 37 === 0 });
  let update = 0;
  for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter++) {
    while (a.director.result === null) {
      const input = intent(update++);
      a.director.step(a.world, STEP, input);
      b.director.step(b.world, STEP, input);
      assert.ok(a.world.enemies.length <= 3 && b.world.enemies.length <= 3);
    }
    assert.deepEqual(snapshot(a.world, a.director), snapshot(b.world, b.director));
    assert.deepEqual(a.director.checkpoint(), b.director.checkpoint());
    if (chapter < CHAPTER_COUNT) {
      a.director.nextChapter(a.world);
      b.director.nextChapter(b.world);
    }
  }
  assert.equal(update, CHAPTER_COUNT * CHAPTER_STEPS);
});

test('任务完成优先于章节结算，清屏期间不消耗章节帧', () => {
  const { world, director } = setup(11);
  for (let i = 0; i < CHAPTER_STEPS - 1; i++) director.step(world, STEP, NO_INTENT);
  world.taskDone();
  const active = director.activeStep;
  assert.equal(director.step(world, STEP, NO_INTENT), false);
  assert.equal(director.activeStep, active);
  assert.equal(director.result, null);
  for (let i = 0; i < 200 && world.phase === 'clear'; i++) director.step(world, STEP, NO_INTENT);
  assert.equal(world.phase, 'paused');
  assert.equal(director.result, null);
  assert.equal(director.step(world, STEP, { ...NO_INTENT, slash: true }), false);
  assert.equal(world.phase, 'paused', 'J 不能绕过 task-start 取消任务完成暂停');
  world.taskStart();
  assert.equal(director.step(world, STEP, NO_INTENT), true);
  assert.equal(director.activeStep, active + 1);
});

test('章节结果后任务完成仍优先，task-start 后下一次 J 才能开下一章', () => {
  const { world, director } = setup(12);
  for (let i = 0; i < CHAPTER_STEPS; i++) director.step(world, STEP, NO_INTENT);
  const result = director.result;
  const checkpoint = director.checkpoint();
  assert.ok(result !== null && checkpoint !== null);
  world.taskDone();
  assert.equal(director.nextChapter(world), false);
  assert.equal(director.chapter, 1);
  assert.equal(director.result, result);
  assert.equal(director.checkpoint(), checkpoint);
  for (let i = 0; i < 300 && world.phase === 'clear'; i++) director.step(world, STEP, NO_INTENT);
  assert.equal(world.phase, 'paused');
  assert.equal(director.nextChapter(world), false);
  world.taskStart();
  assert.equal(director.nextChapter(world), true);
  assert.equal(director.chapter, 2);
});

test('检查点恢复 World 随机流，下一章与未中断运行逐帧一致', () => {
  const uninterrupted = setup(13);
  for (let i = 0; i < CHAPTER_STEPS; i++) uninterrupted.director.step(uninterrupted.world, STEP, NO_INTENT);
  const checkpoint = uninterrupted.director.checkpoint();
  assert.ok(checkpoint);
  assert.equal(uninterrupted.director.nextChapter(uninterrupted.world), true);

  const resumed = setup(0x76543210);
  assert.equal(resumed.director.restore(resumed.world, checkpoint), true);
  resumed.world.kills = checkpoint.kills;
  resumed.world.bestCombo = checkpoint.bestCombo;
  assert.equal(resumed.director.nextChapter(resumed.world), true);
  const intent = (i: number): Intent => ({ move: Math.floor(i / 83) % 2 === 0 ? 1 : -1,
    jump: i % 149 === 0, slash: i % 41 === 0 });
  for (let i = 0; i < CHAPTER_STEPS; i++) {
    const input = intent(i);
    uninterrupted.director.step(uninterrupted.world, STEP, input);
    resumed.director.step(resumed.world, STEP, input);
    assert.deepEqual(gameplaySnapshot(resumed.world, resumed.director),
      gameplaySnapshot(uninterrupted.world, uninterrupted.director));
  }
  assert.deepEqual(resumed.director.checkpoint(), uninterrupted.director.checkpoint());
});

test('暂停调用次数不改变恢复后的随机流', () => {
  const base = setup(31);
  for (let i = 0; i < CHAPTER_STEPS; i++) base.director.step(base.world, STEP, NO_INTENT);
  const checkpoint = base.director.checkpoint();
  assert.ok(checkpoint);

  const a = setup(1); const b = setup(2);
  assert.equal(a.director.restore(a.world, checkpoint), true);
  assert.equal(b.director.restore(b.world, checkpoint), true);
  a.world.taskDone(); b.world.taskDone();
  while (a.world.phase === 'clear') a.director.step(a.world, STEP, NO_INTENT);
  while (b.world.phase === 'clear') b.director.step(b.world, STEP, NO_INTENT);
  for (let i = 0; i < 10_000; i++) b.director.step(b.world, STEP, NO_INTENT);
  a.world.taskStart(); b.world.taskStart();
  assert.equal(a.director.nextChapter(a.world), true);
  assert.equal(b.director.nextChapter(b.world), true);
  assert.equal(a.world.rng.snapshot(), b.world.rng.snapshot());
  assert.deepEqual(a.world.enemies.map((e) => [e.x, e.h, e.anim, e.cool, e.speed]),
    b.world.enemies.map((e) => [e.x, e.h, e.anim, e.cool, e.speed]));
});

test('同一步出现后又被受击清零的连击仍计入章节峰值', () => {
  const { world, director } = setup(37);
  world.enemies.length = 0;
  world.spawnFormation({ kind: 'pair', side: 'right' });
  const attacker = world.enemies[0]!;
  const victim = world.enemies[1]!;
  victim.x = world.player.x + world.fh * 0.7;
  attacker.x = world.player.x - world.fh * 0.5;
  attacker.face = 1;
  attacker.windup = 0;
  world.player.invuln = 0;
  world.player.atk = 0.30 - STEP;
  world.player.atkHit = false;
  director.step(world, STEP, { move: 0, jump: false, slash: false });
  assert.equal(world.stepComboPeak, 1);
  assert.equal(world.combo, 0);
  for (let i = 1; i < CHAPTER_STEPS; i++) director.step(world, STEP, NO_INTENT);
  assert.equal(director.result?.bestCombo, 1);
});

test('任务清屏击破不进入已完成章节的结果或累计检查点', () => {
  const { world, director } = setup(41);
  for (let i = 0; i < CHAPTER_STEPS; i++) director.step(world, STEP, NO_INTENT);
  const result = director.result;
  const checkpoint = director.checkpoint();
  assert.ok(result && checkpoint);
  world.spawnFormation({ kind: 'fill', side: 'left' });
  world.taskDone();
  while (world.phase === 'clear') director.step(world, STEP, NO_INTENT);
  assert.ok(world.kills > checkpoint.kills);
  assert.equal(director.result, result);
  assert.equal(director.checkpoint(), checkpoint);
});

test('任务清屏特效不改变下一章的 gameplay RNG 续跑', () => {
  const uninterrupted = setup(43);
  for (let i = 0; i < CHAPTER_STEPS; i++) uninterrupted.director.step(uninterrupted.world, STEP, NO_INTENT);
  const checkpoint = uninterrupted.director.checkpoint();
  assert.ok(checkpoint);
  uninterrupted.world.spawnFormation({ kind: 'fill', side: 'left' });
  uninterrupted.world.taskDone();
  while (uninterrupted.world.phase === 'clear') {
    uninterrupted.director.step(uninterrupted.world, STEP, NO_INTENT);
  }
  uninterrupted.world.taskStart();
  assert.equal(uninterrupted.director.nextChapter(uninterrupted.world), true);

  const resumed = setup(99);
  assert.equal(resumed.director.restore(resumed.world, checkpoint), true);
  assert.equal(resumed.director.nextChapter(resumed.world), true);
  assert.equal(uninterrupted.world.rng.snapshot(), resumed.world.rng.snapshot());
  assert.deepEqual(uninterrupted.world.enemies.map((e) => [e.x, e.h, e.anim, e.cool, e.speed]),
    resumed.world.enemies.map((e) => [e.x, e.h, e.anim, e.cool, e.speed]));
});

test('v1 检查点往返，畸形数据整份拒绝且不产生部分恢复', () => {
  const first = setup(13);
  for (let i = 0; i < CHAPTER_STEPS; i++) first.director.step(first.world, STEP, NO_INTENT);
  const checkpoint = first.director.checkpoint();
  assert.ok(checkpoint);
  assert.deepEqual(parseChapterCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);

  const second = setup(99);
  assert.equal(second.director.restore(second.world, checkpoint), true);
  assert.deepEqual(second.director.checkpoint(), checkpoint);
  const before = snapshot(second.world, second.director);
  assert.equal(second.director.restore(second.world, { ...checkpoint, result: { ...checkpoint.result, score: -1 } }), false);
  assert.deepEqual(snapshot(second.world, second.director), before);
  assert.equal(parseChapterCheckpoint({ ...checkpoint, completed: 11 }), null);
  assert.equal(parseChapterCheckpoint({ ...checkpoint, rngState: 0 }), null);
  assert.equal(parseChapterCheckpoint({ ...checkpoint, score: checkpoint.score + 50 }), null,
    '第一章累计值必须等于本章结果');
  assert.equal(parseChapterCheckpoint({ ...checkpoint, bestCombo: checkpoint.kills + 1 }), null);
  assert.equal(parseChapterCheckpoint({ ...checkpoint,
    result: { ...checkpoint.result, bestCombo: checkpoint.result.kills + 1 } }), null);
  assert.equal(parseChapterCheckpoint({ ...checkpoint,
    result: { ...checkpoint.result, score: checkpoint.result.score + 50 } }), null);
  assert.equal(parseChapterCheckpoint({ ...checkpoint, score: checkpoint.score + 1 }), null);
  const impossible = { ...checkpoint, completed: 2, score: 50, kills: 0, bestCombo: 0,
    result: { chapter: 2, score: 0, kills: 0, bestCombo: 0 } };
  assert.equal(parseChapterCheckpoint(impossible), null,
    '累计分必须能由累计击破和每章连击奖励构成');

  const result = { chapter: 2, score: 150, kills: 1, bestCombo: 1 };
  for (const totals of [
    { score: 200, kills: 2, bestCombo: 1, result },
    { score: 250, kills: 2, bestCombo: 1, result },
    { score: 400, kills: 3, bestCombo: 2, result: { chapter: 2, score: 200, kills: 2, bestCombo: 0 } },
    { score: 400, kills: 3, bestCombo: 1, result: { chapter: 2, score: 100, kills: 1, bestCombo: 0 } },
    { score: 250, kills: 2, bestCombo: 2, result: { chapter: 2, score: 100, kills: 1, bestCombo: 0 } },
    { score: 100, kills: 1, bestCombo: 0,
      result: { chapter: 2, score: 100, kills: 1, bestCombo: 0 } },
  ]) {
    assert.equal(parseChapterCheckpoint({ ...checkpoint, completed: 2, ...totals }), null,
      `不可能的前章累计仍被接受：${JSON.stringify(totals)}`);
  }
  for (const value of [
    { ...checkpoint, completed: 2, score: 300, kills: 2, bestCombo: 1,
      result: { chapter: 2, score: 150, kills: 1, bestCombo: 1 } },
    { ...checkpoint, completed: 3, score: 450, kills: 3, bestCombo: 1,
      result: { chapter: 3, score: 150, kills: 1, bestCombo: 1 } },
  ]) assert.ok(parseChapterCheckpoint(value), `合法累计被拒绝：${JSON.stringify(value)}`);
});

test('检查点解析只读取字段一次，敌意 getter 不能造成部分恢复', () => {
  const restored = setup(77);
  const before = {
    director: snapshot(restored.world, restored.director),
    checkpoint: restored.director.checkpoint(),
    rng: restored.world.rng.snapshot(),
    phase: restored.world.phase,
  };
  let reads = 0;
  const hostile = {
    version: 1, runSeed: 1, completed: 1, score: 0, kills: 0, bestCombo: 0,
    get rngState() { reads++; return reads < 3 ? 1 : 0; },
    result: { chapter: 1, score: 0, kills: 0, bestCombo: 0 },
  };
  assert.equal(restored.director.restore(restored.world, hostile), true);
  assert.equal(reads, 1);
  assert.equal(restored.world.rng.snapshot(), 1);
  assert.deepEqual(restored.director.checkpoint(), parseChapterCheckpoint(hostile));
  assert.notDeepEqual(snapshot(restored.world, restored.director), before.director);

  let throws = 0;
  const rejected = { ...hostile, get rngState() { throws++; throw new Error('getter'); } };
  const stable = {
    director: snapshot(restored.world, restored.director),
    checkpoint: restored.director.checkpoint(),
    rng: restored.world.rng.snapshot(),
    phase: restored.world.phase,
  };
  assert.equal(restored.director.restore(restored.world, rejected), false);
  assert.equal(throws, 1);
  assert.deepEqual(snapshot(restored.world, restored.director), stable.director);
  assert.equal(restored.director.checkpoint(), stable.checkpoint);
  assert.equal(restored.world.rng.snapshot(), stable.rng);
  assert.equal(restored.world.phase, stable.phase);
});

test('章节剧情标题：每章有名、随章推进、越界安全', () => {
  assert.equal(CHAPTER_TITLES.length, CHAPTER_COUNT, '标题数必须等于章节数');
  assert.ok(CHAPTER_TITLES.every((t) => typeof t === 'string' && t.length > 0), '有空标题');
  const { world, director } = setup(42);
  assert.equal(director.chapterTitle(), CHAPTER_TITLES[0], '第 1 章标题不对');
  // 通关第 1 章后进第 2 章，标题跟着换。
  while (director.result === null) director.step(world, STEP, { move: 0, jump: false, slash: false });
  assert.equal(director.nextChapter(world), true);
  assert.equal(director.chapterTitle(), CHAPTER_TITLES[1], '进第 2 章后标题没换');
});

test('章节收尾旁白：每章一句、随章推进、越界安全', () => {
  assert.equal(CHAPTER_STORY.length, CHAPTER_COUNT, '旁白数必须等于章节数');
  assert.ok(CHAPTER_STORY.every((s) => typeof s === 'string' && s.length > 0), '有空旁白');
  const { world, director } = setup(43);
  assert.equal(director.chapterStory(), CHAPTER_STORY[0], '第 1 章旁白不对');
  while (director.result === null) director.step(world, STEP, { move: 0, jump: false, slash: false });
  assert.equal(director.nextChapter(world), true);
  assert.equal(director.chapterStory(), CHAPTER_STORY[1], '进第 2 章后旁白没换');
});

test('boss 章（第 3 章）一定出 boss —— 即便收尾段那一刻满场（被动/满员也不静默丢失）', () => {
  const { world, director } = setup(7);   // enemyLimit=3, automaticSpawns off
  for (let c = 1; c < 3; c++) {
    while (director.result === null) director.step(world, STEP, NO_INTENT);
    director.nextChapter(world);
  }
  assert.equal(director.chapter, 3);
  let sawBoss = false;
  while (director.result === null) {
    director.step(world, STEP, NO_INTENT);   // 全程被动 → 收尾段前大概率已满 3 个
    if (world.enemies.some((e) => e.tag === 'boss')) sawBoss = true;
    assert.ok(world.enemies.length <= 3, '出 boss 也不能超过 enemyLimit');
  }
  assert.ok(sawBoss, '第 3 章整章没出现 boss（招牌功能静默丢失）');
});

test('非 boss 章（第 1、2 章）不出 boss', () => {
  const { world, director } = setup(7);
  for (const c of [1, 2]) {
    let boss = false;
    while (director.result === null) {
      director.step(world, STEP, NO_INTENT);
      if (world.enemies.some((e) => e.tag === 'boss')) boss = true;
    }
    assert.equal(boss, false, `第 ${c} 章不该有 boss`);
    director.nextChapter(world);
  }
});
