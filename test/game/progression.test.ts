import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT, bossDifficulty, bossAbilities, bossArmored, bossQuakeOffsets, duelistFormFor, duelistHp, type BossKind } from '../../src/core/world.ts';
import { playerGrowth, GROWTH_INSIGHT } from '../../src/core/martial.ts';
import { chapterPressure } from '../../src/core/chapter.ts';
import { BUILTIN_GAMES } from '../../src/platform/arcade.ts';
import { paintBossPressure } from '../../src/render/wuxia.ts';

const dt = 1 / 60;
function world(): World {
  const w = new World(91, { automaticSpawns: false });
  w.resize(180, 44); w.beginChapter(); w.player.invuln = 99;
  return w;
}
function boss(kind: BossKind, chapter: number) {
  const w = world(); w.spawnBoss('right', chapter, kind); w.hitstop = 0;
  const e = w.enemies[0]!; e.x = w.player.x + w.fh * 0.8; e.face = -1; e.cool = 0;
  return { w, e };
}
function launch(w: World): void {
  for (let i = 0; i < 120 && !w.enemies[0]!.atkSeq; i++) w.step(dt, NO_INTENT);
  assert.equal(w.enemies[0]!.atkSeq, 1);
}

test('关卡压力与血量缓升：首次剑宗不跳血，63关封顶且不随场景重置', () => {
  assert.deepEqual([1, 3, 4, 9, 10, 19, 22, 999].map(chapterPressure), [0, 0, 1, 2, 3, 6, 7, 7]);
  const hp = [3, 6, 9, 12, 15, 18, 21, 24, 27].map(c => c % 9 ? bossDifficulty(c).hp : duelistHp(c, true));
  assert.deepEqual(hp, [5, 6, 8, 8, 9, 11, 11, 12, 14]);
  for (let i = 1; i < hp.length; i++) assert.ok(hp[i]! >= hp[i - 1]! && hp[i]! - hp[i - 1]! <= 2);
  assert.equal(duelistHp(5), 3); assert.equal(duelistHp(63), 8);
  assert.equal(bossDifficulty(63).hp, 25); assert.equal(duelistHp(63, true), 26);
  assert.deepEqual(bossDifficulty(63), bossDifficulty(999));
  let previous = bossDifficulty(3);
  for (let c = 6; c <= 63; c += 3) {
    const next = bossDifficulty(c);
    assert.equal(next.hp - previous.hp, 1);
    assert.ok(next.speed - previous.speed <= 0.020001);
    assert.ok(previous.windup - next.windup <= 0.010001);
    assert.ok(previous.cooldown - next.cooldown <= 0.017501);
    previous = next;
  }
});

test('第3关螳螂只单斩，残血也不越级；第21关双斩，第39关才有短控和金色蓄势', () => {
  for (const chapter of [3, 21, 39]) {
    const { w, e } = boss('mantis', chapter); e.hp = 1;
    e.windup = 0.15;
    assert.equal(bossArmored(e), chapter === 39);
    launch(w);
    assert.equal((e.followupT ?? 0) > 0, chapter > 3);
    assert.equal(w.slashes.length, 1);
    if (chapter > 3) {
      w.player.invuln = 0;
      for (let i = 0; i < 17; i++) w.step(dt, NO_INTENT);
      assert.equal(w.player.hp, 3);
      assert.equal((w.player.stunT ?? 0) > 0, chapter === 39);
    } else {
      for (let i = 0; i < 25; i++) w.step(dt, NO_INTENT);
      assert.equal(e.followupT, undefined); assert.ok(e.cool > 0);
    }
  }
});

test('首次甲虫短冲撞且无强击退，后续延长；预警与实际冲程同步', () => {
  const durations: number[] = [];
  for (const chapter of [6, 24, 63]) {
    const { w, e } = boss('scarab', chapter);
    w.step(dt, NO_INTENT);
    const kit = bossAbilities(e), lines: number[][] = [];
    paintBossPressure({ line: (...args) => lines.push(args), rect: () => {}, circle: () => {} }, w);
    const end = Math.max(0, e.x - e.speed * 6.5 * kit.chargeTime - e.h * 0.8);
    assert.ok(lines.some(line => Math.abs(line[2]! - end) < 1e-6 && line[3] === w.ground - 0.6));
    launch(w); durations.push(e.dashT);
    assert.equal(kit.push, chapter >= 24);
  }
  assert.ok(durations[0]! < durations[1]! && durations[1]! < durations[2]!);
  assert.ok(durations[0]! <= 0.23); assert.equal(durations[2], 0.32);
});

test('初遇冰晶只有一处冰阵和轻减速，后期三处增强；预警数量等于命中区域', () => {
  for (const chapter of [12, 30]) {
    const { w, e } = boss('crystal', chapter);
    w.step(dt, NO_INTENT);
    assert.equal(bossQuakeOffsets(e).length, chapter === 12 ? 1 : 3);
    const lines: number[][] = [];
    paintBossPressure({ line: (...args) => lines.push(args), rect: () => {}, circle: () => {} }, w);
    assert.equal(lines.filter(line => line[4] === 0x8cddff).length, chapter === 12 ? 1 : 3);
    launch(w);
    assert.equal(w.hazards.length, chapter === 12 ? 1 : 3);
    const hit = w.hazards.find(h => h.x === w.player.x)!;
    hit.timer = 0; w.player.invuln = 0;
    w.step(dt, NO_INTENT);
    assert.equal(w.player.hp, 3);
    assert.ok(Math.abs(w.player.slowT! - (chapter === 12 ? 0.4 : 0.8)) < 1e-6);
    assert.ok(Math.abs(w.player.slowFactor! - (chapter === 12 ? 0.8 : 0.6)) < 1e-6);
  }
});

test('早期剑客/剑宗只教一式且不自动格挡，中后期再增加剑式和守势', () => {
  for (const chapter of [5, 9, 18, 27]) {
    const w = world(); w.spawnDuelist('right', chapter, chapter !== 5);
    const e = w.enemies[0]!, forms = new Set<number>();
    for (let n = 0; n < 6; n++) { e.atkSeq = n; forms.add(duelistFormFor(e).formIndex); }
    assert.equal(forms.size, chapter <= 9 ? 1 : chapter === 18 ? 2 : 3);
    e.pressureHits = 2; e.cool = 99; e.x = w.player.x + w.fh * 0.5;
    w.step(dt, { ...NO_INTENT, spin: true });
    assert.equal((e.guard ?? 0) > 0, chapter >= 18);
  }
});

test('修为按阅历阈值提升并封顶：生命4→7、冷却逐步缩短，霸体适度增强', () => {
  assert.deepEqual(GROWTH_INSIGHT.map(n => playerGrowth(n).maxHp), [4, 4, 5, 5, 6, 6, 7]);
  for (let i = 1; i < GROWTH_INSIGHT.length; i++) {
    assert.equal(playerGrowth(GROWTH_INSIGHT[i]! - 1).level, i);
    assert.equal(playerGrowth(GROWTH_INSIGHT[i]!).level, i + 1);
  }
  const max = playerGrowth(540);
  assert.equal(max.maxHp, 7); assert.equal(max.armorCooldown, 4.5);
  assert.equal(max.armorDuration, 1.04); assert.ok(Math.abs(max.skillCooldown - 0.82) < 1e-6);
  assert.equal(max.nextInsight, null); assert.deepEqual(playerGrowth(999999), max);
});

test('实际击破触发升级，只补新增血格；重复刷新、resize不回血，死亡升级不复活', () => {
  const w = world(); w.cultivation.insight = 59; w.player.hp = 2;
  w.spawnFormation({ kind: 'single', side: 'right' }); w.enemies[0]!.x = w.player.x + w.fh * 0.4;
  w.step(dt, { ...NO_INTENT, spin: true });
  assert.equal(w.cultivation.insight, 60); assert.equal(w.player.maxHp, 5); assert.equal(w.player.hp, 3);
  assert.match(w.artNotice, /修为3重/);
  w.refreshPlayerGrowth(); w.resize(150, 40);
  assert.equal(w.player.hp, 3);
  w.player.hp = 0; w.respawn = 1; w.cultivation.insight = 540; w.refreshPlayerGrowth();
  assert.equal(w.player.hp, 0); assert.equal(w.player.maxHp, 7);
  w.beginChapter(); assert.equal(w.player.hp, 7);
});

test('成长真的缩短技能冷却、延长护体；不改变普攻伤害、冲刺速度或敌人移速', () => {
  for (const action of ['dash', 'spin', 'armor'] as const) {
    const results = [0, 540].map(insight => {
      const w = world(); w.cultivation.insight = insight; w.refreshPlayerGrowth(true);
      w.spawnBoss('right', 3, 'mantis'); w.enemies[0]!.x = w.player.x + w.fh * 0.4;
      w.enemies[0]!.cool = 99; w.hitstop = 0;
      const speed = w.enemies[0]!.speed;
      w.step(dt, { ...NO_INTENT, [action]: true });
      return { p: w.player, enemyHp: w.enemies[0]!.hp, speed };
    });
    assert.equal(results[0]!.speed, results[1]!.speed);
    assert.equal(results[0]!.enemyHp, results[1]!.enemyHp);
    if (action === 'armor') {
      assert.ok(results[1]!.p.armorCool! < results[0]!.p.armorCool!);
      assert.ok(results[1]!.p.armorT! > results[0]!.p.armorT!);
    } else {
      assert.ok(results[1]!.p[action === 'dash' ? 'dashCool' : 'spinCool'] < results[0]!.p[action === 'dash' ? 'dashCool' : 'spinCool']);
      assert.equal(results[0]!.p.vx, results[1]!.p.vx);
    }
  }
});

test('现有存档的阅历自动恢复成长，HUD显示真实生命上限；坏存档不改当前属性', () => {
  const make = () => BUILTIN_GAMES[0]!.create({ seed: 91, random: () => 0.5 });
  const game = make(), w = (game as unknown as { world: World }).world;
  w.cultivation.insight = 540; w.refreshPlayerGrowth(true);
  const state = game.serialize?.();
  const restored = make(), restoredWorld = (restored as unknown as { world: World }).world;
  restored.restore?.(state);
  assert.equal(restoredWorld.player.maxHp, 7); assert.equal(restoredWorld.player.hp, 7);
  assert.match(restored.hud!(), /血7\/7/); assert.match(restored.hud!(), /修7重/);
  assert.deepEqual(restored.serialize?.(), state);
  restored.restore?.({ ...(state as object), cultivation: { insight: -1 } });
  assert.equal(restoredWorld.player.maxHp, 7);
  const legacy = make(); legacy.restore?.({ version: 1, kills: 220, bestCombo: 10, checkpoint: null });
  assert.match(legacy.hud!(), /血6\/6/);
  restored.restore?.({ version: 1, kills: 0, bestCombo: 0, checkpoint: null });
  assert.equal(restoredWorld.player.maxHp, 4); assert.equal(restoredWorld.player.hp, 4);
});
