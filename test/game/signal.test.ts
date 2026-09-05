import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendSignal, SignalTail, eventsPath } from '../../src/bridge/signal.ts';
import { hookSnippet } from '../../src/bridge/install.ts';

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-sig-'));
  return path.join(d, 'events.log');
}

test('开局跳到文件末尾 —— 否则每次开游戏都会把历史事件重放一遍', () => {
  const f = tmp();
  appendSignal('done', f);
  appendSignal('done', f);
  const t = new SignalTail(f);
  assert.deepEqual(t.poll(), [], '历史事件被重放了，开局就是一串清屏技');
  appendSignal('start', f);
  assert.deepEqual(t.poll(), ['start']);
});

test('文件还不存在也能等（hook 还没触发过是常态）', () => {
  const f = tmp();
  const t = new SignalTail(f);
  assert.deepEqual(t.poll(), []);
  appendSignal('done', f);
  assert.deepEqual(t.poll(), ['done']);
});

test('一次 poll 拿到期间攒下的全部事件，顺序不乱', () => {
  const f = tmp();
  const t = new SignalTail(f);
  appendSignal('start', f);
  appendSignal('notify', f);
  appendSignal('done', f);
  assert.deepEqual(t.poll(), ['start', 'notify', 'done']);
  assert.deepEqual(t.poll(), [], '读过的不该再来一遍');
});

test('写到一半的行留着等下半截（shell 的追加写不保证原子）', () => {
  const f = tmp();
  const t = new SignalTail(f);
  fs.appendFileSync(f, '1700000000 do');
  assert.deepEqual(t.poll(), [], '半行不该被当成事件');
  fs.appendFileSync(f, 'ne\n');
  assert.deepEqual(t.poll(), ['done']);
});

test('文件被清空/轮转之后从头读，不卡死也不读到半行乱码', () => {
  const f = tmp();
  const t = new SignalTail(f);
  appendSignal('done', f);
  assert.deepEqual(t.poll(), ['done']);
  fs.writeFileSync(f, '');
  assert.deepEqual(t.poll(), []);
  appendSignal('start', f);
  assert.deepEqual(t.poll(), ['start'], '轮转之后就再也读不到新事件了');
});

test('看不懂的行直接跳过（别人往同一个文件里写了东西也不该崩）', () => {
  const f = tmp();
  const t = new SignalTail(f);
  fs.appendFileSync(f, '\n乱码\n1700000000 done\nhello world\n  1700000001   start  \n');
  assert.deepEqual(t.poll(), ['done', 'start'], '只认最后一个字段是已知类型的行');
});

test('MOYU_EVENTS 能改事件文件位置（测试和多实例都要靠它）', () => {
  const old = process.env.MOYU_EVENTS;
  try {
    process.env.MOYU_EVENTS = '/tmp/moyu-x/ev.log';
    assert.equal(eventsPath(), '/tmp/moyu-x/ev.log');
    process.env.MOYU_EVENTS = '';
    assert.equal(eventsPath(), path.join(os.homedir(), '.moyu', 'events.log'), '空串该退回默认值');
  } finally {
    if (old === undefined) delete process.env.MOYU_EVENTS;
    else process.env.MOYU_EVENTS = old;
  }
});

test('moyu hook 打印的片段是合法 JSON，三个事件都在，而且全是 async', () => {
  const out = hookSnippet('/tmp/moyu-t/ev.log');
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  const cfg = JSON.parse(json) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; async: boolean; timeout: number }> }>>;
  };
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['Notification', 'Stop', 'UserPromptSubmit']);
  for (const [name, entries] of Object.entries(cfg.hooks)) {
    const h = entries[0]!.hooks[0]!;
    assert.equal(h.type, 'command', name);
    // async 是硬要求：这台机器上已经有插件注册了一堆 hook，同步 hook 会拖慢每次工具调用。
    assert.equal(h.async, true, `${name} 不是 async —— 会阻塞工具调用`);
    assert.ok(h.timeout > 0, name);
    assert.ok(h.command.includes('>>'), `${name} 该是追加写`);
    assert.ok(!h.command.includes('node'), `${name} 里起了 node —— 每次工具调用付 40ms 启动成本`);
  }
  assert.match(cfg.hooks.Stop![0]!.hooks[0]!.command, /done/);
  assert.match(cfg.hooks.UserPromptSubmit![0]!.hooks[0]!.command, /start/);
  assert.match(cfg.hooks.Notification![0]!.hooks[0]!.command, /notify/);
});

test('hook 片段用 $HOME 而不是写死家目录（这段会被贴到别处/截图）', () => {
  const home = os.homedir();
  const out = hookSnippet(path.join(home, '.moyu', 'events.log'));
  assert.ok(out.includes('$HOME/.moyu/events.log'), out.slice(0, 200));
  assert.ok(!out.includes(home), '把绝对家目录写进去了');
});

test('hook 片段告诉用户不装也能玩（t / y 手动喂信号）', () => {
  const out = hookSnippet('/tmp/moyu-t/ev.log');
  assert.match(out, /按 t/);
  assert.match(out, /settings\.json/);
});
