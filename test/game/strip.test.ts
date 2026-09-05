/**
 * 条形区域（1~4 个字符行 = 2~8 个像素行）下的模拟。
 *
 * 这个文件的存在理由：整套手感常数原来都以 `fh`（身高）为单位，而条形区域里 `fh` 从 26
 * 掉到 3 —— 于是速度、加速度、断肢初速、杂兵数量、走路频率全被一起缩小了 8 倍，
 * 结果是"小人在一条 40 像素宽的地上以每秒 7 像素挪动"。看着不像难度低，看着像卡了。
 *
 * 所以每一条被改成"以画布宽度兜底"的常数都要有一条断言钉住，而且**必须同时钉住全屏那一端**
 * —— 兜底公式写错的典型症状不是条形坏掉，是把 `moyu demo` 的手感一起改了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, NO_INTENT, type Intent } from '../../src/core/world.ts';
import { segments } from '../../src/core/stick.ts';

const STEP = 1 / 60;

function run(w: World, n: number, f: (i: number) => Intent = () => NO_INTENT): void {
  for (let i = 0; i < n; i++) w.step(STEP, f(i));
}

/** 整个人（含头的半径）在画布里的最高点。负数 = 头飞出去了。 */
function topOf(w: World): number {
  let top = Infinity;
  for (const f of [w.player, ...w.enemies]) {
    for (const s of segments(f)) top = Math.min(top, Math.min(s.y0, s.y1) - s.r);
  }
  return top;
}

test('两行的条（4 个像素行）里站得下一个人，而且他站在地上', () => {
  const w = new World(7);
  w.resize(40, 4);
  assert.equal(w.fh, 3, '4 个像素行该给 3 像素身高（1 像素贴地余量 + 头顶一格空气）');
  assert.equal(w.player.y, w.ground);
  assert.ok(topOf(w) >= -0.5, `站着就已经出画布了：top=${topOf(w)}`);
});

test('没有头顶空间时跳键是空操作 —— 宁可不能跳，也不要头飞出画布', () => {
  for (const h of [4, 6, 8]) {
    const w = new World(11);
    w.resize(40, h);
    assert.equal(w.jumpV, 0, `${h} 个像素行不该跳得起来`);
    w.taskStart();
    let top = Infinity;
    run(w, 60 * 4, () => ({ move: 1, jump: true, slash: false }));
    top = Math.min(top, topOf(w));
    assert.equal(w.player.y, w.ground, `${h}px：按着跳键把人抬起来了`);
    assert.ok(top >= -0.5, `${h}px：有人的头出了画布，top=${top}`);
  }
});

test('有空间的尺寸下跳跃的顶点仍然留在画布里', () => {
  for (const [cw, ch] of [[60, 16], [120, 40], [160, 78]] as const) {
    const w = new World(13);
    w.resize(cw, ch);
    assert.ok(w.jumpV > 0, `${cw}x${ch} 该跳得起来`);
    w.taskStart();
    let top = Infinity;
    for (let i = 0; i < 60 * 6; i++) {
      w.step(STEP, { move: i % 90 < 45 ? 1 : -1, jump: true, slash: false });
      top = Math.min(top, topOf(w));
    }
    assert.ok(top >= -0.5, `${cw}x${ch}：跳到画布外面了，top=${top}`);
  }
});

test('条形区域里照样能砍碎人（断肢的初速按画布宽兜底，不然它原地不动）', () => {
  const w = new World(3);
  w.resize(40, 4);
  w.taskStart();
  let hit = -1;
  for (let i = 0; i < 60 * 25 && hit < 0; i++) {
    const t = w.enemies[0];
    const move: -1 | 0 | 1 = t === undefined ? 0 : t.x > w.player.x ? 1 : -1;
    w.step(STEP, { move, jump: false, slash: true });
    if (w.kills > 0) hit = i;
  }
  assert.ok(hit >= 0, '25 秒都没砍死一个 —— 条形区域里刀根本碰不到人');
  assert.ok(w.pieces.length >= 3, `断肢只有 ${w.pieces.length} 块`);
  assert.ok(w.pieces.some((p) => p.vy < -1), '断肢一块都没被挑起来（初速被身高缩成 0 了）');
  assert.ok(w.blood.length > 0, '没喷血');
});

test('杂兵数量按场地宽度封顶 —— 40 像素宽的地上挤 11 个人就没有走位了', () => {
  const w = new World(5);
  w.resize(40, 4);
  w.taskStart();
  let most = 0;
  run(w, 60 * 60, () => NO_INTENT);
  for (let i = 0; i < 60 * 30; i++) {
    w.step(STEP, NO_INTENT);
    most = Math.max(most, w.enemies.length);
  }
  assert.ok(most <= 3, `场上最多同时有 ${most} 个杂兵，40 像素宽装不下`);
  assert.ok(most >= 2, '一个杂兵都不来（封顶算成 0 了）');
});

/** 从最左边走到最右边要几帧。清掉杂兵，测的是纯位移。 */
function crossFrames(cw: number, ch: number): number {
  const w = new World(17);
  w.resize(cw, ch);
  w.taskStart();
  w.player.x = 2;
  for (let i = 0; i < 60 * 20; i++) {
    w.enemies.length = 0;              // 被撞一下就会倒退，这里只量位移
    w.step(1 / 60, { move: 1, jump: false, slash: false });
    if (w.player.x >= w.w - 3) return i;
  }
  return -1;
}

test('走完整块场地的时间与画布尺寸无关（速度原来按身高缩，条形区域里会像走在糖浆里）', () => {
  const strip = crossFrames(40, 4);
  const demo = crossFrames(160, 78);
  for (const [name, f] of [['条形', strip], ['全屏', demo]] as const) {
    assert.ok(f > 0, `${name}：20 秒都没走到对面`);
    assert.ok(f >= 60 * 2 && f <= 60 * 6, `${name}：走完一趟用了 ${(f / 60).toFixed(1)}s，不在 2~6 秒之间`);
  }
  // 身高从 26 掉到 3 是 8.7 倍，所以这条容差只要不离谱就能抓住"速度跟着身高缩"这个回归。
  assert.ok(
    Math.abs(strip - demo) / demo < 0.4,
    `条形 ${(strip / 60).toFixed(2)}s vs 全屏 ${(demo / 60).toFixed(2)}s：横向手感在两个尺度上不一样`,
  );
});

test('全屏那一端的手感常数一个都没变（兜底公式写错的典型症状是把 demo 一起改了）', () => {
  const w = new World(23);
  w.resize(160, 78);
  assert.equal(w.fh, 26);
  assert.equal(w.player.speed, 62.4);
  assert.ok(Math.abs(w.jumpV - 140.4) < 1e-9, `jumpV=${w.jumpV}`);
  const s = new World(23);
  s.resize(120, 40);
  assert.equal(s.fh, 25, '测试里常用的 120x40 也别跟着动');
});

test('拖窗口从全屏缩到一条，再拖回去，不清场也不飘人', () => {
  const w = new World(29);
  w.resize(160, 78);
  w.taskStart();
  run(w, 60 * 6, (i) => ({ move: i % 60 < 30 ? 1 : -1, jump: i % 40 === 0, slash: i % 25 === 0 }));
  const kills = w.kills;
  const live = w.enemies.length;
  w.resize(40, 4);
  assert.equal(w.kills, kills, '缩成一条把战绩清了');
  assert.equal(w.enemies.length, live, '缩成一条把人清了');
  assert.equal(w.fh, 3);
  for (const f of [w.player, ...w.enemies]) {
    assert.equal(f.y, w.ground, '缩放后有人飘着');
    assert.ok(f.x >= 0 && f.x <= w.w, `有人被缩到画布外：x=${f.x}`);
  }
  run(w, 60 * 3, () => ({ move: 1, jump: true, slash: true }));
  assert.ok(topOf(w) >= -0.5, `缩成一条之后头出画布了：top=${topOf(w)}`);
  // 上面那 3 秒又砍死了几个，所以这里要重新取一次 —— 断言的是"resize 本身不清场"。
  const k2 = w.kills;
  w.resize(160, 78);
  assert.equal(w.fh, 26);
  assert.equal(w.kills, k2, '放大把战绩清了');
  run(w, 60 * 2);
  for (const f of [w.player, ...w.enemies]) assert.equal(f.y, w.ground, '放大后有人飘着');
});
