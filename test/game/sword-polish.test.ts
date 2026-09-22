import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT, PLAYER_MOVE_MULTIPLIER, SLASH_RECOVERY } from '../../src/core/world.ts';
import { ART_IDS, SWORD_FORMS, artDuration, artRecovery, type SwordArt } from '../../src/core/martial.ts';
import { paintSwordArt } from '../../src/render/wuxia.ts';

const dt = 1 / 60;
function world(): World {
  const w = new World(91, { automaticSpawns: false });
  w.resize(400, 44); w.beginChapter(); w.qi = 300; w.cultivation.insight = 100; w.player.invuln = 999;
  return w;
}
function contour(art: SwordArt, index: number): string {
  const occupied = new Set<string>(), reach = SWORD_FORMS[art][index]!.reach * 26;
  for (const age of [0.12, 0.27, 0.48]) paintSwordArt({
    line: (x0, y0, x1, y1) => {
      for (let i = 0; i <= 12; i++) occupied.add(`${Math.round((x0 + (x1 - x0) * i / 12) / reach * 40)},${Math.round((y0 + (y1 - y0) * i / 12) / 26 * 40)}`);
    }, rect: () => {}, circle: () => {},
  }, { art, formIndex: index, x: 0, y: 0, face: 1, age, level: 1, pulse: 0 }, 26);
  return [...occupied].sort().join(';');
}

test('太极九式去掉颜色和范围差异后仍有九种构图，破剑/破枪不复用同一刺击', () => {
  assert.equal(new Set(SWORD_FORMS.taiji.map((_, i) => contour('taiji', i))).size, 9);
  assert.notEqual(contour('dugu', 1), contour('dugu', 3));
  // 所有门派起式都能凭形态识别，而非只换一个颜色。
  assert.equal(new Set(ART_IDS.map(art => contour(art, 0))).size, ART_IDS.length);
  for (const shape of ['thrust', 'rain', 'ring', 'sweep', 'fan', 'crescent'] as const) {
    const arts = ART_IDS.map(art => [art, SWORD_FORMS[art].findIndex(f => f.shape === shape)] as const).filter(([, i]) => i >= 0);
    assert.equal(new Set(arts.map(([art, i]) => contour(art, i))).size, arts.length, `${shape}不能跨门派套同一模板`);
  }
});

test('所有分式镜像、消散、坐标和笔画上限正确，渲染不改状态', () => {
  for (const art of ART_IDS) for (let index = 0; index < SWORD_FORMS[art].length; index++) {
    for (const age of [0.01, 0.25, 0.5, 0.64]) {
      const cast = { art, formIndex: index, x: 0, y: 0, face: 1 as const, age, level: 5, pulse: 0 };
      const calls: number[][] = [], mirror: number[][] = [], before = JSON.stringify(cast);
      paintSwordArt({ line: (...a) => { calls.push(a); }, rect: () => {}, circle: () => {} }, cast, 26);
      paintSwordArt({ line: (...a) => { mirror.push(a); }, rect: () => {}, circle: () => {} }, { ...cast, face: -1 }, 26);
      assert.equal(JSON.stringify(cast), before);
      assert.ok(calls.length < 1600, `${art}/${index}: ${calls.length}`);
      assert.ok(calls.every(a => a.every(Number.isFinite) && Math.abs(a[1]!) <= 26 * 1.4 && Math.abs(a[3]!) <= 26 * 1.4), `${art}/${index}`);
      assert.deepEqual(mirror, calls.map(a => [-a[0]! || 0, a[1]!, -a[2]! || 0, a[3]!, a[4]!]));
    }
    let calls = 0;
    paintSwordArt({ line: () => { calls++; }, rect: () => {}, circle: () => {} },
      { art, formIndex: index, x: 0, y: 0, face: 1, age: artDuration(art), level: 1, pulse: 0 }, 26);
    assert.equal(calls, 0);
  }
});

test('移动加速只增强玩家步行，敌人和冲刺不联动加速；普通刀260ms内结束', () => {
  const w = world(); assert.equal(w.player.speed, w.fh * 3 * PLAYER_MOVE_MULTIPLIER);
  w.spawnDuelist('right', 9, true); assert.equal(w.enemies[0]!.speed, w.fh * 3 * 0.78);
  const start = w.player.x;
  for (let i = 0; i < 30; i++) w.step(dt, { ...NO_INTENT, move: 1 });
  assert.ok(w.player.x - start > w.fh * 1.65);
  const speed = w.player.speed; w.resizeArena(800); assert.equal(w.player.speed, speed);
  w.step(dt, { ...NO_INTENT, dash: true }); assert.equal(w.player.vx, w.fh * 3 * 3.4);
  const empty = world();
  empty.step(dt, { ...NO_INTENT, slash: true });
  for (let i = 1; i < Math.ceil(SLASH_RECOVERY / dt); i++) empty.step(dt, NO_INTENT);
  assert.equal(empty.player.atk, -1);
});

test('剑招尾光未结束便能接招，最后140ms缓存一次，过早输入不会排长队', () => {
  for (const full of [false, true]) {
    const w = world(); if (full) w.formProgress.dugu[2] = 2;
    w.step(dt, { ...NO_INTENT, art: 'dugu' }); w.hitstop = 0;
    const first = w.swordCast!;
    while (first.age < artRecovery(full) - 0.1) w.step(dt, NO_INTENT);
    w.step(dt, { ...NO_INTENT, art: 'liumai' });
    assert.equal(w.swordCast, first);
    for (let i = 0; i < 10 && w.swordCast === first; i++) w.step(dt, NO_INTENT);
    assert.equal(w.swordCast?.art, 'liumai');
    assert.ok(first.age < artDuration('dugu', full));
    assert.equal(w.cultivation.mastery.dugu, 1); assert.equal(w.cultivation.mastery.liumai, 1);
    for (let i = 0; i < 100; i++) w.step(dt, NO_INTENT);
    assert.equal(w.cultivation.mastery.liumai, 1, '不能留下重复的缓存连发');
  }
  const w = world(); w.step(dt, { ...NO_INTENT, art: 'dugu' });
  w.step(dt, { ...NO_INTENT, art: 'liumai' });
  for (let i = 0; i < 100; i++) w.step(dt, NO_INTENT);
  assert.equal(w.cultivation.mastery.liumai, 0);
});

test('接招缓存遇到气不足或换章不会扣费、跳进度或在下一关幽灵施法', () => {
  for (const reset of [false, true]) {
    const w = world(); w.step(dt, { ...NO_INTENT, art: 'dugu' });
    while (w.swordCast!.age < 0.33) w.step(dt, NO_INTENT);
    w.step(dt, { ...NO_INTENT, art: 'liumai' });
    if (reset) w.beginChapter(); else w.qi = 0;
    for (let i = 0; i < 100; i++) w.step(dt, NO_INTENT);
    assert.equal(w.cultivation.mastery.liumai, 0); assert.deepEqual(w.formProgress.liumai, [0, 0, 0]);
  }
});


test('剑招方向经过顿帧与接招缓存后仍保留，不受后续走位覆盖', () => {
  for (const face of [-1, 1] as const) {
    const w = world(); w.hitstop = 0.04;
    w.step(dt, { ...NO_INTENT, art: 'getsuga', artFace: face });
    for (let i = 0; i < 4; i++) w.step(dt, { ...NO_INTENT, move: face === 1 ? -1 : 1 });
    assert.equal(w.swordCast?.face, face);
    while (w.swordCast!.age < 0.33) w.step(dt, NO_INTENT);
    w.step(dt, { ...NO_INTENT, art: 'feixian', artFace: face });
    for (let i = 0; i < 10; i++) w.step(dt, { ...NO_INTENT, move: face === 1 ? -1 : 1 });
    assert.equal(w.swordCast?.art, 'feixian'); assert.equal(w.swordCast?.face, face);
  }
});
