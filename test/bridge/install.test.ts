/**
 * 装到别人机器上这件事只有一次机会 —— 装坏了对方的 settings.json，这个游戏就再也不会被打开。
 * 所以这一组测试盯的不是"装完能不能玩"，而是四条**不能破**的性质：
 *
 *   1. 只加不动别人的东西（合并，不是覆盖）；
 *   2. 装两遍等于装一遍（幂等，靠 `# moyu-signal:` 归属标记）；
 *   3. 卸载能把文件还原成一个字节都不差；
 *   4. 看不懂的文件宁可不动（带注释的 JSON、顶层不是对象 —— 报错并指向 `--print`）。
 *
 * 另外锁死 Codex 那边的信封形状：`hooks.json` 顶层是 `deny_unknown_fields`，
 * 多一个键 Codex 会**整个文件拒绝加载**，而那是静默的 —— 只有测试能替我们发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MARK, TARGET_NAME, apply, configPath, detected, eventSignals, homeVar,
  hookSnippet, hooksFor, plan, signalCommand, status, type Target,
} from '../../src/bridge/install.ts';

/** Codex `HookEventsToml` 认的 12 个事件名（照 codex-rs/config/src/hook_config.rs）。 */
const CODEX_EVENTS = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart',
  'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]);

function box(): { home: string; cfg: (t: Target) => string; events: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-inst-'));
  return {
    home,
    cfg: (t) => path.join(home, t === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'),
    events: path.join(home, '.moyu/events.log'),
  };
}

function write(p: string, text: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function run(t: Target, b: ReturnType<typeof box>, uninstall = false): string | null {
  const p = plan(t, { config: b.cfg(t), file: b.events, home: b.home, uninstall });
  assert.notEqual(p.action, 'error', p.error ?? '');
  apply(p);
  return p.after;
}

function read(p: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, any>;
}

test('Codex 的 hooks.json 顶层只能有 description / hooks —— 多一个键它会整份拒绝加载', () => {
  const b = box();
  run('codex', b);
  const root = read(b.cfg('codex'));
  assert.deepEqual(Object.keys(root).sort(), ['description', 'hooks']);
  for (const event of Object.keys(root.hooks)) {
    assert.ok(CODEX_EVENTS.has(event), `${event} 不在 Codex 认的 12 个事件里，整个文件会被拒`);
    for (const group of root.hooks[event]) {
      assert.deepEqual(Object.keys(group), ['hooks'], 'matcher 这类键漏出来了');
      for (const h of group.hooks) {
        assert.deepEqual(Object.keys(h).sort(), ['async', 'command', 'timeout', 'type']);
        assert.equal(h.type, 'command');
        assert.equal(h.async, false, 'start/done 必须有序；异步 hook 在短任务上会倒序');
        assert.ok(h.timeout > 0);
      }
    }
  }
});

test('两边装的事件不一样：Codex 没有 Notification，所以只有 start/done', () => {
  assert.deepEqual(eventSignals('claude').map(([, k]) => k), ['start', 'done', 'notify']);
  assert.deepEqual(eventSignals('codex').map(([, k]) => k), ['start', 'done']);
  // PermissionRequest 是**决策**事件（回复决定放不放行），挂个只会追加写的 hook 上去
  // 是拿正确性换一条横幅。宁可 Codex 那边少一个"需要确认"的提示。
  assert.ok(!Object.keys(hooksFor('codex')).includes('PermissionRequest'));
});

test('合并而不是覆盖：别人的 hook 和别的配置都要活着', () => {
  const b = box();
  write(b.cfg('claude'), JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo 别人的' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo 别人也挂了 Stop' }] }],
    },
  }, null, 2));
  run('claude', b);
  const root = read(b.cfg('claude'));
  assert.deepEqual(root.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(root.hooks.PreToolUse[0].hooks[0].command, 'echo 别人的');
  assert.equal(root.hooks.Stop[0].hooks[0].command, 'echo 别人也挂了 Stop', '把别人的 Stop 顶掉了');
  assert.equal(root.hooks.Stop.length, 2, '我们的 Stop 该是**新加一组**');
  assert.ok(String(root.hooks.Stop[1].hooks[0].command).includes(MARK));
});

test('装两遍等于装一遍', () => {
  const b = box();
  run('claude', b);
  const once = fs.readFileSync(b.cfg('claude'), 'utf8');
  const again = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  assert.equal(again.action, 'unchanged');
  apply(again);
  assert.equal(fs.readFileSync(b.cfg('claude'), 'utf8'), once, '重复安装长出了第二份');
});

test('事件文件换了路径 → 原地改，不是再挂一条', () => {
  const b = box();
  run('claude', b);
  const moved = path.join(b.home, 'elsewhere/events.log');
  const p = plan('claude', { config: b.cfg('claude'), file: moved, home: b.home });
  assert.equal(p.action, 'update');
  assert.equal(p.removed, 3, '旧的三条没被摘掉');
  apply(p);
  const root = read(b.cfg('claude'));
  assert.equal(root.hooks.Stop.length, 1);
  assert.ok(String(root.hooks.Stop[0].hooks[0].command).includes('elsewhere/events.log'));
});

test('卸载能还原成一个字节都不差', () => {
  const b = box();
  const original = JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo 别人的' }] }] },
  }, null, 2) + '\n';
  write(b.cfg('claude'), original);
  run('claude', b);
  assert.notEqual(fs.readFileSync(b.cfg('claude'), 'utf8'), original);
  run('claude', b, true);
  assert.equal(fs.readFileSync(b.cfg('claude'), 'utf8'), original, '卸载没还原干净');
});

test('卸载时只删我们自己造的 hooks.json，绝不删 settings.json', () => {
  const b = box();
  run('codex', b);
  run('claude', b);
  const p = plan('codex', { config: b.cfg('codex'), file: b.events, home: b.home, uninstall: true });
  assert.equal(p.action, 'remove');
  apply(p);
  assert.equal(fs.existsSync(b.cfg('codex')), false, '空掉的 hooks.json 该删掉');

  const q = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home, uninstall: true });
  assert.equal(q.action, 'update', 'settings.json 是共享文件，永远只能改不能删');
  apply(q);
  assert.ok(fs.existsSync(b.cfg('claude')));
});

test('Codex 文件里有用户自己的 description 时，卸载只摘 hook、不删文件', () => {
  const b = box();
  write(b.cfg('codex'), JSON.stringify({ description: '我的 hook 配置' }, null, 2) + '\n');
  run('codex', b);
  const p = plan('codex', { config: b.cfg('codex'), file: b.events, home: b.home, uninstall: true });
  assert.equal(p.action, 'update');
  apply(p);
  assert.deepEqual(read(b.cfg('codex')), { description: '我的 hook 配置' });
});

test('本来就没装过，卸载是空操作（别留下一个空文件）', () => {
  const b = box();
  const p = plan('codex', { config: b.cfg('codex'), file: b.events, home: b.home, uninstall: true });
  assert.equal(p.action, 'unchanged');
  apply(p);
  assert.equal(fs.existsSync(b.cfg('codex')), false);
});

test('看不懂的文件一个字节都不动，并且告诉人手动怎么弄', () => {
  const b = box();
  const junk = '{\n  // JSONC 注释，JSON.parse 会炸\n  "hooks": {}\n}\n';
  write(b.cfg('claude'), junk);
  const p = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  assert.equal(p.action, 'error');
  assert.match(p.error ?? '', /--print/);
  assert.equal(apply(p), null, 'error 的计划被写盘了');
  assert.equal(fs.readFileSync(b.cfg('claude'), 'utf8'), junk);
});

test('配置路径读失败不能当成文件不存在', () => {
  const b = box();
  fs.mkdirSync(b.cfg('codex'), { recursive: true });
  const p = plan('codex', { config: b.cfg('codex'), file: b.events, home: b.home });
  assert.equal(p.action, 'error');
  assert.match(p.error ?? '', /读不出/);
});

test('hooks 存在但不是对象 → 也是不动', () => {
  const b = box();
  write(b.cfg('claude'), '{"hooks": []}');
  assert.equal(plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home }).action, 'error');
});

test('写盘前先备份，备份内容等于原文', () => {
  const b = box();
  const original = '{\n  "hooks": {}\n}\n';
  write(b.cfg('claude'), original);
  const p = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  const backup = apply(p, new Date(Date.UTC(2026, 8, 5, 12, 34, 56)));
  assert.equal(backup, `${b.cfg('claude')}.moyu-bak-20260905123456000`);
  assert.equal(fs.readFileSync(backup ?? '', 'utf8'), original);
});

test('干跑之后配置被别人改过，apply 拒绝覆盖', () => {
  const b = box();
  write(b.cfg('claude'), '{"hooks": {}}\n');
  const p = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  write(b.cfg('claude'), '{"hooks": {}, "new": true}\n');
  assert.throws(() => apply(p), /被别的程序改过/);
  assert.equal(fs.readFileSync(b.cfg('claude'), 'utf8'), '{"hooks": {}, "new": true}\n');
});

test('原配置是软链时原子写入目标文件，不把软链替换掉', () => {
  const b = box();
  const actual = write(path.join(b.home, 'dotfiles/settings.json'), '{"hooks": {}}\n');
  fs.mkdirSync(path.dirname(b.cfg('claude')), { recursive: true });
  fs.symlinkSync(actual, b.cfg('claude'));
  const p = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  apply(p);
  assert.equal(fs.lstatSync(b.cfg('claude')).isSymbolicLink(), true);
  assert.match(fs.readFileSync(actual, 'utf8'), /moyu-signal/);
});

test('新建的文件不备份（没东西可备）', () => {
  const b = box();
  const p = plan('codex', { config: b.cfg('codex'), file: b.events, home: b.home });
  assert.equal(p.action, 'create');
  assert.equal(apply(p), null);
});

test('保住原文的缩进 —— 改完还得像用户自己的文件', () => {
  const b = box();
  write(b.cfg('claude'), '{\n    "hooks": {}\n}\n');
  const p = plan('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  assert.match(p.after ?? '', /\n    "hooks"/, '4 空格缩进被改成了 2');
});

test('命令行是 sh 能吞的，路径带空格也不会散架', () => {
  const cmd = signalCommand('done', '/tmp/a b/events.log', '/nobody');
  assert.ok(cmd.includes('/tmp/a b/events.log'), '路径丢了');
  assert.ok(cmd.includes('mkdir -p '), '目录不存在时第一条信号会丢');
  assert.ok(cmd.includes('>>'), '不是追加写');
  assert.ok(cmd.endsWith(`${MARK}done`), '归属标记必须在结尾 —— 幂等和卸载全靠它');
  assert.ok(!cmd.includes('node'), 'hook 里起 node 要付 ~40ms 启动成本');
});

test('hook 真实执行时展开 $HOME，也服从外壳传入的 MOYU_EVENTS', () => {
  const b = box();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-hook-cwd-'));
  const installed = path.join(b.home, '.moyu/events.log');
  const cmd = signalCommand('done', installed, b.home);
  execFileSync('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, HOME: b.home, MOYU_EVENTS: '' } });
  assert.match(fs.readFileSync(installed, 'utf8'), / done\n$/);
  assert.equal(fs.existsSync(path.join(cwd, '$HOME')), false, '把 $HOME 当字面目录写进了当前仓库');

  const isolated = path.join(b.home, 'sessions/one.log');
  execFileSync('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, HOME: b.home, MOYU_EVENTS: isolated } });
  assert.match(fs.readFileSync(isolated, 'utf8'), / done\n$/);

  const weird = path.join(b.home, 'a } "$` b/events.log');
  const weirdCmd = signalCommand('start', weird, b.home);
  execFileSync('/bin/sh', ['-c', weirdCmd], { cwd, env: { ...process.env, HOME: b.home, MOYU_EVENTS: '' } });
  assert.match(fs.readFileSync(weird, 'utf8'), / start\n$/);
});

test('家目录换成 $HOME —— 这段会进截图，也要能跨机器复制', () => {
  const home = '/Users/somebody';
  assert.equal(homeVar(`${home}/.moyu/events.log`, home), '$HOME/.moyu/events.log');
  assert.equal(homeVar('/tmp/x', home), '/tmp/x');
  const snip = hookSnippet(`${home}/.moyu/events.log`, 'codex', home);
  assert.ok(!snip.includes(home), '真实家目录漏进了要贴出去的文本');
  assert.match(snip, /Trust all and continue/, 'Codex 的信任那一步不说就等于没装');
});

test('默认路径就是两个 CLI 真的会读的那两个', () => {
  const home = '/Users/somebody';
  assert.equal(configPath('claude', home), `${home}/.claude/settings.json`);
  assert.equal(configPath('codex', home), `${home}/.codex/hooks.json`);
});

test('status 认得出装没装、以及装的是不是过期的路径', () => {
  const b = box();
  assert.deepEqual(status('claude', { config: b.cfg('claude'), file: b.events, home: b.home }).events, []);
  run('claude', b);
  const now = status('claude', { config: b.cfg('claude'), file: b.events, home: b.home });
  assert.deepEqual(now.events, ['UserPromptSubmit', 'Stop', 'Notification']);
  assert.equal(now.stale, false);
  const other = status('claude', { config: b.cfg('claude'), file: '/tmp/somewhere-else.log', home: b.home });
  assert.equal(other.stale, true, '命令里写的还是旧路径，游戏读的是新的 —— 得能看出来');
  write(b.cfg('codex'), '{oops');
  assert.ok(status('codex', { config: b.cfg('codex'), file: b.events, home: b.home }).broken !== null);
});

test('detected 只认目录/可执行文件，不凭猜', () => {
  const b = box();
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(b.home, 'bin');   // 真机上 claude 就在 PATH 上，得先隔离掉
  try {
    assert.equal(detected('claude', b.home), false);
    fs.mkdirSync(path.join(b.home, '.claude'), { recursive: true });
    assert.equal(detected('claude', b.home), true, '~/.claude 在就算装了');

    assert.equal(detected('codex', b.home), false);
    const bin = path.join(b.home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
    assert.equal(detected('codex', b.home), true, 'PATH 上有可执行文件也算 —— 全新装的 codex 还没有 ~/.codex');
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  }
});

test('名字是给人看的（错误信息里会出现）', () => {
  assert.deepEqual(TARGET_NAME, { claude: 'Claude Code', codex: 'Codex' });
});
