import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT, type Intent } from '../../src/core/world.ts';
import { Rng } from '../../src/core/rng.ts';

const STEP = 1 / 60;

function mk(seed = 1): World {
  const w = new World(seed);
  w.resize(120, 40);
  return w;
}

/** 跑 n 帧模拟。`f` 可以每帧给不同的意图。 */
function run(w: World, n: number, f: (i: number) => Intent = () => NO_INTENT): void {
  for (let i = 0; i < n; i++) w.step(STEP, f(i));
}

/** 一直砍，直到有人被砍死或超时。返回用了多少帧。 */
function fightUntilKill(w: World, maxFrames = 60 * 20): number {
  for (let i = 0; i < maxFrames; i++) {
    const target = w.enemies[0];
    // 朝最近的杂兵走过去砍。测试要的是"能砍到"，所以这里就是一个最笨的 AI。
    const move: -1 | 0 | 1 = target === undefined ? 0 : target.x > w.player.x ? 1 : -1;
    w.step(STEP, { move, jump: false, slash: true });
    if (w.kills > 0) return i;
  }
  return -1;
}

test('一刀砍碎：杂兵变成一堆断肢，头是单独一块，还会喷血', () => {
  const w = mk();
  w.taskStart();
  const frames = fightUntilKill(w);
  assert.ok(frames > 0, '20 秒内一个都没砍到 —— 判定范围或者杂兵 AI 坏了');

  assert.equal(w.kills, 1);
  assert.equal(w.taskKills, 1);
  // 骨架是 10 条线段，被切线穿过的那条一分为二 → 至少 9 块（太短的碎块会被丢掉）。
  assert.ok(w.pieces.length >= 9, `只碎成 ${w.pieces.length} 块 —— "砍碎"这个词就不成立了`);
  assert.equal(w.pieces.filter((p) => p.head).length, 1, '头必须恰好一块');
  assert.ok(w.blood.length > 0, '没喷血');
  // 顿帧 + 震屏 = "砍到了"的重量。少任何一个都会立刻变软。
  assert.ok(w.hitstop > 0, '没有顿帧');
  assert.ok(w.shake > 0, '没有震屏');
  assert.ok(w.pieces.some((p) => p.vy < -w.fh), '一块都没被带飞起来（上半身该被刀挑起来）');
});

test('断肢会落地躺平并留下血迹，然后**不再动**（静止的像素在 diff 之后是零成本的）', () => {
  const w = mk(3);
  w.taskStart();
  assert.ok(fightUntilKill(w) > 0);
  // 只盯这具尸体自己的碎块和血：这 6 秒里玩家可能被杂兵打死，它的碎块是新飞出来的，
  // 拿"当前全部碎块都静止"来断言会被那件无关的事弄红。
  const corpse = [...w.pieces];
  const spilled = [...w.blood];
  assert.ok(corpse.length > 0 && spilled.length > 0);
  run(w, 60 * 6);
  for (const p of corpse) assert.ok(w.pieces.includes(p), '碎块凭空消失了（尸堆是战果的证据）');
  assert.ok(corpse.every((p) => p.rest), '6 秒后还有碎块在动 —— 它们会永远产生 diff 字节');
  assert.ok(w.stains.length > 0, '地上没留血迹');
  assert.ok(spilled.every((b) => !w.blood.includes(b)), '血粒子该全部落地变成血迹了');
});

test('顿帧期间整个世界冻结（这是"砍到了"的重量来源）', () => {
  const w = mk(5);
  w.taskStart();
  assert.ok(fightUntilKill(w) > 0);
  assert.ok(w.hitstop > 0);
  const snap = w.pieces.map((p) => `${p.x},${p.y},${p.ang}`).join('|');
  const px = w.player.x;
  w.step(STEP, NO_INTENT);
  assert.equal(w.pieces.map((p) => `${p.x},${p.y},${p.ang}`).join('|'), snap, '顿帧里碎块动了');
  assert.equal(w.player.x, px, '顿帧里玩家动了');
});

test('任务完成 → 清屏技扫全场 → 暂停等下一个任务', () => {
  const w = mk(7);
  w.taskStart();
  run(w, 60 * 8);
  const live = w.enemies.length;
  assert.ok(live >= 2, `清屏技该在场上有人的时候放，现在只有 ${live} 个`);

  w.taskDone();
  assert.equal(w.phase, 'clear');
  // 冲击波扫过去要花约 0.55 秒（w / 0.55 px/s），给 2 秒足够。
  for (let i = 0; i < 120 && w.phase === 'clear'; i++) w.step(STEP, NO_INTENT);
  assert.equal(w.phase, 'paused', '清屏技放完必须落到暂停态');
  assert.equal(w.enemies.length, 0, '清屏技没清干净');
  assert.equal(w.kills, live, `场上 ${live} 个人，只算了 ${w.kills} 个人头`);
  assert.ok(w.pieces.length > live * 8, '清屏技没把人砍碎（那就只是"消失"了，没有反馈）');
});

test('暂停态不出怪、不推进战斗，直到下一个任务开始', () => {
  const w = mk(11);
  w.taskStart();
  run(w, 60 * 6);
  w.taskDone();
  for (let i = 0; i < 200 && w.phase === 'clear'; i++) w.step(STEP, NO_INTENT);
  assert.equal(w.phase, 'paused');

  run(w, 60 * 10);
  assert.equal(w.phase, 'paused', '暂停态自己跳出去了');
  assert.equal(w.enemies.length, 0, '暂停态还在出怪 —— 那就不是"等下一个任务"了');

  w.taskStart();
  assert.equal(w.phase, 'fight');
  assert.equal(w.pieces.length, 0, '新任务该是干净的战场');
  assert.equal(w.stains.length, 0);
  assert.equal(w.taskKills, 0, '本轮战绩该归零');
  run(w, 60 * 5);
  assert.ok(w.enemies.length > 0, '新任务开始了却不出怪');
});

test('暂停时按砍键可以自己接着打（不必等下一个任务）', () => {
  const w = mk(13);
  w.taskStart();
  run(w, 60 * 4);
  w.taskDone();
  for (let i = 0; i < 200 && w.phase === 'clear'; i++) w.step(STEP, NO_INTENT);
  assert.equal(w.phase, 'paused');
  w.step(STEP, { move: 0, jump: false, slash: true });
  assert.equal(w.phase, 'fight');
});

test('暂停更新既不推进时间也不消耗随机流，砍键仍只负责重开', () => {
  const w = mk(14);
  w.taskStart();
  w.taskDone();
  while (w.phase === 'clear') w.step(STEP, NO_INTENT);
  const time = w.time;
  const pausedRng = w.rng.snapshot();
  run(w, 10_000);
  assert.equal(w.time, time);
  assert.equal(w.rng.snapshot(), pausedRng);
  w.step(STEP, { move: 0, jump: false, slash: true });
  assert.equal(w.phase, 'fight');
  assert.equal(w.time, time, '重开的按键本身不能偷偷推进一帧');
  assert.equal(w.rng.snapshot(), 14, '重开要回到清屏前的 gameplay RNG，而不是保留特效消耗');
});

test('任务重开清掉上一场全部战斗瞬态但保留终身战绩', () => {
  const w = mk(15);
  w.taskStart();
  w.kills = 12; w.bestCombo = 4;
  w.respawn = 1; w.hitstop = 1; w.flash = 1;
  w.shake = 3; w.shakeX = 2; w.shakeY = -1;
  w.combo = 3; w.stepComboPeak = 3;
  w.player.atk = 0.2; w.player.atkQueued = true; w.player.hurt = 0.3;
  w.slashes.push({ x: 1, y: 1, r: 1, a0: 0, a1: 1, life: 1, max: 1, big: false });
  w.taskDone();
  w.taskStart();
  assert.equal(w.phase, 'fight');
  assert.equal(w.kills, 12); assert.equal(w.bestCombo, 4);
  assert.equal(w.respawn, 0); assert.equal(w.hitstop, 0); assert.equal(w.flash, 0);
  assert.equal(w.shake, 0); assert.equal(w.shakeX, 0); assert.equal(w.shakeY, 0);
  assert.equal(w.combo, 0); assert.equal(w.stepComboPeak, 0);
  assert.equal(w.slashes.length, 0);
  assert.equal(w.player.atk, -1); assert.equal(w.player.atkQueued, false); assert.equal(w.player.hurt, 0);
});

test('挤成一团的杂兵会被一刀带走多个（连击的来源）', () => {
  // 同一刀命中多人是这个游戏最爽的瞬间，所以它是一条**行为要求**而不是巧合。
  const w = mk(17);
  w.taskStart();
  let multi = false;
  for (let i = 0; i < 60 * 40 && !multi; i++) {
    const before = w.kills;
    const t = w.enemies[0];
    const move: -1 | 0 | 1 = t === undefined ? 0 : t.x > w.player.x ? 1 : -1;
    w.step(STEP, { move, jump: false, slash: true });
    if (w.kills - before >= 2) multi = true;
  }
  assert.ok(multi, '40 秒里一次多杀都没有 —— 判定太窄或者杂兵不会聚过来');
  assert.ok(w.bestCombo >= 2, '连击计数没起来');
});

test('玩家也会被砍碎，然后重生（死法和杂兵一样才公平）', () => {
  const w = mk(19);
  w.taskStart();
  let sawDismembered = false;
  for (let i = 0; i < 60 * 40; i++) {
    w.step(STEP, NO_INTENT);              // 站着不动，等着被打
    if (w.respawn > 0 && w.pieces.some((p) => p.mine)) sawDismembered = true;
    if (w.deaths >= 1 && sawDismembered) break;
  }
  assert.ok(w.deaths >= 1, '站着不动 40 秒都没死 —— 杂兵不会打人');
  assert.ok(sawDismembered, '玩家死了但没被砍碎');
  run(w, 90);
  assert.equal(w.respawn <= 0, true, '重生卡住了');
  assert.equal(w.player.hp, 4, '重生没回满血');
});

test('同一个种子 + 同一串操作 = 完全一样的一局（确定性是可测试性的前提）', () => {
  const script = (i: number): Intent => ({
    move: Math.floor(i / 37) % 2 === 0 ? 1 : -1,
    jump: i % 53 === 0,
    slash: i % 11 === 0,
  });
  const a = mk(0x1234abcd);
  const b = mk(0x1234abcd);
  a.taskStart();
  b.taskStart();
  run(a, 1200, script);
  run(b, 1200, script);
  assert.deepEqual(
    { kills: a.kills, pieces: a.pieces.length, x: a.player.x, hp: a.player.hp, stains: a.stains.length },
    { kills: b.kills, pieces: b.pieces.length, x: b.player.x, hp: b.player.hp, stains: b.stains.length },
  );
});

test('画布尺寸变了不清场，火柴人按新高度缩放（拖窗口不该重开一局）', () => {
  const w = mk(23);
  w.taskStart();
  run(w, 60 * 5);
  const kills = w.kills;
  const enemies = w.enemies.length;
  w.resize(60, 20);
  assert.equal(w.kills, kills);
  assert.equal(w.enemies.length, enemies);
  assert.ok(w.fh >= 7, '身高被压到看不出四肢了');
  assert.ok(w.player.y === w.ground, '缩放后玩家没站在地上');
  run(w, 60 * 3);
  for (const e of w.enemies) assert.ok(e.y === w.ground, '杂兵飘在空中');
});

test('玩家不会走出画布', () => {
  const w = mk(29);
  w.taskStart();
  run(w, 60 * 6, () => ({ move: -1, jump: false, slash: false }));
  assert.ok(w.player.x >= 1, `玩家跑到了 x=${w.player.x}`);
  run(w, 60 * 12, () => ({ move: 1, jump: false, slash: false }));
  assert.ok(w.player.x <= w.w - 2, `玩家跑到了 x=${w.player.x}`);
});

test('冲刺斩：向前窜一段、带碎路上的杂兵，全程无敌', () => {
  const w = new World(7, { automaticSpawns: false });
  w.resize(120, 40);
  w.taskStart();
  w.spawnFormation({ kind: 'single', side: 'right' });
  const e = w.enemies[0]!;
  e.x = w.player.x + w.fh * 0.6;   // 落在冲刺路径上
  e.y = w.player.y;
  w.player.face = 1;
  const x0 = w.player.x;
  w.step(STEP, { move: 0, jump: false, slash: false, dash: true });
  assert.equal(w.kills, 1, '冲刺没有把身前的杂兵带碎');
  assert.equal(w.enemies.length, 0);
  assert.ok(w.player.invuln > 0, '冲刺全程应有无敌帧');
  run(w, 8);
  assert.ok(w.player.x > x0 + w.fh, `冲刺位移不够（${(w.player.x - x0).toFixed(1)}）`);
});

test('冲刺斩有冷却：刚冲完立刻再按不生效', () => {
  const w = new World(8, { automaticSpawns: false });
  w.resize(120, 40);
  w.taskStart();
  w.player.face = 1;
  w.step(STEP, { move: 0, jump: false, slash: false, dash: true });
  run(w, 14);                       // 冲刺动作结束（0.18s），冷却仍在
  const x1 = w.player.x;
  w.spawnFormation({ kind: 'single', side: 'right' });
  w.enemies.at(-1)!.x = w.player.x + w.fh * 0.5;
  w.enemies.at(-1)!.y = w.player.y;
  w.step(STEP, { move: 0, jump: false, slash: false, dash: true });
  assert.equal(w.kills, 0, '冷却期内冲刺不该触发');
  run(w, 6);
  assert.ok(Math.abs(w.player.x - x1) < w.fh, '冷却期内不该再窜出去');
});

test('旋斩：一圈杂兵全砍飞，留下接近整圈的刀光；冷却内不连放', () => {
  const w = new World(9, { automaticSpawns: false });
  w.resize(120, 40);
  w.taskStart();
  w.spawnFormation({ kind: 'pincer' });
  for (const e of w.enemies) { e.x = w.player.x + (e.face > 0 ? -1 : 1) * w.fh * 0.9; e.y = w.player.y; }
  const around = w.enemies.length;
  assert.ok(around >= 2, '需要两侧各一个杂兵');
  const before = w.slashes.length;
  w.step(STEP, { move: 0, jump: false, slash: false, spin: true });
  assert.equal(w.kills, around, '旋斩没把一圈杂兵全带走');
  const ring = w.slashes.at(-1)!;
  assert.ok(w.slashes.length > before && Math.abs(ring.a1 - ring.a0) >= Math.PI * 1.9,
    '旋斩应留下一道接近整圈的刀光');
  run(w, 24);                       // 转完（0.34s），冷却仍在
  const kills = w.kills;
  w.spawnFormation({ kind: 'single', side: 'right' });
  w.enemies.at(-1)!.x = w.player.x + w.fh * 0.5;
  w.enemies.at(-1)!.y = w.player.y;
  w.step(STEP, { move: 0, jump: false, slash: false, spin: true });
  assert.equal(w.kills, kills, '冷却期内旋斩不该再触发');
});

test('跳斩：半空挥刀把判定带朝下放宽，够得到地面的人（普通刀够不到）', () => {
  // A/B：同样几何下，普通刀在半空挥空，跳斩（air）能劈到地面的人。
  const probe = (kind: 'normal' | 'air'): number => {
    const w = new World(7, { automaticSpawns: false });
    w.resize(160, 44);
    w.taskStart();
    w.enemies.length = 0;
    w.spawnFormation({ kind: 'single', side: 'right' });
    const e = w.enemies[0]!;
    const p = w.player;
    p.face = 1;
    p.onGround = false; p.vy = 0; p.y = w.ground - w.fh * 1.4;   // 半空
    e.x = p.x + w.fh * 0.6; e.y = w.ground;                       // 脚下的地面敌人
    p.atk = 0.30; p.atkHit = false; p.atkKind = kind;             // 直接驱动判定帧（照 boss 测试的手法）
    w.step(STEP, { move: 0, jump: false, slash: false });
    return w.kills;
  };
  assert.equal(probe('normal'), 0, '半空普通挥刀本就够不到地面的人');
  assert.equal(probe('air'), 1, '跳斩应把判定带朝下放宽，劈到地面的人');
});

test('蹲斩：蹲下挥刀触发低扫，且冷却内退回普通刀（不白嫖）', () => {
  const w = new World(10, { automaticSpawns: false });
  w.resize(160, 44);
  w.taskStart();
  w.enemies.length = 0;
  const p = w.player;
  p.face = 1;
  // 蹲下 + 砍 → sweep，进入冷却。
  w.step(STEP, { move: 0, jump: false, slash: true, crouch: true });
  assert.equal(p.atkKind, 'sweep', '蹲下挥刀应触发低扫');
  assert.ok((p.sweepCool ?? 0) > 0, '蹲斩应进入冷却');
  // 跑到这一刀收招结束（atk 回 -1），但冷却还没好。
  for (let i = 0; i < 45 && p.atk >= 0; i++) w.step(STEP, NO_INTENT);
  assert.ok(p.atk < 0, '第一刀应已收招');
  const coolBefore = p.sweepCool ?? 0;
  assert.ok(coolBefore > 0, '冷却应还没好');
  // 冷却内再蹲下挥刀 → 退回普通刀，且不重置冷却。
  w.step(STEP, { move: 0, jump: false, slash: true, crouch: true });
  assert.equal(p.atkKind, 'normal', '冷却内蹲斩应退回普通刀');
  assert.ok((p.sweepCool ?? 0) < coolBefore, '冷却内不该重置蹲斩冷却');
});

test('前冲斩：朝前挥刀带一步前冲，且冷却内退回普通刀', () => {
  const w = new World(11, { automaticSpawns: false });
  w.resize(160, 44);
  w.taskStart();
  w.enemies.length = 0;
  const p = w.player;
  p.face = 1;
  const x0 = p.x;
  // 朝前（move===face）+ 砍 → lunge。
  w.step(STEP, { move: 1, jump: false, slash: true });
  assert.equal(p.atkKind, 'lunge', '朝前挥刀应触发前冲斩');
  assert.ok((p.lungeCool ?? 0) > 0, '前冲斩应进入冷却');
  run(w, 6);
  assert.ok(p.x > x0, `前冲斩应带着人朝前挪一步（x0=${x0.toFixed(1)} → ${p.x.toFixed(1)}）`);
  // 跑完这一刀，冷却还没好时再朝前挥刀 → 退回普通刀。
  for (let i = 0; i < 40 && p.atk >= 0; i++) w.step(STEP, NO_INTENT);
  assert.ok(p.atk < 0, '第一刀应已收招');
  const coolBefore = p.lungeCool ?? 0;
  assert.ok(coolBefore > 0, '冷却应还没好');
  w.step(STEP, { move: 1, jump: false, slash: true });
  assert.equal(p.atkKind, 'normal', '冷却内前冲斩应退回普通刀');
});

test('变招仍是一刀一个：蹲斩把一排贴身杂兵一起带走，各计一次击杀', () => {
  const w = new World(13, { automaticSpawns: false });
  w.resize(160, 44);
  w.taskStart();
  w.enemies.length = 0;
  w.spawnFormation({ kind: 'single', side: 'right' });
  w.spawnFormation({ kind: 'single', side: 'right' });
  const p = w.player;
  p.face = 1; p.y = w.ground; p.onGround = true;
  for (const e of w.enemies) { e.x = p.x + w.fh * 0.6; e.y = w.ground; }
  const targets = w.enemies.length;
  assert.ok(targets >= 2, '需要两个贴身杂兵');
  p.atkKind = 'sweep'; p.atk = 0.30; p.atkHit = false;   // 直接驱动低扫的判定帧
  w.step(STEP, { move: 0, jump: false, slash: false });
  assert.equal(w.kills, targets, '蹲斩应把贴身的一排杂兵一起带走');
  assert.equal(w.combo, targets, '每个都各计一次连击');
  assert.equal(w.enemies.length, 0, '杂兵仍是一刀一个（hp=1 直接砍碎）');
});

test('杂兵变种：tag 确定、变种真的出现，且不额外消耗 RNG（保住确定性/字节预算）', () => {
  // makeGrunt 恰好抽 5 个值：range,float,float,range,range。tag 只从已抽到的 h/speed 派生。
  const w = new World(12345, { automaticSpawns: false });
  w.resize(120, 40);
  w.spawnFormation({ kind: 'single', side: 'right' });
  const ref = new Rng(12345);
  ref.range(0.78, 1.0); ref.float(); ref.float(); ref.range(0, 0.5); ref.range(0.35, 0.56);
  assert.equal(w.rng.snapshot(), ref.snapshot(), 'makeGrunt 的 RNG 抽取序列被改动了 —— 会移位共享流');

  const tagsFor = (seed: number): Array<string | undefined> => {
    const g = new World(seed, { automaticSpawns: false }); g.resize(120, 40);
    const out: Array<string | undefined> = [];
    for (let i = 0; i < 200; i++) {
      g.spawnFormation({ kind: 'single', side: 'right' });
      out.push(g.enemies.at(-1)!.tag);
      g.enemies.length = 0;
    }
    return out;
  };
  const a = tagsFor(999);
  assert.deepEqual(a, tagsFor(999), 'tag 对同一种子不确定');
  assert.ok(a.includes('brute') && a.includes('runner') && a.includes('grunt'),
    `三种变种应都出现，实际：${[...new Set(a)].join(',')}`);
});

test('boss：多段血，砍满 hp 下才死，只在最后一击计 1 个击杀（计分安全）', () => {
  const w = new World(3, { automaticSpawns: false });
  w.resize(160, 44);
  assert.equal(w.spawnBoss('right'), true);
  const boss = w.enemies[0]!;
  assert.equal(boss.tag, 'boss');
  const need = boss.hp;
  assert.ok(need >= 3, 'boss 应有多段血');
  assert.ok(boss.h > Math.round(w.fh * 0.9), 'boss 应比杂兵大');
  w.player.face = 1;
  let swings = 0;
  for (let s = 0; s < need + 3 && w.enemies.length > 0; s++) {
    boss.x = w.player.x + w.fh * 0.6;   // 保持在刀程内（stagger 会把它击退）
    boss.invuln = 0;                     // 跳过 stagger 无敌，专测多段血
    w.hitstop = 0;                       // 跳过顿帧，否则 step 会整帧冻结
    w.player.atk = 0.30; w.player.atkHit = false;
    const before = w.kills;
    w.step(1 / 60, { move: 0, jump: false, slash: false });
    swings++;
    if (w.enemies.length > 0) assert.equal(w.kills, before, `第 ${swings} 下不该计击杀（还没砍死）`);
  }
  assert.equal(w.enemies.length, 0, `砍了 ${swings} 下 boss 还没死`);
  assert.equal(swings, need, `应恰好 ${need} 下砍死`);
  assert.equal(w.kills, 1, 'boss 只应计 1 个击杀（计分公式安全）');
});

test('boss：一次冲刺不能把 boss 连成秒杀（stagger 无敌拦住多段命中）', () => {
  const w = new World(4, { automaticSpawns: false });
  w.resize(160, 44);
  w.spawnBoss('right');
  const boss = w.enemies[0]!;
  const need = boss.hp;
  boss.x = w.player.x + w.fh * 0.4;
  boss.y = w.player.y;
  w.player.face = 1;
  // 一次冲刺（DASH_TIME 内每帧重判），boss 只应掉 1 段血。
  w.step(1 / 60, { move: 0, jump: false, slash: false, dash: true });
  for (let i = 0; i < 11 && w.enemies.length > 0; i++) {
    boss.x = w.player.x;               // 一直贴着，制造"每帧都在刀上"的极端情况
    w.step(1 / 60, NO_INTENT);
  }
  assert.ok(w.enemies.length > 0, '一次冲刺把 boss 秒了 —— stagger 无敌没拦住');
  assert.ok(boss.hp >= need - 1, `一次冲刺掉了 ${need - boss.hp} 段血，应最多 1 段`);
  assert.equal(w.kills, 0, '冲刺没砍死 boss 却计了击杀');
});

test('boss：清屏波一击带走（任务完成的仪式性全清不看多段血）', () => {
  const w = new World(5, { automaticSpawns: false });
  w.resize(160, 44);
  w.spawnBoss('left');
  const boss = w.enemies[0]!;
  boss.x = w.player.x;                 // 波锋从玩家处向两边扫，必扫到
  w.taskDone();
  for (let i = 0; i < 400 && w.enemies.length > 0; i++) w.step(STEP, NO_INTENT);
  assert.equal(w.enemies.length, 0, '清屏波没把 boss 带走');
  assert.ok(w.kills >= 1, 'boss 被清屏波带走应计入击杀');
});

test('boss：前摇是更长的 BOSS_WINDUP，够得更远，打满会命中玩家', () => {
  const w = new World(6, { automaticSpawns: false });
  w.resize(160, 44);
  w.spawnBoss('right');
  const boss = w.enemies[0]!;
  boss.cool = 0;
  const hp0 = w.player.hp;
  let maxWindup = 0;
  for (let i = 0; i < 120 && w.player.hp === hp0; i++) {
    boss.x = w.player.x + w.fh * 1.0;  // near(boss 1.15) 内、命中(boss 1.4) 内
    boss.y = w.player.y;
    w.player.invuln = 0;               // 不靠无敌帧躲，专测命中
    w.hitstop = 0;                     // 跳过顿帧冻结
    w.step(STEP, NO_INTENT);
    maxWindup = Math.max(maxWindup, boss.windup);
  }
  assert.ok(maxWindup > 0.42, `boss 前摇应比 grunt(0.42) 长，峰值 ${maxWindup.toFixed(2)}`);
  assert.ok(w.player.hp < hp0, 'boss 打满前摇没能命中玩家（更宽命中距离失效？）');
});
