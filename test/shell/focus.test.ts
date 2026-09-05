/**
 * 输入路由的回归测试。
 *
 * 这个文件之所以存在：`^G ^G` 曾经把一个**字面 `0x07`** 转发进内层，而 claude 的
 * Ctrl+G 是"打开外部编辑器" —— 一按就跳进一个文档编辑界面，看起来像外壳失灵了。
 * 路由层当时一个测试都没有，所以这条 bug 只能靠人在真终端里撞见。
 *
 * 下面的断言分两类：**归属**（每个字节该给谁）和**不泄漏**（热键的字节绝不能漏进内层）。
 * 后者是这个文件的重点 —— 漏一个字节进内层就是往用户的对话框里插字符。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter, PREFIX, hotkeyHint, pendingHint, pendingRows, type Action } from '../../src/shell/focus.ts';
import { stringWidth } from '../../src/shell/wcwidth.ts';

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const join3 = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));

/** 拼出所有"送进内层"的字节。热键测试盯的就是这个流里有没有多余的东西。 */
function forwarded(as: Action[]): number[] {
  const out: number[] = [];
  for (const a of as) if (a.kind === 'forward') out.push(...a.bytes);
  return out;
}

/** 拼出所有交给游戏的字节。 */
function toGame(as: Action[]): number[] {
  const out: number[] = [];
  for (const a of as) if (a.kind === 'game') out.push(...a.bytes);
  return out;
}

const kinds = (as: Action[]): string[] => as.map((a) => a.kind);

test('默认全部转发给内层，相邻字节合并成一次写', () => {
  const r = new InputRouter();
  const as = r.route(bytes('npm test\r'));
  assert.equal(as.length, 1, '被拆成了多个动作 —— 内层看到的分块边界越少越好');
  assert.deepEqual(kinds(as), ['forward']);
  assert.deepEqual(forwarded(as), [...bytes('npm test\r')]);
});

test('焦点在游戏时按键归游戏，一个字节也不漏进内层', () => {
  const r = new InputRouter({ focus: 'game' });
  const as = r.route(bytes('adj '));
  assert.deepEqual(kinds(as), ['game']);
  assert.deepEqual(toGame(as), [...bytes('adj ')]);
  assert.deepEqual(forwarded(as), [], '游戏的按键跑到内层去了 —— 会往对话框里插字符');
});

test('Ctrl+C 不管焦点在哪都给内层（要中断的是任务，不是摸鱼游戏）', () => {
  const r = new InputRouter({ focus: 'game' });
  const as = r.route(Uint8Array.of(0x61, 0x03, 0x64));
  assert.deepEqual(forwarded(as), [0x03]);
  assert.deepEqual(toGame(as), [0x61, 0x64], 'Ctrl+C 前后的按键该照常归游戏');
});

test('单按一次前缀：不产生动作、不转发任何字节，进入等命令状态', () => {
  const r = new InputRouter();
  const as = r.route(Uint8Array.of(PREFIX));
  assert.deepEqual(as, [], '前缀键自己就触发了动作');
  assert.deepEqual(forwarded(as), [], '前缀键漏进了内层');
  // HUD 靠这个 getter 立刻显示等命令的菜单。"按了没反应"就是那条 bug 的根。
  assert.equal(r.awaitingCommand, true);
});

test('^G ^G 是切焦点，而且**绝不**把字面 0x07 送进内层（这就是那条 bug）', () => {
  const r = new InputRouter();
  const as = r.route(Uint8Array.of(PREFIX, PREFIX));
  assert.deepEqual(kinds(as), ['toggle-focus'], '连按前缀没有切焦点');
  assert.deepEqual(
    forwarded(as),
    [],
    '有字节漏进内层 —— 如果是 0x07，claude 会打开外部编辑器（原始症状）',
  );
  assert.equal(r.awaitingCommand, false, '等命令状态没清掉，下一个字节会被当命令吃掉');
});

test('^G g / ^G Tab 都切焦点', () => {
  for (const cmd of [0x67, 0x09]) {
    const r = new InputRouter();
    assert.deepEqual(kinds(r.route(Uint8Array.of(PREFIX, cmd))), ['toggle-focus'], `命令 ${cmd}`);
    assert.deepEqual(forwarded(r.route(Uint8Array.of(PREFIX, cmd))), []);
  }
});

test('前缀和命令被切成两个 chunk 依然成立（跨读必须保状态）', () => {
  const r = new InputRouter();
  assert.deepEqual(r.route(Uint8Array.of(PREFIX)), []);
  assert.equal(r.awaitingCommand, true);
  const as = r.route(bytes('q'));
  assert.deepEqual(kinds(as), ['quit']);
  assert.equal(r.awaitingCommand, false);
});

test('未知命令被静默丢弃，不透给内层（手滑按错不该往对话框里插字符）', () => {
  const r = new InputRouter();
  const as = r.route(Uint8Array.of(PREFIX, 0x7a));   // ^G z
  assert.deepEqual(as, []);
  assert.deepEqual(forwarded(as), []);
  assert.equal(r.awaitingCommand, false);
});

test('命令表：收起 / 分屏 / 重绘 / 退出', () => {
  const cases: Array<[number, string, number?]> = [
    [0x68, 'toggle-hidden'],                    // h
    [0x2b, 'adjust-split', 1], [0x3d, 'adjust-split', 1], [0x6b, 'adjust-split', 1],   // + = k
    [0x2d, 'adjust-split', -1], [0x5f, 'adjust-split', -1], [0x6a, 'adjust-split', -1], // - _ j
    [0x72, 'redraw'], [0x0c, 'redraw'],         // r / Ctrl+L
    [0x71, 'quit'],                             // q
  ];
  for (const [b, kind, delta] of cases) {
    const as = new InputRouter().route(Uint8Array.of(PREFIX, b));
    assert.equal(as.length, 1, `命令 0x${b.toString(16)} 没产生动作`);
    const a = as[0]!;
    assert.equal(a.kind, kind, `命令 0x${b.toString(16)}`);
    if (delta !== undefined && a.kind === 'adjust-split') assert.equal(a.delta, delta);
  }
});

test('热键夹在普通输入中间：前后的字节照常转发，热键自己不漏', () => {
  const r = new InputRouter();
  const as = r.route(Uint8Array.of(...bytes('ab'), PREFIX, 0x67, ...bytes('cd')));
  assert.deepEqual(kinds(as), ['forward', 'toggle-focus', 'forward']);
  assert.deepEqual(forwarded(as), [...bytes('abcd')], '热键的字节混进了转发流');
});

test('提示文案把命令键写出来了（写成"^G 切焦点"就会让人再按一次前缀）', () => {
  for (const f of ['cli', 'game'] as const) {
    assert.match(hotkeyHint(f), /\^G g/, `${f}：命令键 g 必须写出来`);
    // 30 列是窄条形 HUD 在最小终端（60 列）上能给的宽度。超了就被截断，
    // 而被截断的热键提示等于没有提示。
    assert.ok(stringWidth(hotkeyHint(f)) <= 30, `${f}：${stringWidth(hotkeyHint(f))} 列，放不进 HUD`);
  }
  assert.notEqual(hotkeyHint('cli'), hotkeyHint('game'), '两个焦点的提示必须不一样 —— 它就是"焦点在哪"的唯一提示');
  assert.match(hotkeyHint('game'), /CLI/, '焦点在游戏时必须告诉人怎么回 CLI');
  for (const row of pendingRows()) {
    assert.ok(stringWidth(row) <= 30, `等命令菜单这行 ${stringWidth(row)} 列，放不进 HUD`);
  }
  assert.match(pendingRows()[0]!, /\^G/);
  assert.match(pendingHint(), /\^G/);
});

/**
 * ── kitty 键盘协议下的同一批保证 ─────────────────────────────────────
 *
 * 上面那些用例全建立在"^G 就是字节 0x07"上，而**内层一 push kitty 键盘标志，这个前提就没了**：
 * 实测 claude 2.1.260 启动时发 `CSI > 5 u`，之后 Ctrl+G 变成 `ESC [ 103 ; 5 u`。
 * 于是那条老 bug 换了个入口原地复活 —— 整条序列被当普通输入转发进内层，claude 收到
 * 一个真的 Ctrl+G，打开外部编辑器。用户的原话："^G 还是会进一个编辑界面"。
 *
 * 这一节的断言和上面一一对应：热键的字节**一个都不能漏进内层**，而不是我们的键要照常转发。
 */

/** kitty 形式的一个按键。mods 是 1+位掩码（ctrl = 4），event 1=按下 2=重复 3=松开。 */
function csiU(code: number, mods?: number, event?: number): Uint8Array {
  const m = mods === undefined ? '' : `;${mods}${event === undefined ? '' : `:${event}`}`;
  return bytes(`\x1b[${code}${m}u`);
}

const CTRL = 5;   // 1 + 4

test('kitty 编码的 ^G 也是前缀键，且整条序列不漏进内层（原始 bug 的第二个入口）', () => {
  const r = new InputRouter();
  const as = r.route(csiU(103, CTRL));
  assert.deepEqual(as, [], 'kitty 形式的前缀键触发了动作');
  assert.deepEqual(forwarded(as), [], '整条 CSI u 漏进了内层 —— claude 会打开外部编辑器');
  assert.equal(r.awaitingCommand, true, '没进等命令状态 —— ^G 变成了一次无效按键');
});

test('kitty 编码的 ^G 后面跟命令：裸字节和 CSI u 两种形式都认', () => {
  for (const cmd of [bytes('g'), csiU(103), csiU(103, CTRL)]) {
    const r = new InputRouter();
    r.route(csiU(103, CTRL));
    const as = r.route(cmd);
    assert.deepEqual(kinds(as), ['toggle-focus'], `命令形式 ${JSON.stringify(dec(cmd))}`);
    assert.deepEqual(forwarded(as), []);
    assert.equal(r.awaitingCommand, false);
  }
});

test('kitty 编码的 ctrl+字母命令换算回控制字节（^G Ctrl+L = 重绘）', () => {
  const r = new InputRouter();
  r.route(Uint8Array.of(PREFIX));
  assert.deepEqual(kinds(r.route(csiU(108, CTRL))), ['redraw'], 'CSI 108;5u 该等价于 0x0c');
});

test('^G 的自动重复和松开事件被吃掉，既不触发也不漏进内层', () => {
  for (const event of [2, 3]) {
    const r = new InputRouter();
    const as = r.route(csiU(103, CTRL, event));
    assert.deepEqual(as, [], `event ${event} 产生了动作`);
    assert.deepEqual(forwarded(as), [], `event ${event} 的字节漏进了内层`);
    assert.equal(r.awaitingCommand, false, `event ${event} 不该进等命令状态`);
  }
});

test('kitty 编码的 Ctrl+C 照样无条件给内层，而且给的是它认识的那个形式', () => {
  const r = new InputRouter({ focus: 'game' });
  const as = r.route(join3(bytes('a'), csiU(99, CTRL), bytes('d')));
  assert.deepEqual(forwarded(as), [...csiU(99, CTRL)],
    'kitty 模式下的 Ctrl+C 没给内层 —— 中断任务的键被摸鱼游戏吃了');
  assert.deepEqual(toGame(as), [...bytes('ad')]);
});

test('CSI u 被切成两个 chunk 依然成立（扣住半截，不逐字节乱认）', () => {
  const r = new InputRouter();
  const first = r.route(bytes('\x1b[103;'));
  assert.deepEqual(first, [], '半截序列被提前吐出去了');
  assert.ok(r.heldBytes > 0, '半截 CSI 没扣住');
  assert.deepEqual(r.route(bytes('5u')), []);
  assert.equal(r.heldBytes, 0, '扣住的字节没吐出去');
  assert.equal(r.awaitingCommand, true);
  assert.deepEqual(kinds(r.route(bytes('q'))), ['quit']);
});

test('末尾的裸 ESC 立刻转发，绝不扣住（ESC 是内层的中断键）', () => {
  const r = new InputRouter();
  const as = r.route(bytes('\x1b'));
  assert.deepEqual(forwarded(as), [0x1b], 'ESC 被扣住了 —— 内层的中断键会晚一个按键才到');
  assert.equal(r.heldBytes, 0);
});

test('Esc 紧跟 Ctrl+G 挤在一个 chunk 里：ESC 转发，前缀照样成立', () => {
  // ESC 后面跟控制字节不是一条转义序列。当成两字节序列转发出去就等于把 0x07 送进内层。
  const r = new InputRouter();
  const as = r.route(Uint8Array.of(0x1b, PREFIX));
  assert.deepEqual(forwarded(as), [0x1b], '0x07 跟着 ESC 一起漏进了内层');
  assert.equal(r.awaitingCommand, true);
});

test('不是我们的转义序列一律字节级原样转发', () => {
  // 方向键、带修饰的方向键、括号粘贴、内层自己的 ctrl 键、终端对标志查询的回复。
  // 少一个字节就是内层少一个按键，多一个字节就是往对话框里插字符。
  const s = '\x1b[A\x1b[1;5A\x1b[200~pasted\x1b[201~\x1b[97;5u\x1b[?5u\x1bOA\x1b[6~';
  const r = new InputRouter();
  const as = r.route(bytes(s));
  assert.deepEqual(forwarded(as), [...bytes(s)]);
  assert.equal(as.length, 1, '被拆成了多次写');
});

test('等命令状态下不认识的序列整条丢掉（不能只丢 ESC 把参数当文字漏下去）', () => {
  const r = new InputRouter();
  r.route(Uint8Array.of(PREFIX));
  const as = r.route(bytes('\x1b[A'));
  assert.deepEqual(as, []);
  assert.deepEqual(forwarded(as), [], '`[A` 漏进了内层 —— 对话框里会多出两个字符');
  assert.equal(r.awaitingCommand, false);
});

test('等命令状态下修饰键自己不消费命令（按住 Shift 找 + 的时候它先到）', () => {
  const r = new InputRouter();
  r.route(Uint8Array.of(PREFIX));
  assert.deepEqual(r.route(csiU(57441, 2)), [], '修饰键上报产生了动作');
  assert.equal(r.awaitingCommand, true, '修饰键把等命令状态消费掉了 —— 下一个键才是命令');
  assert.deepEqual(kinds(r.route(bytes('q'))), ['quit']);
});

test('带备用键码的 CSI u（`103:71;5u`）照样认得出是 ^G', () => {
  const r = new InputRouter();
  assert.deepEqual(r.route(bytes('\x1b[103:71;5u')), []);
  assert.equal(r.awaitingCommand, true);
});

test('标志 8 下字母也走 CSI u，焦点在游戏时换回裸字节喂给游戏', () => {
  // 内层现在只 push 1|4，但它哪天加上 8（"所有按键都报转义码"），游戏那层只认裸字节，
  // 不在这儿换回来就是**完全没有输入**。
  const r = new InputRouter({ focus: 'game' });
  assert.deepEqual(toGame(r.route(csiU(106))), [0x6a], "CSI 106u 该变成 'j'");
  assert.deepEqual(toGame(r.route(csiU(97, 1, 2))), [0x61], '自动重复也要给游戏 —— latch 靠它判按住');
  assert.deepEqual(forwarded(r.route(csiU(106))), [], '游戏的按键漏进了内层');
});
