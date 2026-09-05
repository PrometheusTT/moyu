import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Game, TITLE } from '../../src/app/game.ts';
import { appendSignal } from '../../src/bridge/signal.ts';

const enc = new TextEncoder();

/** 造一个用独立事件文件的 Game。`MOYU_EVENTS` 必须在构造**之前**设好。 */
function mkGame(seed: number): { g: Game; file: string; done: () => void } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-g-')), 'events.log');
  const old = process.env.MOYU_EVENTS;
  process.env.MOYU_EVENTS = file;
  const g = new Game({ seed });
  g.resize(120, 40);
  return {
    g,
    file,
    done: () => { if (old === undefined) delete process.env.MOYU_EVENTS; else process.env.MOYU_EVENTS = old; },
  };
}

/** 推 n 帧（30fps）。信号轮询是每 8 帧一次，所以想看到信号生效至少要 9 帧。 */
function frames(g: Game, n: number, from: number): number {
  let t = from;
  for (let i = 0; i < n; i++) g.advance(t += 33);
  return t;
}

test('标题页按任意键开打，HUD 上是那句标题', () => {
  const { g, done } = mkGame(2);
  try {
    assert.equal(g.world.phase, 'title');
    assert.equal(g.hud().left, TITLE, '标题必须一字不差地出现在 HUD 上');
    g.feed(enc.encode('j'));
    frames(g, 4, 1_000_000);
    assert.equal(g.world.phase, 'fight');
    assert.match(g.hud().left, /砍了 \d+ 个/);
    assert.equal(g.hud().urgent, false);
  } finally { done(); }
});

test('事件文件里来一个 done：清屏技 + 响铃 + 桌面通知 + 红横幅', () => {
  const { g, file, done } = mkGame(3);
  try {
    g.feed(enc.encode('j'));
    let t = frames(g, 10, 1_000_000);
    assert.equal(g.world.phase, 'fight');

    appendSignal('done', file);
    t = frames(g, 12, t);
    assert.equal(g.world.phase, 'clear', 'hook 写的 done 没被读到 —— 整个联动就是这一条线');

    const alert = g.takeAlert();
    assert.ok(alert !== null, '任务完成没发通知 —— 摸鱼摸过头错过下一步，这个产品就是负分');
    assert.ok(alert.includes('\x07'), '没响铃');
    assert.ok(alert.includes('\x1b]9;'), '没发 OSC 9 桌面通知');
    assert.equal(g.takeAlert(), null, '通知该只发一次');
    assert.equal(g.hud().urgent, true, '横幅必须是显眼的那一档');

    t = frames(g, 90, t);
    assert.equal(g.world.phase, 'paused');
    assert.match(g.hud().left, /任务完成/);
    assert.match(g.hud().right, /等下一个任务/);

    appendSignal('start', file);
    frames(g, 12, t);
    assert.equal(g.world.phase, 'fight', '下一个任务开始了游戏没接着跑');
  } finally { done(); }
});

test('notify 和"任务完成"分开报（需要你确认比已完成更紧急）', () => {
  const { g, file, done } = mkGame(5);
  try {
    g.feed(enc.encode('j'));
    const t = frames(g, 10, 1_000_000);
    appendSignal('notify', file);
    frames(g, 12, t);
    assert.equal(g.world.phase, 'clear');
    assert.match(g.takeAlert() ?? '', /要你确认/);
  } finally { done(); }
});

test('t 键是同一条路径（没装 hook 也能玩）', () => {
  const { g, done } = mkGame(7);
  try {
    g.feed(enc.encode('j'));
    frames(g, 10, 1_000_000);
    g.feed(enc.encode('t'));
    assert.equal(g.world.phase, 'clear');
    assert.ok((g.takeAlert() ?? '').includes('\x07'));
  } finally { done(); }
});

test('清屏技放到一半又来一个 done 不会重放（横幅会闪成两次）', () => {
  const { g, done } = mkGame(11);
  try {
    g.feed(enc.encode('j'));
    frames(g, 10, 1_000_000);
    g.feed(enc.encode('t'));
    const r = g.world.waveR;
    g.takeAlert();
    g.feed(enc.encode('t'));
    assert.equal(g.world.waveR, r, '冲击波被重置回起点了');
    assert.equal(g.takeAlert(), null, '同一次任务完成响了两遍');
  } finally { done(); }
});

test('q / Ctrl+C 报告"要退出"，其它键不报', () => {
  const { g, done } = mkGame(13);
  try {
    assert.equal(g.feed(enc.encode('d')), false);
    assert.equal(g.feed(enc.encode('q')), true);
    assert.equal(g.feed(enc.encode('\x03')), true);
  } finally { done(); }
});

test('卡了 5 秒不追帧（追帧会让角色一次跳过半个屏幕）', () => {
  const { g, done } = mkGame(17);
  try {
    g.feed(enc.encode('j'));
    let t = frames(g, 20, 1_000_000);
    const before = g.world.time;
    g.advance(t += 5000);
    const dt = g.world.time - before;
    assert.ok(dt <= 0.26, `一帧补了 ${dt.toFixed(3)}s 的模拟 —— 上限该是 0.25s`);
  } finally { done(); }
});

test('一次按下的跳/砍只算一个子步（否则同一帧里会被算好几次）', () => {
  const { g, done } = mkGame(19);
  try {
    g.feed(enc.encode('j'));
    let t = frames(g, 20, 1_000_000);
    // 攒够 3 个子步的时间再喂一次砍，然后看它只触发一次挥刀。
    g.feed(enc.encode('j'));
    g.advance(t += 50);
    assert.ok(g.world.slashes.length <= 1, `一次按下挥了 ${g.world.slashes.length} 刀`);
  } finally { done(); }
});

test('events:false 时完全不碰文件系统（bench / 单测用）', () => {
  const old = process.env.MOYU_EVENTS;
  process.env.MOYU_EVENTS = '/nonexistent-dir-xyz/ev.log';
  try {
    const g = new Game({ seed: 23, events: false });
    g.resize(120, 40);
    g.feed(enc.encode('j'));
    frames(g, 30, 1_000_000);
    assert.equal(g.world.phase, 'fight');
  } finally {
    if (old === undefined) delete process.env.MOYU_EVENTS; else process.env.MOYU_EVENTS = old;
  }
});
