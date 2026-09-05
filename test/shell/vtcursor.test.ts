import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VtCursor } from '../../src/shell/vtcursor.ts';
import { emitSgr } from '../../src/shell/sgr.ts';

const enc = new TextEncoder();

function vt(cols = 80, rows = 24): VtCursor {
  return new VtCursor({ cols, rows });
}

/** 喂字符串，返回同一个实例，方便链式断言。 */
function feed(v: VtCursor, s: string): VtCursor {
  v.feed(enc.encode(s));
  return v;
}

/** 断言光标在 (row, col)。失败信息里带上实际值，比 assert.equal 两次好读。 */
function at(v: VtCursor, row: number, col: number, msg?: string): void {
  assert.deepEqual({ row: v.row, col: v.col }, { row, col }, msg);
}

test('初始状态在左上角', () => {
  at(vt(), 1, 1);
});

test('可打印字符推进列号', () => {
  at(feed(vt(), 'abc'), 1, 4);
});

test('CJK 宽字符占两列', () => {
  // 「你好」= 2 个宽字符 = 4 列，光标落在第 5 列
  at(feed(vt(), '你好'), 1, 5);
});

test('组合字符宽度为 0', () => {
  // e + U+0301（组合尖音符）只推进一列
  at(feed(vt(), 'é'), 1, 2);
});

test('CR 回到第一列但不换行', () => {
  at(feed(vt(), 'abc\r'), 1, 1);
});

test('LF 换行但不回列（内层自己发 CRLF）', () => {
  at(feed(vt(), 'abc\n'), 2, 4);
});

test('BS 退一列，第一列时不动', () => {
  at(feed(vt(), 'ab\b'), 1, 2);
  at(feed(vt(), '\b'), 1, 1);
});

test('制表位落在第 9、17 列', () => {
  const v = feed(vt(), '\t');
  at(v, 1, 9);
  feed(v, '\t');
  at(v, 1, 17);
});

test('HTS / TBC 能改制表位', () => {
  const v = vt();
  feed(v, '\x1b[3g');       // TBC 3 = 清掉全部制表位
  feed(v, '\t');
  at(v, 1, 80, '没有制表位时 HT 走到行尾');

  const w = vt();
  feed(w, '\x1b[3g\x1b[1;5H\x1bH\x1b[1;1H\t');  // 在第 5 列设一个制表位
  at(w, 1, 5);
});

test('CUP 绝对定位，参数缺省为 1', () => {
  at(feed(vt(), '\x1b[10;20H'), 10, 20);
  at(feed(vt(), '\x1b[H'), 1, 1);
  at(feed(vt(), '\x1b[5H'), 5, 1);
});

test('CUP 超界被夹到屏幕内', () => {
  at(feed(vt(80, 24), '\x1b[99;99H'), 24, 80);
});

test('相对移动 CUU/CUD/CUF/CUB，0 视作 1', () => {
  const v = feed(vt(), '\x1b[10;10H');
  at(feed(v, '\x1b[3A'), 7, 10);
  at(feed(v, '\x1b[2B'), 9, 10);
  at(feed(v, '\x1b[4C'), 9, 14);
  at(feed(v, '\x1b[0D'), 9, 13, 'CSI 0 D 等价于 CSI 1 D');
});

test('VPA / CHA / HPA 单轴定位', () => {
  const v = feed(vt(), '\x1b[10;10H');
  at(feed(v, '\x1b[5d'), 5, 10);
  at(feed(v, '\x1b[7G'), 5, 7);
  at(feed(v, '\x1b[3`'), 5, 3);
});

test('CNL / CPL 换行并回到第一列', () => {
  const v = feed(vt(), '\x1b[10;10H');
  at(feed(v, '\x1b[2E'), 12, 1);
  at(feed(v, '\x1b[3F'), 9, 1);
});

test('pendingWrap：写满最后一列时光标停在该列', () => {
  const v = vt(5, 3);
  feed(v, 'abcde');
  at(v, 1, 5, '第 5 个字符写完，光标仍在第 5 列');
  assert.equal(v.pendingWrap, true);
  feed(v, 'f');
  at(v, 2, 2, '下一个字符才真正换行');
  assert.equal(v.pendingWrap, false);
});

test('DECAWM 关掉后不换行，光标钉在最后一列', () => {
  const v = vt(5, 3);
  feed(v, '\x1b[?7l');
  feed(v, 'abcdefgh');
  at(v, 1, 5);
  assert.equal(v.pendingWrap, false);
});

test('宽字符在最后一列会提前换行', () => {
  const v = vt(5, 3);
  feed(v, 'abcd');   // 光标在第 5 列
  at(v, 1, 5);
  feed(v, '你');      // 宽度 2，第 5 列放不下
  at(v, 2, 3, '整个字符移到下一行开头');
});

test('DECSC / DECRC 往返保存位置和 SGR', () => {
  const v = vt();
  feed(v, '\x1b[10;20H\x1b[1;31m\x1b7');   // 保存
  feed(v, '\x1b[1;1H\x1b[0m');             // 破坏现场
  at(v, 1, 1);
  feed(v, '\x1b8');                        // 恢复
  at(v, 10, 20);
  assert.equal(emitSgr(v.sgr), emitSgr(feed(vt(), '\x1b[1;31m').sgr));
});

test('CSI s / CSI u 也走同一套保存槽', () => {
  const v = vt();
  feed(v, '\x1b[7;7H\x1b[s\x1b[1;1H\x1b[u');
  at(v, 7, 7);
});

test('DECOM 原点模式让定位相对滚动区', () => {
  const v = vt(80, 24);
  feed(v, '\x1b[5;20r');    // 滚动区 5..20
  feed(v, '\x1b[?6h');      // 开原点模式
  feed(v, '\x1b[1;1H');
  at(v, 5, 1, '原点模式下第 1 行 = 滚动区顶部');
  feed(v, '\x1b[99;1H');
  at(v, 20, 1, '原点模式下不能越出滚动区底部');
  feed(v, '\x1b[?6l\x1b[1;1H');
  at(v, 1, 1, '关掉后回到绝对坐标');
});

test('DECSTBM 只记录不夹取（夹取是 passthrough 的职责）', () => {
  const v = vt(80, 24);
  feed(v, '\x1b[5;20r');
  assert.equal(v.scrollTop, 5);
  assert.equal(v.scrollBot, 20);
  feed(v, '\x1b[r');
  assert.equal(v.scrollTop, 1);
  assert.equal(v.scrollBot, 24, '裸 CSI r 复位成全屏');
});

test('DECSTBM 把光标移到左上（原点模式下是滚动区左上）', () => {
  const v = feed(vt(), '\x1b[10;10H');
  feed(v, '\x1b[5;20r');
  at(v, 1, 1);
});

test('IND / RI / NEL 在滚动区边界不改行号', () => {
  const v = vt(80, 24);
  feed(v, '\x1b[5;20r\x1b[?6l\x1b[20;3H');
  feed(v, '\x1bD');            // IND 在滚动区底部
  at(v, 20, 3, '真实终端会滚动内容，光标行号不变');
  feed(v, '\x1b[5;3H\x1bM');   // RI 在滚动区顶部
  at(v, 5, 3);
  feed(v, '\x1b[10;5H\x1bE');  // NEL
  at(v, 11, 1);
});

test('?25h / ?25l 跟踪光标可见性', () => {
  const v = vt();
  assert.equal(v.visible, true);
  feed(v, '\x1b[?25l');
  assert.equal(v.visible, false);
  feed(v, '\x1b[?25h');
  assert.equal(v.visible, true);
});

test('备用屏切换被镜像下来', () => {
  const v = vt();
  feed(v, '\x1b[?1049h');
  assert.equal(v.altScreen, true);
  feed(v, '\x1b[?1049l');
  assert.equal(v.altScreen, false);
});

test('OSC 用 BEL 和 ST 两种终结符都能正确吞掉', () => {
  at(feed(vt(), '\x1b]0;title\x07abc'), 1, 4);
  at(feed(vt(), '\x1b]0;title\x1b\\abc'), 1, 4);
  at(feed(vt(), '\x1b]52;c;SGVsbG8=\x07x'), 1, 2, 'OSC 52 载荷里的 base64 不该被当序列');
});

test('DCS 载荷被吞掉', () => {
  at(feed(vt(), '\x1bP+q544\x1b\\ab'), 1, 3);
});

test('RIS 全复位', () => {
  const v = vt();
  feed(v, '\x1b[10;10H\x1b[1;31m\x1b[5;20r\x1b[?25l');
  feed(v, '\x1bc');
  at(v, 1, 1);
  assert.equal(v.visible, true);
  assert.equal(v.scrollTop, 1);
  assert.equal(v.scrollBot, 24);
  assert.equal(emitSgr(v.sgr), '\x1b[0m');
});

test('SGR 真彩色带冒号子参数不会错位', () => {
  const a = feed(vt(), '\x1b[38:2::255:0:0m');
  const b = feed(vt(), '\x1b[38;2;255;0;0m');
  assert.equal(emitSgr(a.sgr), emitSgr(b.sgr), '38:2::R:G:B 和 38;2;R;G;B 等价');
  assert.match(emitSgr(a.sgr), /38;2;255;0;0/);
});

test('序列跨 feed 调用被切断也能续上', () => {
  const v = vt();
  const parts = ['\x1b', '[', '1', '0', ';', '2', '0', 'H'];
  for (const p of parts) feed(v, p);
  at(v, 10, 20);
});

test('resize 夹取光标和滚动区', () => {
  const v = vt(80, 24);
  feed(v, '\x1b[5;20r\x1b[20;70H');
  v.resize(40, 10);
  at(v, 10, 40);
  // 5..20 缩到 5..10 之后依然是合法区间，就保留内层的意图 ——
  // 解析器的职责是如实反映内层说过什么，不是替它做决定。
  assert.equal(v.scrollTop, 5);
  assert.equal(v.scrollBot, 10);
});

test('resize 把塌陷的滚动区复位成全屏', () => {
  const v = vt(80, 24);
  feed(v, '\x1b[18;24r');
  v.resize(80, 10);   // top 夹到 10、bottom 夹到 10 → 空区间
  assert.equal(v.scrollTop, 1);
  assert.equal(v.scrollBot, 10);
});

test('restoreSeq 先发 SGR 再定位再管可见性', () => {
  const v = vt();
  feed(v, '\x1b[?25l\x1b[1;31m\x1b[7;13H');
  const s = v.restoreSeq();
  assert.match(s, /^\x1b\[0[;m]/, 'SGR 以 reset 打头，保证幂等');
  assert.ok(s.indexOf('7;13H') > s.indexOf('31'), 'CUP 在 SGR 之后');
  assert.ok(s.endsWith('\x1b[?25l'), '可见性最后设，避免定位过程中光标闪现');
});
