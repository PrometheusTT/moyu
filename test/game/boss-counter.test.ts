import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, NO_INTENT, bossKindForChapter, bossArmored, variantBossReach, type BossKind } from '../../src/core/world.ts';
import { fighterSegments } from '../../src/core/creature.ts';
import { paintBossPressure } from '../../src/render/wuxia.ts';
import { Arcade, BUILTIN_GAMES } from '../../src/platform/arcade.ts';
import type { GameInput, GameModule } from '../../src/platform/types.ts';

const dt = 1 / 60;
function world(kind?: BossKind): World {
  const w = new World(71, { automaticSpawns: false });
  w.resize(180, 44); w.beginChapter();
  if (kind) {
    w.spawnBoss('right', 63, kind); // 反制机制用完整技能组，教学关另有覆盖。
    const e = w.enemies[0]!; e.hp = e.maxHp = 5;
    e.x = w.player.x + w.fh * 0.8; e.face = -1; e.cool = 99;
  }
  w.hitstop = 0; w.player.invuln = 0;
  return w;
}
function advance(w: World, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds / dt); i++) w.step(dt, NO_INTENT);
}

test('怪物头目轮换跳过剑宗关，三种轮廓可大型化且顶端不裁切', () => {
  assert.deepEqual([3, 6, 12, 15, 21, 24, 30, 33].map(bossKindForChapter),
    ['mantis', 'scarab', 'crystal', 'spider', 'mantis', 'scarab', 'crystal', 'spider']);
  const contours = new Set<string>();
  for (const kind of ['mantis', 'scarab', 'crystal'] as const) {
    const w = world(); w.biome = 0; w.spawnBoss('right', kind === 'mantis' ? 3 : kind === 'scarab' ? 6 : 12);
    const e = w.enemies[0]!;
    assert.equal(e.bossKind, kind); assert.equal(e.species, kind);
    assert.ok(e.h > w.player.h);
    e.windup = 0.1;
    contours.add(JSON.stringify(fighterSegments(e).map(s => [s.x1 - e.x, s.y1 - e.y])));
    assert.ok(fighterSegments(e).every(s => s.y0 >= 0 && s.y1 >= 0));
    w.resize(120, 36);
    assert.equal(e.species, kind);
    assert.ok(fighterSegments(e).every(s => s.y0 >= 0 && s.y1 >= 0));
  }
  assert.equal(contours.size, 3);
});

test('S>K零气解控，霸体期间可攻击移动，冷却中不刷新，六秒后可重用', () => {
  const w = world(), p = w.player;
  p.stunT = 0.3; p.slowT = 0.8; p.atk = 0.05;
  w.step(dt, { ...NO_INTENT, armor: true, move: 1 });
  assert.equal(p.stunT, 0); assert.equal(p.slowT, 0);
  assert.equal(p.armorT, 0.8); assert.equal(p.armorCool, 6); assert.equal(w.qi, 0);
  assert.ok(p.vx > 0); assert.ok(p.atk > 0.05);
  w.step(dt, { ...NO_INTENT, armor: true });
  assert.ok(p.armorT! < 0.8); assert.match(w.artNotice, /未就绪/);
  advance(w, 6.1);
  w.step(dt, { ...NO_INTENT, armor: true }); assert.equal(p.armorT, 0.8);
});

test('解控优先于顿帧缓存、冲刺和旋斩，且只触发一次', () => {
  for (const action of ['dash', 'spin'] as const) {
    const w = world(); w.step(dt, { ...NO_INTENT, [action]: true });
    w.hitstop = 0.06;
    w.step(dt, { ...NO_INTENT, armor: true });
    assert.equal(w.player.armorT, undefined);
    advance(w, 0.1);
    assert.ok(w.player.armorT! > 0); assert.ok(w.player.armorCool! > 5.9);
    advance(w, 0.3); assert.doesNotMatch(w.artNotice, /未就绪/);
  }
});

test('螳螂第二斩短控：霸体照常扣血但不击退、不中断普攻、不受控', () => {
  for (const armored of [false, true]) {
    const w = world('mantis'), p = w.player, e = w.enemies[0]!;
    e.followupT = dt / 2;
    p.atk = 0.02;
    w.step(dt, { ...NO_INTENT, armor: armored });
    assert.equal(p.hp, 3); assert.equal(p.invuln, 0.85);
    if (armored) {
      assert.ok(p.atk > 0); assert.equal(p.vx, 0); assert.equal(p.onGround, true);
      assert.equal(p.stunT, 0);
    } else {
      assert.equal(p.atk, -1); assert.equal(p.stunT, 0.3); assert.ok(p.vx < 0);
      w.hitstop = 0;
      w.step(dt, { ...NO_INTENT, slash: true, dash: true, spin: true, jump: true, move: 1 });
      assert.equal(p.atk, -1); assert.equal(p.dashT, 0); assert.equal(p.spinT, 0);
      advance(w, 0.31); assert.ok(p.controlImmuneT! > 0);
      p.invuln = 0; p.x = e.x - w.fh * 0.5; p.y = w.ground; p.onGround = true;
      e.followupT = dt / 2;
      w.step(dt, NO_INTENT); assert.equal(p.stunT, 0, '保护期内不能连续硬控');
    }
  }
});

test('霸体能解除冰阵减速，但不额外无敌；冰阵可跳跃躲避，来源死亡立即清除', () => {
  for (const dodge of ['none', 'jump', 'armor'] as const) {
    const w = world('crystal'), p = w.player, e = w.enemies[0]!;
    w.hazards.push({ x: p.x, radius: w.fh * 0.48, timer: 0, life: 0.9, hit: false, frost: true, owner: e, slow: { duration: 0.8, multiplier: 0.6 } });
    if (dodge === 'jump') { p.y = w.ground - w.fh * 0.4; p.onGround = false; }
    w.step(dt, { ...NO_INTENT, armor: dodge === 'armor' });
    assert.equal(p.hp, dodge === 'jump' ? 4 : 3);
    assert.equal((p.slowT ?? 0) > 0, dodge === 'none');
    if (dodge === 'none') {
      w.hitstop = 0; w.step(dt, { ...NO_INTENT, armor: true }); assert.equal(p.slowT, 0);
    }
    // 另一个 Boss 在场也不能保留死者的冰阵。
    w.enemies.length = 0; w.spawnBoss('left', 3, 'spider'); w.hitstop = 0;
    w.step(dt, NO_INTENT); assert.equal(w.hazards.length, 0);
  }
});

test('金甲冲撞锁定预警方向：霸体免击退、普通命中仅扣一血', () => {
  for (const armored of [false, true]) {
    const w = world('scarab'), e = w.enemies[0]!, p = w.player;
    e.windup = dt / 2;
    w.step(dt, { ...NO_INTENT, armor: armored });
    assert.ok(e.dashT > 0);
    w.step(dt, NO_INTENT);
    assert.equal(p.hp, 3);
    assert.equal(p.vx === 0, armored);
    advance(w, 0.5); assert.equal(p.hp, 3);
    assert.equal(e.face, -1);
    assert.ok(e.cool > 0.7, '冲撞后留下反击窗口');
  }
});

test('金色蓄势抗打断仍扣血回气，早期蓄势和第二斩可以截断', () => {
  for (const timing of ['early', 'late', 'followup'] as const) {
    const w = world('mantis'), e = w.enemies[0]!;
    e.windup = timing === 'late' ? 0.15 : timing === 'early' ? 0.6 : -1;
    if (timing === 'followup') e.followupT = 0.2;
    assert.equal(bossArmored(e), timing === 'late');
    w.step(dt, { ...NO_INTENT, spin: true });
    assert.equal(e.hp, 4); assert.equal(w.qi, 12);
    if (timing === 'late') assert.ok(e.windup > 0);
    else { assert.equal(e.windup, -1); assert.equal(e.followupT, undefined); }
  }
});

test('三种头目完整起手/出招确定性，冰阵预警锁定、渲染不修改战斗状态', () => {
  for (const kind of ['mantis', 'scarab', 'crystal'] as const) {
    const play = () => {
      const w = world(kind), e = w.enemies[0]!;
      w.player.invuln = 99; e.cool = 0;
      w.step(dt, NO_INTENT); assert.ok(e.windup >= 0.65);
      const locked = e.quakeX;
      if (kind === 'crystal') w.player.x += w.fh * 2;
      const before = JSON.stringify(e);
      const lines: number[][] = [];
      paintBossPressure({ line: (...a) => lines.push(a), rect: () => {}, circle: () => {} }, w);
      assert.equal(JSON.stringify(e), before);
      if (kind === 'mantis') assert.ok(lines.some(a => Math.abs(a[2]! - (e.x + e.face * variantBossReach(e))) < 1e-6));
      advance(w, kind === 'crystal' ? 0.92 : 0.76);
      if (kind === 'crystal') {
        assert.equal(w.hazards.length, 3);
        assert.equal(w.hazards[1]!.x, locked);
        assert.ok(lines.some(a => a[4] === 0x8cddff));
      } else assert.ok(kind === 'mantis' ? e.followupT! > 0 : e.dashT > 0);
      advance(w, 2);
      return { boss: e, player: w.player, rng: w.rng.snapshot() };
    };
    assert.deepEqual(play(), play());
  }
});

test('换章/重生清除霸体与控制；霸体不能保住最后一格血', () => {
  const w = world('mantis'), p = w.player, e = w.enemies[0]!;
  p.hp = 1; e.followupT = dt / 2;
  w.step(dt, { ...NO_INTENT, armor: true });
  assert.equal(p.hp, 0); assert.ok(w.respawn > 0); assert.equal(p.armorT, 0);
  advance(w, 1.4); assert.notEqual(w.player, p); assert.equal(w.player.armorT, undefined);
  w.player.slowT = 0.8; w.player.armorCool = 4;
  w.beginChapter(); assert.equal(w.player.slowT, undefined); assert.equal(w.player.armorCool, undefined);
});

test('冰晶王被击退到场外后先返回，不能在玩家攻击范围外永久施法', () => {
  for (const side of [-1, 1]) {
    const w = world('crystal'), e = w.enemies[0]!;
    e.x = side < 0 ? -w.fh * 2 : w.w + w.fh * 2; e.cool = 0;
    w.player.invuln = 99;
    advance(w, 0.5); assert.equal(e.windup, -1); assert.equal(w.hazards.length, 0);
    advance(w, 4);
    assert.ok(e.x > 0 && e.x < w.w);
    assert.ok((e.atkSeq ?? 0) > 0 || e.windup >= 0);
  }
});

test('终端S>K跨块/同块/方向键识别一次，超时仍跳跃，不污染其他游戏或暂停后的输入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moyu-counter-'));
  try {
    for (const enabled of [true, false]) {
      const received: GameInput[] = [];
      const module: GameModule = { manifest: { ...BUILTIN_GAMES[0]!.manifest, id: enabled ? 'stick-slash' : 'other' },
        create: () => ({ update: (_dt, input) => received.push(input), render: () => {}, renderMicro: () => {} }) };
      const a = new Arcade(join(dir, 'events'), [module]); a.enter(); a.advance(1000);
      a.feed(Buffer.from('s'), 1001); a.advance(1017);
      a.feed(Buffer.from('k'), 1300); a.advance(1317); a.advance(1350);
      assert.equal(received.filter(i => i.armor).length, enabled ? 1 : 0);
      assert.equal(received.some(i => i.up), !enabled);
      for (const [index, input] of ['sk', '\x1b[Bk'].entries()) {
        a.keys.clear(); received.length = 0;
        a.feed(Buffer.from(input), 1400 + index * 40); a.advance(1417 + index * 40);
        assert.equal(received.some(i => i.armor), enabled);
      }
      a.keys.clear(); received.length = 0;
      a.feed(Buffer.from('s'), 1500); a.feed(Buffer.from('k'), 1841); a.advance(1858);
      assert.ok(received.some(i => i.up)); assert.ok(received.every(i => !i.armor));
      a.keys.clear(); received.length = 0;
      a.feed(Buffer.from('sk'), 1900); a.pause(); a.resume(); a.advance(2000); a.advance(2017);
      assert.ok(received.every(i => !i.armor));
      a.feed(Buffer.from('\x1b]11;sk\x07'), 2100); a.advance(2117);
      assert.ok(received.every(i => !i.armor));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
