import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { restoreSeq, doctorResetSeq, Teardown } from '../../src/shell/teardown.ts';
import type { RestoreOptions } from '../../src/shell/teardown.ts';
import type { TerminalLease } from '../../src/shell/supervision.ts';
import { IMAGE_ID, deleteImageSeq } from '../../src/render/graphics.ts';

/**
 * 还原序列的字节级规矩。
 *
 * 这个文件是被一条用户报的 bug 逼出来的：**退出以后渲染框还在** —— 像素档那张 kitty 图
 * 留在了屏幕上，正好挂在新提示符下面。原因不在"有没有发删除"（发了），而在**发了几次**：
 * kitty 图的存储是每个屏幕缓冲区各自一份的（Ghostty 里 `kitty_images` 是 `Screen` 的字段，
 * 而 `a=d` 只作用在 `screens.active` 上），内层 claude 启动时才切进备用屏，在那之前的
 * 几十帧落在主屏上。只删一次 = 只删掉备用屏那张，`?1049l` 一切回主屏，陈旧的那张就露出来。
 *
 * 所以下面这些断言里最重要的是"两遍，夹着 `?1049l`"。e2e 那边验的是真进程真的这么发了，
 * 这边验的是拼字节的那个纯函数本身 —— 组件测试比 e2e 便宜得多，回归会先在这里红。
 */

const DEL = deleteImageSeq();
const ALT_OFF = '\x1b[?1049l';

/** 某个子串出现的全部位置。 */
function at(s: string, sub: string): number[] {
  const out: number[] = [];
  for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + 1)) out.push(i);
  return out;
}

test('像素档的删图发两遍，一遍在撤备用屏之前、一遍在之后（两个缓冲区各一张图）', () => {
  const s = restoreSeq({ deleteImage: true, homeRow: 30 });
  const dels = at(s, DEL);
  assert.equal(dels.length, 2, `删图应该正好两遍，实际 ${dels.length} 遍`);
  const alt = s.indexOf(ALT_OFF);
  assert.ok(alt > 0, '没有撤备用屏');
  assert.ok(dels[0]! < alt, '第一遍必须在 ?1049l 之前 —— 那时活动屏幕还是备用屏');
  assert.ok(dels[1]! > alt, '第二遍必须在 ?1049l 之后 —— 切回主屏才删得掉主屏那张');
});

test('半块档一个 APC 字节都不发（不认 APC 的终端会把它当文字打出来）', () => {
  for (const opts of [{}, { deleteImage: false }, { homeRow: 12, kittyPops: 2 }]) {
    const s = restoreSeq(opts);
    assert.equal(at(s, DEL).length, 0, JSON.stringify(opts));
    assert.ok(!s.includes('\x1b_'), `还原序列里冒出了 APC：${JSON.stringify(opts)}`);
  }
});

test('片段顺序：同步输出最先、撤备用屏在定位之前、亮光标最后', () => {
  const s = restoreSeq({ deleteImage: true, homeRow: 30, kittyPops: 1 });
  assert.ok(s.startsWith('\x1b[?2026l'), '死在一帧中间时 DEC 2026 还开着，不先撤后面全看不见');
  const alt = s.indexOf(ALT_OFF);
  const home = s.indexOf('\x1b[30;1H');
  assert.ok(home > alt, '?1049l 自带一次光标恢复，放在定位之后会把光标又搬走');
  assert.ok(s.indexOf('\x1b[r') > alt, 'DECSTBM 每缓冲区各一份，撤滚动区要在切回来之后');
  assert.ok(s.endsWith('\x1b[?25h'), '亮光标必须最后 —— 中间的字节不该被用户看着一格格出现');
  assert.equal(at(s, '\x1b[<u').length, 1, 'push 了几层就弹几层');
});

test('doctor --reset 只删我们自己那个 id，绝不 d=a / d=A', () => {
  // `d=a` 是"删掉所有可见的图"、`d=A` 连数据一起。用户的终端里可能有别的程序的图
  // （imgcat、jupyter、另一个开着的 moyu），逃生出口把它们一起清掉是不可接受的。
  const s = doctorResetSeq();
  assert.equal(at(s, DEL).length, 2, 'doctor 也要两个缓冲区各删一次');
  assert.ok(s.includes(`i=${IMAGE_ID}`), '删除必须带 i=');
  assert.ok(!/a=d,d=[aA]/.test(s), `逃生出口里出现了整屏删图：${JSON.stringify(s)}`);
  assert.equal(at(s, '\x1b[<u').length, 8, 'doctor 不知道栈里有几层，多弹几次没有副作用');
  assert.ok(s.includes('\x1b[=0;1u'), 'CSI = … u 设过的标志只有硬复位收拾得了');
  assert.ok(!s.includes('\x1b[1;1H'), 'doctor 不知道屏幕上有什么，不该动光标、不该擦');
});

test('supervised teardown quiesces before supervisor restore commit and does not write locally', async () => {
  const calls: string[] = [];
  const lease: TerminalLease = {
    supervised: true,
    acquire: async () => {}, update: async () => {}, snapshot: async () => {},
    restoring: async (options: RestoreOptions) => { calls.push(`restore:${options.homeRow}`); },
    complete: async () => {}, onChannelLoss: () => () => {},
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-teardown-'));
  const output = path.join(dir, 'restore.bin');
  const fd = fs.openSync(output, 'w');
  try {
    const teardown = new Teardown(() => ({ homeRow: 12 }), fd, lease);
    teardown.onRestore(() => { calls.push('quiesce'); });
    teardown.run();
    await teardown.released();
    assert.deepEqual(calls, ['quiesce', 'restore:12']);
    assert.equal(fs.readFileSync(output).length, 0);
  } finally {
    fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct teardown keeps synchronous canonical restore behavior', async () => {
  const lease: TerminalLease = {
    supervised: false,
    acquire: async () => {}, update: async () => {}, snapshot: async () => {},
    restoring: async () => {}, complete: async () => {}, onChannelLoss: () => () => {},
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-teardown-'));
  const output = path.join(dir, 'restore.bin');
  const fd = fs.openSync(output, 'w');
  try {
    const teardown = new Teardown(() => ({ homeRow: 7 }), fd, lease);
    teardown.run();
    assert.equal(fs.readFileSync(output, 'utf8'), restoreSeq({ homeRow: 7 }),
      'run() 返回之前必须已经同步写完，exit 钩子不会等 Promise continuation');
    await teardown.released();
    assert.equal(fs.readFileSync(output, 'utf8'), restoreSeq({ homeRow: 7 }),
      '等待 lease 完成不能再写第二遍');
  } finally {
    fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher 不手写还原字节，supervisor 复用 teardown 的唯一实现', () => {
  const launcher = readFileSync(new URL('../../bin/moyu', import.meta.url), 'utf8');
  assert.ok(!launcher.includes('a=d,d=I'), 'launcher 不应复制 Kitty 删图协议');
  assert.ok(!launcher.includes('?1049l'), 'launcher 不应复制备用屏还原协议');
  assert.ok(!launcher.includes('MOYU_TAKEOVER_FLAG'), 'launcher 不应再持有文件标记恢复权限');

  const supervisor = readFileSync(new URL('../../src/app/supervisor.ts', import.meta.url), 'utf8');
  assert.match(supervisor, /import \{ restoreSeq, writeAllSync,/,
    'supervisor 必须复用 teardown 的标准还原序列与同步写实现');
  assert.ok(!supervisor.includes('a=d,d=I'), 'supervisor 不应另抄一份 Kitty 协议字节');
  assert.ok(!supervisor.includes('?1049l'), 'supervisor 不应另抄一份备用屏还原字节');
});
