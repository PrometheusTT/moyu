import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keys, type Cmd } from '../../src/input/keys.ts';

const enc = new TextEncoder();
const hit = (k: Keys, s: string, now: number): Cmd[] => k.feed(enc.encode(s), now);

/** 两档窗口的实际数字。改了实现这里要跟着改 —— 这是手感的定义，不该悄悄漂。 */
const FIRST = 340;
const HOLD = 150;

test('第一次按下给长窗口，桥过自动重复的首次延迟（否则走路会一顿一顿的）', () => {
  const k = new Keys();
  hit(k, 'd', 1000);
  assert.equal(k.intent(1000).move, 1);
  assert.equal(k.intent(1000 + FIRST - 1).move, 1, `按住的头 ${FIRST}ms 里必须一直在走`);
  assert.equal(k.intent(1000 + FIRST).move, 0, '窗口到点就该停（没有松开事件，只能靠它）');
});

test('进到重复流里窗口收紧到 150ms，松手才跟手', () => {
  const k = new Keys();
  hit(k, 'd', 1000);              // 第一次：窗口到 1340
  hit(k, 'd', 1200);              // 还在窗口内 → 认定是自动重复，收紧到 1200+150
  assert.equal(k.intent(1349).move, 1);
  assert.equal(k.intent(1350).move, 0, `重复流里的窗口该是 ${HOLD}ms，不是 ${FIRST}ms`);
});

test('窗口过期之后再按，重新算成"第一次"', () => {
  const k = new Keys();
  hit(k, 'd', 1000);
  hit(k, 'd', 2000);              // 前一个窗口早过期了
  assert.equal(k.intent(2000 + FIRST - 1).move, 1, '又是一次新的按下，该给长窗口');
});

test('同时按住左右听后按的那个，而不是抵消成站着不动', () => {
  const k = new Keys();
  hit(k, 'd', 1000);
  hit(k, 'a', 1010);
  assert.equal(k.intent(1020).move, -1, '后按的是左');
  hit(k, 'd', 1030);
  assert.equal(k.intent(1040).move, 1, '又按了右，就该往右');
});

test('跳和砍是脉冲：按一次只算一次', () => {
  const k = new Keys();
  hit(k, 'j', 1000);
  hit(k, 'w', 1000);
  const a = k.intent(1000);
  assert.deepEqual({ jump: a.jump, slash: a.slash }, { jump: true, slash: true });
  const b = k.intent(1001);
  assert.deepEqual({ jump: b.jump, slash: b.slash }, { jump: false, slash: false },
    '脉冲没被读走 —— 一次按下会连续触发好几帧');
});

test('一个 chunk 里的多个按键都算（PTY 会把连打合并成一段字节）', () => {
  const k = new Keys();
  hit(k, 'ddj', 1000);
  const it = k.intent(1000);
  assert.equal(it.move, 1);
  assert.equal(it.slash, true);
});

test('方向键的两种编码都认（普通光标模式和应用光标模式）', () => {
  for (const [seq, want] of [['\x1b[C', 1], ['\x1b[D', -1], ['\x1bOC', 1], ['\x1bOD', -1]] as const) {
    const k = new Keys();
    hit(k, seq, 1000);
    assert.equal(k.intent(1000).move, want, JSON.stringify(seq));
  }
  for (const seq of ['\x1b[A', '\x1bOA']) {
    const k = new Keys();
    hit(k, seq, 1000);
    assert.equal(k.intent(1000).jump, true, JSON.stringify(seq));
  }
});

test('方向键的字节不会被当成字母键（ESC [ D 里的 D 不是"往右走"）', () => {
  const k = new Keys();
  hit(k, '\x1b[D', 1000);
  assert.equal(k.intent(1000).move, -1, 'ESC [ D 是左键；把里面的 D 也算一遍就会左右打架');
});

test('非操作按键作为命令返回，不影响意图', () => {
  const k = new Keys();
  assert.deepEqual(hit(k, 'q', 1000), ['quit']);
  assert.deepEqual(hit(k, '\x03', 1000), ['quit'], 'Ctrl+C');
  assert.deepEqual(hit(k, 't', 1000), ['task-done']);
  assert.deepEqual(hit(k, 'y', 1000), ['task-start']);
  assert.deepEqual(hit(k, '\x12', 1000), ['redraw'], 'Ctrl+R');
  assert.deepEqual(hit(k, 'txyq', 1000), ['task-done', 'task-start', 'quit'], '一段字节里的多条命令按序返回');
  const it = k.intent(1000);
  assert.deepEqual(it, { move: 0, jump: false, slash: false }, '命令键不该动到角色');
});

test('不认识的字节被忽略，不会误触发', () => {
  const k = new Keys();
  assert.deepEqual(hit(k, 'zxcvbnm', 1000), []);
  assert.deepEqual(k.intent(1000), { move: 0, jump: false, slash: false });
});

test('终端塞回来的回复不会变成操作 —— 载荷里全是 ; 和十六进制字母', () => {
  // 这不是理论问题：`;` 绑的是砍，`a`/`d` 是左右，`f` 也是砍，而
  // OSC 11 的背景色回复 `rgb:2e2e/3434/4646` 里既有 `;` 又有 a–f。
  // 不整段跳过的话，光是查一次终端背景色就能让角色自己挥刀乱走。
  for (const reply of [
    '\x1b[?1;2c',                             // DA1
    '\x1b[>0;276;0c',                         // DA2
    '\x1b[24;80R',                            // CPR
    '\x1b[<0;30;10M',                         // SGR 鼠标按下
    '\x1b[<0;30;10m',                         // SGR 鼠标松开
    '\x1b]11;rgb:2e2e/3434/4646\x1b\\',      // OSC 11 背景色（载荷里有 a–f）
    '\x1b]52;c;YWJjZGVm\x07',                // OSC 52 剪贴板
    '\x1bP>|ghostty 1.3.1\x1b\\',            // DCS 版本回复
    '\x1b[27;5;100~',                         // kitty 风格的功能键
  ]) {
    const k = new Keys();
    const cmds = hit(k, reply, 1000);
    assert.deepEqual(cmds, [], JSON.stringify(reply));
    assert.deepEqual(k.intent(1000), { move: 0, jump: false, slash: false }, JSON.stringify(reply));
  }
});

test('回复被切成两个 chunk 也不漏（PTY 的 read 会在任意位置切断）', () => {
  const reply = '\x1b]11;rgb:2e2e/3434/4646\x1b\\';
  const bytes = enc.encode(reply);
  for (let cut = 1; cut < bytes.length; cut++) {
    const k = new Keys();
    k.feed(bytes.subarray(0, cut), 1000);
    k.feed(bytes.subarray(cut), 1000);
    assert.deepEqual(k.intent(1000), { move: 0, jump: false, slash: false }, `切在第 ${cut} 字节后`);
  }
});

test('回复后面紧跟的真按键照样生效', () => {
  const k = new Keys();
  hit(k, '\x1b[24;80Rd', 1000);
  assert.equal(k.intent(1000).move, 1, '跳过整段回复之后要回到正常状态');
});

test('clear() 清掉 latch —— 焦点离开游戏时角色不能自己走', () => {
  const k = new Keys();
  hit(k, 'd', 1000);
  hit(k, 'j', 1000);
  k.clear();
  assert.deepEqual(k.intent(1000), { move: 0, jump: false, slash: false });
});
