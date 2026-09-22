import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT, bossDifficulty, bossPhase, bossQuakeOffsets } from '../../src/core/world.ts';
import { MAX_QI, BOSS_HIT_QI, SWORD_ARTS, SWORD_FORMS, selectSwordForm, currentSwordForm,
  artLevel, parseCultivation, type SwordArt } from '../../src/core/martial.ts';
import { paintLandmark, paintSwordArt, type ArtPen } from '../../src/render/wuxia.ts';
import { sceneForChapter } from '../../src/render/theme.ts';
import { pixelCamera } from '../../src/render/pixel-scene.ts';
import { fieldColsFor } from '../../src/shell/regions.ts';
import { fighterSegments } from '../../src/core/creature.ts';
import { ChapterDirector, CHAPTER_STEPS, parseChapterCheckpoint } from '../../src/core/chapter.ts';
import { BUILTIN_GAMES, Arcade } from '../../src/platform/arcade.ts';
import type { GameInput, GameModule } from '../../src/platform/types.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dt = 1 / 60;
function world(): World {
  const w = new World(71, { automaticSpawns: false });
  w.resize(180, 44); w.beginChapter();
  return w;
}
const none: GameInput = { left: false, right: false, up: false, down: false, jump: false, primary: false, secondary: false };

test('同门三档保持不同轨迹：归一化范围后仍有独立轮廓，三档完整', () => {
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) {
    assert.equal(new Set(SWORD_FORMS[art].map(f => f.qi)).size, 3);
    const contours = new Set<string>();
    for (let tier = 0; tier < 3; tier++) {
      const calls: number[][] = [];
      const formIndex = tier * SWORD_FORMS[art].length / 3;
      const form = SWORD_FORMS[art][formIndex]!;
      for (const progress of [0.2, 0.5, 0.8])
        paintSwordArt({ line: (...args) => { calls.push(args); }, rect: () => {}, circle: () => {} },
          { art, x: 0, y: 0, face: 1, age: progress * 0.65, pulse: 0, level: 1, formIndex }, 26);
      // 忽略颜色、笔画重复次数与攻击距离，检查二维占用轮廓。
      const occupied = new Set<string>();
      for (const a of calls) for (let i = 0; i <= 12; i++) {
        const u = i / 12;
        occupied.add(`${Math.round((a[0]! + (a[2]! - a[0]!) * u) / (26 * form.reach) * 20)},${Math.round((a[1]! + (a[3]! - a[1]!) * u) / 26 * 20)}`);
      }
      contours.add([...occupied].sort().join(';'));
    }
    assert.equal(contours.size, 3, `${art} 不能只是增亮/复制/拉长同一式`);
  }
});

test('Boss普通有效命中回气，空挥/无敌/剑招不回气，封顶300', () => {
  for (const attack of ['slash', 'dash', 'spin'] as const) for (const immune of [false, true]) {
    const w = world(); w.spawnBoss('right', 33); w.hitstop = 0;
    const boss = w.enemies[0]!, hp = boss.hp;
    w.player.invuln = 999; boss.cool = 999;
    for (let frame = 0; frame < 22; frame++) {
      boss.x = w.player.x + w.fh * 0.5;
      if (immune) boss.invuln = 99;
      w.step(dt, { ...NO_INTENT, [attack]: frame === 0 });
    }
    assert.equal(w.qi, (hp - boss.hp) * BOSS_HIT_QI, attack);
    assert.equal(w.qi > 0, !immune, attack);
  }
  const w = world(); w.spawnBoss('right', 33); w.hitstop = 0;
  const boss = w.enemies[0]!; boss.cool = 999; w.player.invuln = 999;
  w.qi = 300;
  for (let frame = 0; frame < 100; frame++) {
    boss.x = w.player.x + w.fh * 0.5;
    w.step(dt, { ...NO_INTENT, art: frame === 0 ? 'dugu' : undefined });
  }
  assert.equal(w.qi, 284, '高档剑招打Boss不充能，只扣16气');
  w.qi = 297; boss.invuln = 0; boss.x = w.player.x + w.fh * 0.5;
  w.step(dt, { ...NO_INTENT, spin: true }); assert.equal(w.qi, 300);
  const empty = world(); empty.step(dt, { ...NO_INTENT, spin: true }); assert.equal(empty.qi, 0);
});

test('剑招演出期间的普通击杀仍回气，不受整帧casting标记误伤', () => {
  const w = world(); w.qi = 100; w.step(dt, { ...NO_INTENT, art: 'dugu' });
  for (let i = 0; i < 8; i++) w.step(dt, NO_INTENT);
  w.spawnFormation({ kind: 'single', side: 'left' });
  w.enemies[0]!.x = w.player.x - w.fh * 0.8;
  w.step(dt, { ...NO_INTENT, spin: true });
  assert.ok(w.swordCast); assert.equal(w.kills, 1); assert.equal(w.qi, 96);
});

test('宽视口真正扩展可走边界，速度不变；重复配置和切换不重置战斗', () => {
  for (const [width, height, tier] of [[2096, 68, 'graphics'], [262, 24, 'braille'], [262, 32, 'braille']] as const) {
    const game = BUILTIN_GAMES[0]!.create({ seed: 71, random: () => 0.5 });
    const w = (game as unknown as { world: World }).world;
    const speed = w.player.speed, fraction = w.player.x / w.w;
    w.qi = 172; w.player.y -= 5; w.player.onGround = false; w.player.vy = -20;
    game.configureViewport?.(width, height, tier);
    const arena = width * 48 / Math.min(height, tier === 'graphics' ? height : 24);
    assert.equal(w.w, arena); assert.equal(w.player.x / w.w, fraction);
    assert.equal(w.player.speed, speed); assert.equal(w.player.vy, -20); assert.equal(w.player.onGround, false);
    if (tier === 'graphics') {
      const camera = pixelCamera(width, height, w);
      assert.ok(Math.abs(camera.x(0)) < 1e-8);
      assert.ok(Math.abs(camera.x(w.w) - width) < 1e-8);
    }
    const state = JSON.stringify(w); game.configureViewport?.(width, height, tier);
    assert.equal(JSON.stringify(w), state, '每帧配置不能改变世界');
    game.configureViewport?.(80, 8, 'braille');
    assert.equal(w.w, 90); assert.equal(w.qi, 172); assert.equal(w.player.speed, speed);
    game.configureViewport?.(NaN, 0, 'graphics'); assert.equal(w.w, 90);
  }
});

test('加宽背景续接地标，不改变单座建筑比例；每幅只有一轮月亮', () => {
  for (const chapter of [1, 2, 3, 4, 5, 6]) {
    const draw = (width: number) => {
      const lines: number[][] = [], circles: number[][] = [];
      paintLandmark({ line: (...a) => { lines.push(a); }, rect: (...a) => { lines.push(a); },
        circle: (...a) => { circles.push(a); } }, width, 40, sceneForChapter(chapter));
      return { lines, circles };
    };
    const narrow = draw(180), wide = draw(540);
    assert.equal(wide.lines.length, narrow.lines.length * 3);
    assert.deepEqual(wide.lines.slice(0, narrow.lines.length), narrow.lines);
    assert.equal(wide.circles.length, 1); assert.equal(wide.circles[0]![2], narrow.circles[0]![2]);
  }
});

test('紧凑地图在不同窗口下约为旧版半宽，人物速度与身高不变', () => {
  for (const cols of [60, 80, 120, 200]) for (const tier of ['graphics', 'braille'] as const) {
    const game = BUILTIN_GAMES[0]!.create({ seed: 71, random: () => 0.5 });
    const w = (game as unknown as { world: World }).world;
    const height = tier === 'graphics' ? 68 : 24, density = tier === 'graphics' ? 16 : 2;
    const oldCols = cols - Math.floor((cols - 1) / 3) - 3;
    const oldArena = Math.max(180, oldCols * density * 48 / height);
    const speed = w.player.speed, bodyHeight = w.fh;
    game.configureViewport?.(fieldColsFor(cols) * density, height, tier);
    assert.ok(Math.abs(w.w / oldArena - 0.5) < 0.025, String(cols));
    assert.equal(w.player.speed, speed); assert.equal(w.fh, bodyHeight);
    w.player.invuln = 999;
    for (let i = 0; i < 600; i++) w.step(dt, { ...NO_INTENT, move: 1 });
    assert.ok(w.player.x > w.w * 0.8, '缩图后右侧仍可走到');
  }
});

test('重绘奥义不越出人物高度带，几何与画笔开销均有界', () => {
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) for (const age of [0.02, 0.3, 0.6, 0.9, 1.1]) {
    const calls: number[][] = [];
    const pen: ArtPen = { line: (...a) => { calls.push(a); }, rect: () => {}, circle: () => {} };
    paintSwordArt(pen, { art, x: 0, y: 0, face: 1, age, level: 5, pulse: 0, full: true }, 26);
    assert.ok(calls.every(a => Math.abs(a[1]!) < 26 * 1.4 && Math.abs(a[3]!) < 26 * 1.4), art);
    assert.ok(calls.length < 1500, art);
    assert.ok(calls.flat().every(Number.isFinite), art);
  }
});

test('七套剑法有不同实心轮廓、正确镜像与消散，起势和收势不会定格', () => {
  const outlines = new Set<string>();
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) {
    const draw = (age: number, face: 1 | -1) => {
      const calls: number[][] = [];
      paintSwordArt({ line: (...a) => { calls.push(a); }, rect: () => {}, circle: () => {} },
        { art, x: 0, y: 0, face, age, level: 1, pulse: 0, full: true }, 26);
      return calls;
    };
    const first = draw(0.1, 1), middle = draw(0.45, 1), last = draw(1.1, 1);
    assert.notDeepEqual(first, middle, art); assert.notDeepEqual(middle, last, art);
    assert.deepEqual(draw(1.2, 1), [], '收势结束不能残留特效');
    assert.deepEqual(draw(0.45, -1), middle.map(a => [-a[0]! || 0, a[1]!, -a[2]! || 0, a[3]!, a[4]!]));
    outlines.add(JSON.stringify(middle.map(a => a.slice(0, 4))));
  }
  assert.equal(outlines.size, 7, '不能只用换色区分剑法');
});

test('三档门槛与轮换全覆盖，每式只扣少量气，高气不强制覆盖为奥义', () => {
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) {
    const forms = SWORD_FORMS[art];
    assert.equal(selectSwordForm(art, forms[0]!.qi - 1), null);
    assert.equal(selectSwordForm(art, NaN), null);
    const count = forms.length / 3;
    for (let tier = 0; tier < 3; tier++) for (let offset = 0; offset < count; offset++) {
      const min = [SWORD_ARTS[art].cost, 60, 100][tier]!, max = [59, 99, 300][tier]!;
      for (const qi of [min, max]) {
        const index = tier * count + offset, progress = [0, 0, 0]; progress[tier] = offset;
        const cost = SWORD_ARTS[art].cost + tier * 3;
        assert.deepEqual(selectSwordForm(art, qi, progress), { index, tier, full: tier === 2 && offset === count - 1, cost });
        const w = world(); w.qi = qi; w.cultivation.insight = 100; w.formProgress[art] = [...progress] as [number, number, number];
        w.step(dt, { ...NO_INTENT, art });
        assert.equal(w.qi, qi - cost); assert.equal(w.swordCast?.formIndex, index);
        assert.equal(w.formProgress[art][tier], (offset + 1) % count);
      }
    }
    for (const qi of [100, 101, 200, 300]) {
      const w = world(); w.qi = qi; w.cultivation.insight = 100;
      w.step(dt, { ...NO_INTENT, art });
      assert.equal(w.qi, qi - SWORD_ARTS[art].cost - 6); assert.equal(w.swordCast?.full, false);
    }
  }
});

test('高档末式带统一收招：可移动，只计一次熟练度，演出中不重扣费', () => {
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) {
    const w = world(); w.qi = 100; w.cultivation.insight = 100;
    w.formProgress[art][2] = SWORD_FORMS[art].length / 3 - 1;
    const x = w.player.x;
    w.step(dt, { ...NO_INTENT, art });
    assert.equal(w.swordCast?.full, true);
    const finisher = SWORD_FORMS[art].at(-1)!;
    for (let i = 0; i < 90; i++) {
      if (w.swordCast) assert.equal(currentSwordForm(w.swordCast), finisher, '奥义始终收束在同一记收招上');
      w.step(dt, { ...NO_INTENT, move: 1, art: i < 45 && i % 20 === 0 ? art : undefined });
    }
    assert.equal(w.swordCast, null); assert.equal(w.qi, 100 - SWORD_ARTS[art].cost - 6);
    assert.equal(w.cultivation.mastery[art], 1);
    assert.ok(w.player.x > x && w.player.invuln <= 0, '不能做成锁移动或整套无敌的过场');
  }
});

test('独孤收势对同一Boss最多三次伤害；死亡和换章清掉演出状态', () => {
  const w = world(); w.qi = 100; w.spawnBoss('right', 33); w.hitstop = 0;
  w.formProgress.dugu[2] = 2;
  const boss = w.enemies[0]!; const hp = boss.hp;
  w.player.invuln = 999;
  for (let i = 0; i < 210; i++) {
    boss.x = w.player.x + w.fh * 0.5; boss.cool = 99; boss.windup = -1;
    w.step(dt, { ...NO_INTENT, art: i === 0 ? 'dugu' : undefined });
  }
  assert.equal(hp - boss.hp, 3); assert.equal(w.swordCast, null);
  w.qi = 100; w.step(dt, { ...NO_INTENT, art: 'dugu' });
  w.beginChapter(); assert.equal(w.swordCast, null);
  w.qi = 100; w.spawnBoss('right', 33); w.hitstop = 0;
  w.step(dt, { ...NO_INTENT, art: 'dugu' });
  w.player.hp = 1; w.player.invuln = 0;
  w.hazards.push({ x: w.player.x, radius: w.fh, timer: 0, life: 0.4, hit: false });
  // 奥义起手自带 70ms 顿帧，地刺要等节拍过去才结算 —— 多给几帧。
  for (let i = 0; i < 8 && w.respawn <= 0; i++) w.step(dt, NO_INTENT);
  assert.ok(w.respawn > 0); assert.equal(w.swordCast, null, '死亡必须终止全套，不能死后继续自动杀敌');
});

test('所有分式有独立几何演出，奥义是同一剑法的加强构图而非轮播', () => {
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) {
    const shapes = new Set<string>();
    const counts: number[] = [];
    for (let index = 0; index < SWORD_FORMS[art].length; index++) {
      const calls: number[][] = [];
      const pen: ArtPen = { line: (...args) => { calls.push(args); }, rect: (...args) => { calls.push(args); }, circle: (...args) => { calls.push(args); } };
      const cast = { art, x: 60, y: 25, face: 1 as const, age: 0.15, level: 1, pulse: 0, formIndex: index };
      paintSwordArt(pen, cast, 26); assert.ok(calls.length > 0);
      shapes.add(JSON.stringify(calls)); counts.push(calls.length);
    }
    assert.equal(shapes.size, SWORD_FORMS[art].length, `${art}不能只换名字不换演出`);
    // 奥义不轮播分式：1.2s 内的任何时刻都收束在最后一式的强化构图上，且比起手式更丰满。
    const finisher = SWORD_FORMS[art].at(-1)!;
    for (const age of [0.05, 0.3, 0.6, 0.9, 1.1]) {
      assert.equal(currentSwordForm({ art, x: 60, y: 25, face: 1, age, level: 1, pulse: 0, full: true }), finisher);
    }
    const fullCalls: number[][] = [];
    const pen: ArtPen = { line: (...args) => { fullCalls.push(args); }, rect: (...args) => { fullCalls.push(args); }, circle: (...args) => { fullCalls.push(args); } };
    paintSwordArt(pen, { art, x: 60, y: 25, face: 1, age: 0.6, level: 1, pulse: 0, full: true }, 26);
    assert.ok(fullCalls.length > 0 && fullCalls.length < 1500, `${art}收势必须清晰且有界，不以光效数量衡量`);
  }
});

test('Boss按关卡渐强且封顶，血量比例驱动阶段，前摇最低500ms', () => {
  let priorHp = 0, priorSpeed = 0;
  for (const chapter of [3, 6, 9, 12, 15, 30, 33, 99, 999]) {
    const d = bossDifficulty(chapter), w = world();
    w.spawnBoss('right', chapter);
    const boss = w.enemies[0]!;
    assert.equal(boss.hp, d.hp); assert.equal(boss.maxHp, d.hp);
    assert.ok(d.hp >= priorHp && d.speed >= priorSpeed);
    assert.ok(d.hp <= 25 && d.speed <= 1.4 && d.cooldown >= 0.65 && d.windup >= 0.5);
    assert.equal(bossPhase(boss.hp, boss.maxHp), 1);
    assert.equal(bossPhase(Math.ceil(boss.maxHp! * 0.6), boss.maxHp), 2);
    assert.equal(bossPhase(1, boss.maxHp), 3);
    assert.equal(bossQuakeOffsets(boss).length, chapter >= 15 ? 5 : 3);
    boss.cool = 0; boss.atkSeq = 1; w.hitstop = 0;
    w.step(dt, NO_INTENT);
    assert.ok(Math.abs(boss.windup - d.windup) < 1e-6);
    for (let i = 0; i < 60 && w.hazards.length === 0; i++) w.step(dt, NO_INTENT);
    assert.equal(w.hazards.length, chapter >= 15 ? 5 : 3);
    assert.ok(boss.cool >= 0.9 * d.cooldown - dt && boss.cool <= 1.5 * d.cooldown);
    priorHp = d.hp; priorSpeed = d.speed;
  }
  assert.equal(bossDifficulty(3).hp, 5); assert.equal(bossDifficulty(6).hp, 7);
  assert.deepEqual(bossDifficulty(33), bossDifficulty(3003), '场景循环不能重置Boss难度');
});

test('百关持续推进且检查点可恢复，敌人与碎片数量有界', () => {
  const w = world(); w.enemyLimit = 6;
  const director = new ChapterDirector(71); director.start(w);
  for (let chapter = 1; chapter <= 101; chapter++) {
    for (let frame = 0; frame < CHAPTER_STEPS; frame++) {
      director.step(w, dt, { ...NO_INTENT, slash: frame % 15 === 0, spin: frame % 100 === 0 });
      assert.ok(w.enemies.length <= 6 && w.pieces.length <= 150);
      const boss = w.enemies.find(e => e.tag === 'boss');
      if (boss) assert.equal(boss.maxHp, boss.duelist ? 16 + bossDifficulty(chapter).rank * 2 : bossDifficulty(chapter).hp);
    }
    for (let overtime = 0; overtime < 3600 && director.result === null; overtime++) {
      const target = w.enemies.reduce((a, b) => Math.abs(a.x - w.player.x) < Math.abs(b.x - w.player.x) ? a : b, w.enemies[0]!);
      director.step(w, dt, { ...NO_INTENT, move: target ? target.x > w.player.x ? 1 : -1 : 0,
        slash: overtime % 18 === 0, spin: overtime % 100 === 0 });
    }
    assert.equal(director.result?.chapter, chapter);
    assert.ok(parseChapterCheckpoint(director.checkpoint()));
    assert.equal(director.nextChapter(w), true);
  }
  assert.equal(director.chapter, 102);
  const restored = new ChapterDirector(1);
  assert.equal(restored.restore(world(), director.checkpoint()), true);
  assert.equal(restored.chapter, 101);
});

test('命中停顿中的攻击和跳跃不会被吃掉；普通刀 150ms 内命中', () => {
  const w = world(); w.spawnFormation({ kind: 'pair', side: 'right' });
  w.hitstop = 0.033;
  w.step(dt, { ...NO_INTENT, slash: true });
  for (let i = 0; i < 11; i++) w.step(dt, NO_INTENT);
  assert.equal(w.kills, 2);
  assert.equal(w.qi, 24);
  w.hitstop = 0.033;
  w.step(dt, { ...NO_INTENT, jump: true });
  for (let i = 0; i < 4; i++) w.step(dt, NO_INTENT);
  assert.equal(w.player.onGround, false);
});

test('起手中按下一刀会接招，走位与冲刺取消不受长硬直阻挡', () => {
  const w = world();
  w.step(dt, { ...NO_INTENT, slash: true });
  w.step(dt, { ...NO_INTENT, slash: true, move: 1 });
  assert.ok(w.player.vx > 0);
  for (let i = 0; i < 18; i++) w.step(dt, NO_INTENT);
  assert.ok(w.player.atk >= 0 && w.player.atk < 0.1);
  w.step(dt, { ...NO_INTENT, dash: true });
  for (let i = 0; i < 10; i++) w.step(dt, NO_INTENT);
  assert.ok(w.player.dashT > 0, '起手中的冲刺应缓存到命中后取消');
});

test('剑招检查解锁与剑气，失败不扣费、不加熟练度', () => {
  const w = world(); w.qi = 100;
  w.step(dt, { ...NO_INTENT, art: 'liumai' });
  assert.equal(w.swordCast, null); assert.equal(w.qi, 100);
  w.qi = 9;
  w.step(dt, { ...NO_INTENT, art: 'dugu' });
  assert.equal(w.swordCast, null); assert.equal(w.qi, 9);
  assert.equal(w.cultivation.mastery.dugu, 0);
});

test('七套高档剑招真实命中且只扣单式费用；剑招击杀不给自己充能', () => {
  for (const art of Object.keys(SWORD_ARTS) as SwordArt[]) {
    const w = world(); w.qi = 100; w.cultivation.insight = 100;
    w.spawnFormation({ kind: 'pair', side: 'right' });
    w.step(dt, { ...NO_INTENT, art });
    assert.equal(w.kills, 2, art);
    assert.equal(w.qi, 100 - SWORD_ARTS[art].cost - 6, art);
    assert.equal(w.cultivation.mastery[art], 1);
    for (let i = 0; i < 180; i++) w.step(dt, NO_INTENT);
    assert.equal(w.swordCast, null);
    assert.equal(w.cultivation.insight, 102);
  }
});

test('剑招攻击范围有方向，六脉够远，太极可打身后', () => {
  // thrust 只打面前，ring 顾得上身后；强化式比起手式伸得更远。
  for (const [art, qi, offset, kills] of [
    ['dugu', 10, 3, 0], ['dugu', 60, 3, 1],
    ['liumai', 15, 3, 1], ['liumai', 15, -1, 0], ['taiji', 15, -1, 1],
  ] as const) {
    const w = world(); w.qi = qi; w.cultivation.insight = 100;
    w.spawnFormation({ kind: 'single', side: 'right' });
    w.enemies[0]!.x = w.player.x + offset * w.fh;
    w.step(dt, { ...NO_INTENT, art });
    assert.equal(w.kills, kills, `${art} qi=${qi} offset=${offset}`);
  }
});

test('熟练度升级、合法存档隔离副本、畸形值拒绝', () => {
  const w = world(); w.cultivation.mastery.dugu = 6;
  assert.equal(artLevel(w.cultivation, 'dugu'), 2);
  const p = parseCultivation(w.cultivation)!; p.mastery.dugu++;
  assert.equal(w.cultivation.mastery.dugu, 6);
  for (const value of [null, {}, { insight: -1, mastery: {} }, { insight: 0, mastery: { dugu: NaN, liumai: 0, taiji: 0 } }]) assert.equal(parseCultivation(value), null);
});

test('四种怪物有不同轮廓、4/6/8 条脚，行走改变足部位置', () => {
  const w = world(); w.spawnFormation({ kind: 'single', side: 'right' });
  const f = w.enemies[0]!;
  const shapes = new Set<string>();
  for (const tag of ['grunt', 'runner', 'brute', 'boss'] as const) {
    f.tag = tag;
    const segs = fighterSegments(f);
    assert.equal(segs.filter(s => s.part === 'legB').length, tag === 'boss' ? 8 : tag === 'runner' ? 4 : 6);
    shapes.add(JSON.stringify(segs));
    assert.notDeepEqual(fighterSegments({ ...f, walk: 0.25 }), segs);
  }
  assert.equal(shapes.size, 4);
});

test('剑谱与剑气跨会话保存，旧存档迁移后可无限继续，坏存档不部分恢复', () => {
  const create = () => BUILTIN_GAMES[0]!.create({ seed: 31, random: () => 0.5 });
  const game = create();
  game.restore?.({ version: 2, kills: 36, bestCombo: 4, checkpoint: null, qi: 100,
    cultivation: { insight: 36, mastery: { dugu: 6, liumai: 4, taiji: 0 } } });
  game.update(dt, { ...none, down: true, secondary: true });
  const state = game.serialize?.();
  const restored = create(); restored.restore?.(state);
  assert.deepEqual(restored.serialize?.(), state);
  restored.restore?.({ ...(state as object), qi: MAX_QI + 1 });
  assert.deepEqual(restored.serialize?.(), state);
  for (let i = 0; i < 1900; i++) restored.update(dt, none);
  assert.match(restored.hud?.() ?? '', /清场中/, '不再被时间强制跳关');
});

test('组合键支持分块顺序输入；终端回复不会触发招式或移动', () => {
  const received: GameInput[] = [];
  const module: GameModule = { manifest: { ...BUILTIN_GAMES[0]!.manifest, id: 'input-test' }, create: () => ({
    update: (_dt, input) => received.push(input), render: () => {}, renderMicro: () => {},
  }) };
  const dir = mkdtempSync(join(tmpdir(), 'moyu-input-'));
  const arcade = new Arcade(join(dir, 'events'), [module]);
  arcade.enter(); arcade.advance(1000);
  arcade.feed(Buffer.from('s'), 1001); arcade.advance(1017);
  arcade.feed(Buffer.from('i'), 1100); arcade.advance(1117);
  assert.ok(received.some(i => i.art === 'liumai'));
  arcade.keys.clear(); received.length = 0;
  arcade.feed(Buffer.from('\x1b['), 1200);
  arcade.feed(Buffer.from('D'), 1201); arcade.advance(1217);
  assert.ok(received.some(i => i.left));
  arcade.keys.clear(); received.length = 0;
  arcade.feed(Buffer.from('\x1b]11;rgb:aaaa/ffff/dddd\x07'), 1300); arcade.advance(1317);
  assert.ok(received.every(i => !i.primary && !i.left && !i.right && !i.art));
});

test('剑气能越过100，300封顶，高于100的老版本结构存档可往返保存', () => {
  for (const [initial, expected] of [[96, 120], [290, 300]] as const) {
    const w = world(); w.qi = initial; w.spawnFormation({ kind: 'pair', side: 'right' });
    w.step(dt, { ...NO_INTENT, slash: true });
    for (let i = 0; i < 15; i++) w.step(dt, NO_INTENT);
    assert.equal(w.qi, expected);
  }
  const game = BUILTIN_GAMES[0]!.create({ seed: 71, random: () => 0.5 });
  const save = { version: 2, kills: 100, bestCombo: 4, checkpoint: null, qi: 172,
    cultivation: { insight: 100, mastery: { dugu: 6, liumai: 2, taiji: 0 } } };
  game.restore?.(save); game.update(dt, { ...none, art: 'dugu' });
  const state = game.serialize?.() as { qi: number };
  assert.equal(state.qi, 156);
  const resumed = BUILTIN_GAMES[0]!.create({ seed: 1, random: () => 0.5 });
  resumed.restore?.(state); assert.deepEqual(resumed.serialize?.(), state);
});

test('三键大招跨帧且优先于两键招，超时/逆序不触发，箭头可替代方向', () => {
  const received: GameInput[] = [];
  const module: GameModule = { manifest: { ...BUILTIN_GAMES[0]!.manifest, id: 'triple-test' }, create: () => ({
    update: (_dt, input) => received.push(input), render: () => {}, renderMicro: () => {},
  }) };
  const arcade = new Arcade(join(mkdtempSync(join(tmpdir(), 'moyu-triple-')), 'events'), [module]);
  arcade.enter(); let now = 1000; arcade.advance(now);
  const feed = (s: string, delay = 120): void => {
    now += delay; arcade.feed(Buffer.from(s), now); arcade.advance(now + 17); now += 17;
  };
  for (const [keys, art] of [['sdu', 'feixian'], ['sai', 'wanjian'], ['wdj', 'getsuga'], ['waj', 'hinokami']]) {
    arcade.keys.clear(); received.length = 0;
    for (const key of keys!) feed(key);
    assert.deepEqual(received.filter(i => i.art).map(i => i.art), [art]);
  }
  arcade.keys.clear(); received.length = 0;
  feed('s'); feed('d', 700); feed('u'); assert.ok(received.every(i => !i.art));
  arcade.keys.clear(); received.length = 0;
  feed('d'); feed('s'); feed('u'); assert.ok(received.every(i => i.art !== 'feixian'));
  arcade.keys.clear(); received.length = 0;
  feed('\x1b[A'); feed('\x1b[C'); feed('j'); assert.ok(received.some(i => i.art === 'getsuga'));
  arcade.keys.clear(); received.length = 0;
  feed('s'); feed('?'); feed('?'); feed('du'); assert.ok(received.every(i => i.art !== 'feixian'));
});

test('旧三招存档补齐新剑谱，隐藏招首次成功才揭晓且持久保存', () => {
  const progress = parseCultivation({ insight: 100, mastery: { dugu: 1, liumai: 2, taiji: 3 } });
  assert.equal(progress?.mastery.feixian, 0);
  const game = BUILTIN_GAMES[0]!.create({ seed: 31, random: () => 0.5 });
  game.restore?.({ version: 2, kills: 100, bestCombo: 4, checkpoint: null, qi: 100, cultivation: progress });
  assert.doesNotMatch(game.details?.().join(' ') ?? '', /月牙天冲/);
  game.update(dt, { ...none, art: 'getsuga' });
  assert.match(game.details?.().join(' ') ?? '', /月牙天冲/);
  assert.match(game.hud?.() ?? '', /悟得秘技/);
  const restored = BUILTIN_GAMES[0]!.create({ seed: 3, random: () => 0.5 });
  restored.restore?.(game.serialize?.());
  assert.match(restored.details?.().join(' ') ?? '', /月牙天冲/);
});

test('按章生成生物群：竹林螳螂甲虫、石桥蟹鳗、沙漠蝎、雪山狼、古塔蝠', () => {
  const shapes = new Set<string>();
  for (const species of ['mantis', 'crab', 'eel', 'scorpion', 'scarab', 'wolf', 'crystal', 'bat', 'idol'] as const) {
    const w = world(); w.spawnFormation({ kind: 'single', side: 'right' });
    const f = { ...w.enemies[0]!, species, walk: 0, x: 50, h: 25, tag: 'grunt' as const };
    const segs = fighterSegments(f);
    shapes.add(JSON.stringify(segs));
    assert.ok(segs.length >= 12);
    assert.notDeepEqual(fighterSegments({ ...f, walk: 0.25 }), segs);
  }
  assert.equal(shapes.size, 9);
  const w = world(); const director = new ChapterDirector(71); director.start(w);
  assert.ok(w.enemies.every(e => e.species === 'mantis' || e.species === 'scarab'));
  w.biome = 3; w.enemies.length = 0; w.spawnFormation({ kind: 'fill', side: 'right' });
  assert.ok(w.enemies.every(e => e.species === 'scorpion' || e.species === 'scarab'));
});

test('Boss受击有回退并恢复，最后一滴血仍遵守受击无敌', () => {
  const w = world(); w.spawnBoss('right'); w.hitstop = 0;
  const boss = w.enemies[0]!; boss.x = w.player.x + w.fh * 0.5;
  w.player.invuln = 999;
  w.step(dt, { ...NO_INTENT, spin: true });
  const x = boss.x; assert.equal(boss.hp, 4); assert.ok(boss.hurt > 0);
  for (let i = 0; i < 9; i++) w.step(dt, NO_INTENT);
  assert.ok(boss.x > x, '击退不能立即被追踪AI覆盖');
  boss.hp = 1; boss.invuln = 1; boss.x = w.player.x + w.fh * 0.3;
  w.player.spinCool = 0; w.player.spinT = 0; w.hitstop = 0;
  w.step(dt, { ...NO_INTENT, spin: true }); assert.ok(w.enemies.includes(boss));
  for (let i = 0; i < 60; i++) w.step(dt, NO_INTENT);
  assert.equal(boss.hurt, 0);
});

test('Boss地裂锁定落点，有预警延迟、范围伤害、跳跃可躲且生命周期有界', () => {
  for (const dodge of [false, true]) {
    const w = world(); w.spawnBoss('right'); w.hitstop = 0;
    const boss = w.enemies[0]!; boss.atkSeq = 1; boss.cool = 0; boss.x = w.player.x + w.fh * 3;
    w.player.invuln = 0;
    w.step(dt, NO_INTENT); assert.equal(boss.quakeX, w.player.x);
    for (let i = 0; i < 50 && w.hazards.length === 0; i++) w.step(dt, NO_INTENT);
    assert.equal(w.hazards.length, 3);
    assert.equal(w.player.hp, 4, '预警期间不能造成伤害');
    for (let i = 0; i < 65; i++) {
      if (dodge) { w.player.y = w.ground - w.fh; w.player.vy = 0; }
      w.step(dt, NO_INTENT);
    }
    assert.equal(w.player.hp, dodge ? 4 : 3);
    assert.equal(w.hazards.length, 0);
    w.hazards.push({ x: w.player.x, radius: w.fh, timer: 0, life: 0.4, hit: false });
    w.enemies.length = 0; w.step(dt, NO_INTENT);
    assert.equal(w.hazards.length, 0, 'Boss死亡后不能残留伤害区或冻结的预警');
  }
});


test('真实 Arcade 输入到剑招：四种三键技左右均按起始朝向释放，分块与合并一致', () => {
  for (const face of [-1, 1] as const) for (const batched of [false, true]) {
    for (const [keys, art] of [['sdu', 'feixian'], ['sai', 'wanjian'], ['wdj', 'getsuga'], ['waj', 'hinokami']] as const) {
      const builtin = BUILTIN_GAMES[0]!;
      const game = builtin.create({ seed: 71, random: () => 0.5 });
      const w = (game as unknown as { world: World }).world;
      w.qi = 300; w.cultivation.insight = 100; w.player.invuln = 999;
      const module: GameModule = { manifest: { ...builtin.manifest, id: 'aim-regression' },
        create: () => ({ update: game.update.bind(game), render: () => {} }) };
      const arcade = new Arcade(join(mkdtempSync(join(tmpdir(), 'moyu-aim-')), 'events'), [module]);
      arcade.enter(); arcade.advance(1000);
      arcade.feed(Buffer.from(face === -1 ? 'a' : 'd'), 1001); arcade.advance(1017);
      assert.equal(w.player.face, face);
      let now = 1100;
      for (const key of batched ? [keys] : [...keys]) {
        arcade.feed(Buffer.from(key), now); arcade.advance(now + 17); now += 120;
      }
      assert.equal(w.swordCast?.art, art, `${keys}/${face}/${batched}`);
      assert.equal(w.swordCast?.face, face, `${keys}/${face}/${batched}`);
      assert.equal(w.player.face, face);
      // The direction embedded in the command must not turn the player back on the next frame.
      arcade.advance(now + 17); assert.equal(w.player.face, face);
    }
  }
});

test('Arcade 起步、转向、技能后的首个方向不会提前断流，停止后无旧方向回弹', () => {
  for (const direction of ['d', '\x1b[C']) for (const middle of ['', 'a', 'u', 'i', 'j']) {
    const received: GameInput[] = [];
    const module: GameModule = { manifest: { ...BUILTIN_GAMES[0]!.manifest, id: 'walk-regression' },
      create: () => ({ update: (_dt, input) => received.push(input), render: () => {} }) };
    const arcade = new Arcade(join(mkdtempSync(join(tmpdir(), 'moyu-walk-')), 'events'), [module]);
    arcade.enter(); arcade.advance(1000);
    if (middle) {
      arcade.feed(Buffer.from(direction), 1001); arcade.advance(1017);
      arcade.feed(Buffer.from(middle), 1040);
    }
    arcade.feed(Buffer.from(direction), 1080);
    for (let now = 1100; now < 1580; now += 20) {
      arcade.advance(now); assert.equal(received.at(-1)?.right, true, `${direction}/${middle}/${now}`);
    }
    for (let now = 1580; now <= 1780; now += 50) {
      arcade.feed(Buffer.from(direction), now); arcade.advance(now + 17);
      assert.equal(received.at(-1)?.right, true);
    }
    arcade.advance(1940);
    assert.equal(received.at(-1)?.right, false); assert.equal(received.at(-1)?.left, false);
  }
});
