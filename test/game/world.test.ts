import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT, type Intent } from '../../src/core/world.ts';

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
