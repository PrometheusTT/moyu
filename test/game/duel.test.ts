import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT } from '../../src/core/world.ts';
import { ChapterDirector, CHAPTER_STEPS, PINCER_END } from '../../src/core/chapter.ts';
import { SWORD_FORMS, selectSwordForm, parseFormProgress } from '../../src/core/martial.ts';
import { fighterSegments } from '../../src/core/creature.ts';
import { BUILTIN_GAMES } from '../../src/platform/arcade.ts';
import { paintBossPressure } from '../../src/render/wuxia.ts';

const dt = 1 / 60;
function world(): World {
  const w = new World(91, { automaticSpawns: false });
  w.resize(180, 44); w.beginChapter(); w.player.invuln = 999; w.cultivation.insight = 100;
  return w;
}
function finishCast(w: World): void { for (let i = 0; i < 90; i++) w.step(dt, NO_INTENT); }

test('独孤九式、六脉六式恢复；掉档、换剑法、气不足不重置各档进度', () => {
  assert.equal(SWORD_FORMS.dugu.length, 9); assert.equal(SWORD_FORMS.liumai.length, 6);
  const w = world();
  w.qi = 60; w.step(dt, { ...NO_INTENT, art: 'dugu' });
  assert.equal(w.swordCast?.formIndex, 3); assert.equal(w.qi, 47); finishCast(w);
  w.step(dt, { ...NO_INTENT, art: 'dugu' });
  assert.equal(w.swordCast?.formIndex, 0); finishCast(w);
  w.qi = 60; w.step(dt, { ...NO_INTENT, art: 'liumai' }); finishCast(w);
  assert.deepEqual(w.formProgress.dugu, [1, 1, 0]);
  w.qi = 0; w.step(dt, { ...NO_INTENT, art: 'dugu' });
  assert.deepEqual(w.formProgress.dugu, [1, 1, 0]);
  w.qi = 60; w.step(dt, { ...NO_INTENT, art: 'dugu' });
  assert.equal(w.swordCast?.formIndex, 4);
  const before = structuredClone(w.formProgress); w.beginChapter(); assert.deepEqual(w.formProgress, before);
});

test('连续高档第三次/六脉第二次才收势，100气也能连续释放多招', () => {
  for (const art of ['dugu', 'liumai'] as const) {
    const w = world(); w.qi = 300;
    const count = SWORD_FORMS[art].length / 3;
    for (let i = 0; i < count * 2; i++) {
      w.step(dt, { ...NO_INTENT, art });
      assert.equal(w.swordCast?.full, i % count === count - 1);
      assert.equal(w.swordCast?.formIndex, count * 2 + i % count);
      finishCast(w);
    }
    assert.equal(w.qi, 300 - count * 2 * (art === 'dugu' ? 16 : 21));
  }
  const w = world(); w.qi = 100;
  let casts = 0;
  while (selectSwordForm('dugu', w.qi, w.formProgress.dugu)) {
    w.step(dt, { ...NO_INTENT, art: 'dugu' }); casts++; finishCast(w);
  }
  assert.ok(casts >= 7 && casts <= 10);
});

test('轮换进度持久化兼容旧存档，不接受畸形游标', () => {
  const game = BUILTIN_GAMES[0]!.create({ seed: 1, random: () => 0.5 });
  const w = (game as unknown as { world: World }).world;
  w.qi = 150; w.formProgress.dugu = [2, 1, 2]; w.formProgress.liumai = [1, 1, 1]; w.selectedArt = 'liumai';
  const state = game.serialize?.();
  const other = BUILTIN_GAMES[0]!.create({ seed: 1, random: () => 0.5 }); other.restore?.(state);
  assert.deepEqual(other.serialize?.(), state);
  assert.deepEqual(parseFormProgress({ dugu: [-1, 2, NaN] }).dugu, [0, 0, 0]);
  assert.deepEqual(parseFormProgress({ liumai: [5, 4, 3] }).liumai, [1, 0, 1]);
});

test('两类剑客是持剑人形，精英与剑宗血量有区别，满场不删敌腾位', () => {
  for (const [chapter, boss, variant] of [[5, false, 'qingfeng'], [10, false, 'xuanyi'], [9, true, 'qingfeng'], [18, true, 'xuanyi']] as const) {
    const w = world(); assert.ok(w.spawnDuelist('right', chapter, boss));
    const e = w.enemies[0]!;
    assert.equal(e.duelist, variant); assert.equal(e.armed, true);
    assert.ok(fighterSegments(e).some(s => s.part === 'blade'));
    assert.equal(e.tag, boss ? 'boss' : 'swordsman'); assert.ok(e.hp >= (boss ? 16 : 6));
    w.enemyLimit = 1;
    assert.equal(w.spawnBoss('left'), false); assert.equal(w.spawnDuelist('left', chapter), false);
    assert.deepEqual(w.enemies, [e]);
  }
});

test('剑客正面守势拼剑不扣血，背击、剑法、冲刺能破守；普通有效命中回气', () => {
  for (const attack of ['front', 'back', 'art', 'dash'] as const) {
    const w = world(); w.spawnDuelist('right', 18, true);
    const e = w.enemies[0]!; e.x = w.player.x + w.fh * 0.5; e.face = attack === 'back' ? 1 : -1;
    e.guard = 1; e.cool = 999; e.speed = 0; const hp = e.hp;
    if (attack === 'art') w.qi = 15;
    for (let i = 0; i < 11; i++) {
      e.x = w.player.x + w.fh * 0.5;
      // 锁住背击测试的敌人朝向，隔离AI转身。
      if (attack === 'back') e.windup = 10;
      w.step(dt, { ...NO_INTENT, slash: i === 0 && (attack === 'front' || attack === 'back'),
        art: i === 0 && attack === 'art' ? 'liumai' : undefined, dash: i === 0 && attack === 'dash' });
    }
    if (attack === 'front') { assert.equal(e.hp, hp); assert.equal(w.qi, 4); assert.match(w.artNotice, /拼剑/); }
    else { assert.ok(e.hp < hp); assert.equal(w.qi, attack === 'art' ? 0 : 12); }
  }
});

test('剑客真实出招，红色剑气预览纯渲染；蓄势可打断，准确普攻可截剑', () => {
  for (const chapter of [9, 18]) {
    const w = world(); w.spawnDuelist('right', chapter, true); const e = w.enemies[0]!;
    e.x = w.player.x + w.fh * 1.5; e.cool = 0;
    w.step(dt, NO_INTENT); assert.ok(e.windup >= 0.5);
    for (let i = 0; i < 45 && !e.enemyCast; i++) w.step(dt, NO_INTENT);
    assert.ok(e.enemyCast);
    const before = JSON.stringify(w), calls: number[][] = [];
    e.enemyCast.age = 0.2; const renderState = JSON.stringify(w);
    paintBossPressure({ line: (...a) => { calls.push(a); }, rect: () => {}, circle: () => {} }, w);
    assert.equal(JSON.stringify(w), renderState);
    assert.ok(calls.filter(a => ((a[4]! >> 16) & 255) > ((a[4]! >> 8) & 255)).length > 20);
    assert.notEqual(before, renderState);
    e.enemyCast.age = 0.15; e.enemyCast.pulse = -1; e.enemyCast.x = e.x;
    e.x = w.player.x + w.fh * 1.5; e.enemyCast.x = e.x; e.enemyCast.face = -1;
    w.player.atk = 0.1; w.player.atkHit = false; w.player.invuln = 0;
    w.step(dt, NO_INTENT); assert.equal(w.player.hp, 4); assert.equal(w.qi, 6);
    delete e.enemyCast; e.windup = 0.6; e.invuln = 0; e.x = w.player.x + w.fh * 0.5;
    w.hitstop = 0; w.player.atk = -1; w.step(dt, { ...NO_INTENT, spin: true });
    assert.equal(e.windup, -1); assert.equal(e.enemyCast, undefined);
  }
});

test('剑客攻击命中、跳跃和冲刺躲避有效；死亡不会重置敌人血量', () => {
  for (const dodge of ['none', 'air', 'dash'] as const) {
    const w = world(); w.spawnDuelist('right', 9, true); const e = w.enemies[0]!;
    e.x = w.player.x + w.fh * 1.6; e.face = -1; e.hp = 7;
    e.enemyCast = { art: 'dugu', formIndex: 3, x: e.x, y: w.ground - w.fh * 0.5,
      face: -1, age: 0.15, pulse: -1, level: 1 };
    w.player.invuln = 0;
    if (dodge === 'air') { w.player.y -= w.fh * 0.65; w.player.onGround = false; }
    w.step(dt, { ...NO_INTENT, dash: dodge === 'dash' });
    assert.equal(w.player.hp, dodge === 'none' ? 3 : 4);
    w.respawn = 0.01; w.step(dt, NO_INTENT); assert.equal(e.hp, 7);
  }
});

test('满场收尾战等待空位而非删怪，剑宗存活两分钟仍不跳关，尾刀后才结算', () => {
  for (const chapter of [3, 5, 9, 18]) {
    const w = world(), director = new ChapterDirector(91); director.start(w); director.chapter = chapter;
    w.enemyLimit = 2; director.activeStep = PINCER_END;
    const original = [...w.enemies];
    for (let i = 0; i < CHAPTER_STEPS + 60; i++) director.step(w, dt, NO_INTENT);
    assert.deepEqual(w.enemies, original); assert.equal(director.result, null);
    w.enemies.length = 0; // 模拟已打败开场敌人，只隔离登场门槛。
    director.step(w, dt, NO_INTENT);
    const boss = w.enemies[0]!; assert.ok(boss); assert.equal(director.result, null);
    if (chapter === 9 || chapter === 18) assert.ok(boss.duelist);
    for (let i = 0; i < 7200; i++) director.step(w, dt, NO_INTENT);
    assert.ok(w.enemies.includes(boss)); assert.equal(director.result, null); assert.equal(director.nextChapter(w), false);
    boss.hp = 1; boss.invuln = 0; boss.x = w.player.x + w.fh * 0.4; boss.guard = 0;
    w.hitstop = 0; w.respawn = 0; w.player.y = w.ground; w.player.onGround = true; w.player.atk = -1; w.player.spinCool = 0;
    director.step(w, dt, { ...NO_INTENT, spin: true });
    assert.equal(w.enemies.length, 0); assert.ok(director.result); assert.equal(director.checkpoint()?.result.kills, 1);
  }
});
