import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPty } from '../../src/shell/pty.ts';
import { playGeometry, preparePlay } from '../../src/platform/play.ts';
import type { GameInstance, GameModule } from '../../src/platform/types.ts';

function module(id: string, create: () => GameInstance): GameModule {
  return {
    manifest: {
      id, name: id, version: '1', apiVersion: 1, author: 'test', description: id, entry: 'builtin',
      viewport: { width: 16, height: 8 }, palette: ['#000000', '#ffffff'], controls: [],
    },
    create,
  };
}

const healthy = (id: string): GameModule => module(id, () => ({ update() {}, render() {} }));

test('play geometry distinguishes unknown dimensions from a genuinely tiny terminal', () => {
  assert.deepEqual(playGeometry(0, 0, true), { cols: 80, rows: 6, targetCols: 51, usable: true });
  assert.deepEqual(playGeometry(undefined, undefined, false),
    { cols: 80, rows: 2, targetCols: 51, usable: true });
  assert.deepEqual(playGeometry(1, 1, true), { cols: 1, rows: 1, targetCols: 1, usable: false });
  assert.deepEqual(playGeometry(12, 3, false), { cols: 12, rows: 1, targetCols: 6, usable: true });
});

test('preparePlay distinguishes unknown IDs from known factory failures', () => {
  let creates = 0;
  const bad = module('bad', () => { creates++; throw new Error('boom\nwith control\x1b'); });
  assert.deepEqual(preparePlay([bad], 'missing'), { error: '找不到游戏 missing' });
  assert.equal(creates, 0, 'unknown IDs must fail without running factories');
  const failed = preparePlay([bad], 'bad');
  assert.equal(creates, 1);
  assert.match(failed.error ?? '', /^游戏 bad 启动失败：boom with control$/);
});

test('preparePlay flattens C0, DEL, and C1 controls', () => {
  const bad = module('bad', () => { throw new Error('boom\nwithC1control\x7f\x1b'); });
  assert.equal(preparePlay([bad], 'bad').error, '游戏 bad 启动失败：boom with C1 control');
});

test('preparePlay safely normalizes malformed Error messages', () => {
  const numeric = module('numeric', () => {
    const error = new Error('unused');
    Object.defineProperty(error, 'message', { value: 42 });
    throw error;
  });
  assert.equal(preparePlay([numeric], 'numeric').error, '游戏 numeric 启动失败：42');

  const hostile = module('hostile', () => {
    const error = new Error('unused');
    Object.defineProperty(error, 'message', { value: { toString() { throw new Error('no string'); } } });
    throw error;
  });
  assert.equal(preparePlay([hostile], 'hostile').error, '游戏 hostile 启动失败：未知错误');
});

test('preparePlay rejects invalid known instances and zero survivors', () => {
  const invalid = module('invalid', () => ({ update() {} }) as unknown as GameInstance);
  assert.match(preparePlay([invalid], 'invalid').error ?? '', /启动失败.*缺少 render/);
  assert.match(preparePlay([]).error ?? '', /没有可用游戏/);
});

test('a requested healthy game starts despite an unrelated broken cartridge', () => {
  const prepared = preparePlay([
    module('bad', () => { throw new Error('nope'); }),
    healthy('good'),
  ], 'good');
  assert.ok(prepared.arcade);
  assert.match(prepared.arcade.hud().left, /good/);
});

test('moyu play persists the active cartridge before one-key exit', { timeout: 12000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-play-'));
  const root = new URL('../../', import.meta.url).pathname;
  const { spawn } = await loadPty();
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('MOYU_') || key.startsWith('SSH_')
      || ['NODE_OPTIONS', 'TMUX', 'STY', 'COLUMNS', 'LINES'].includes(key)) delete clean[key];
  }
  const child = spawn(path.join(root, 'bin', 'moyu'), ['play', 'snake'], {
    cols: 100, rows: 24, cwd: root, encoding: null, handleFlowControl: false,
    env: { ...clean, HOME: home, TMPDIR: home, TERM: 'xterm-256color',
      MOYU_HOME: home, MOYU_EVENTS: path.join(home, 'events.log'), MOYU_DIST: '', MOYU_TIER: 'braille',
      MOYU_REDUCE_MOTION: '1', SSH_CONNECTION: '', TMUX: '', STY: '' },
  });
  let wire = ''; let exit: { exitCode: number } | null = null;
  const decoder = new TextDecoder();
  child.onData(bytes => { wire += decoder.decode(Buffer.from(bytes), { stream: true }); });
  const exited = new Promise<{ exitCode: number }>(resolve => {
    child.onExit(value => { exit = value; resolve(value); });
  });
  const waitFor = async (predicate: () => boolean, label: string, timeout = 8000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (exit !== null) assert.fail(`${label} 前已退出：${exit.exitCode}`);
      if (Date.now() >= deadline) assert.fail(`超时等不到 ${label}：${JSON.stringify(wire.slice(-240))}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await waitFor(() => wire.includes('贪吃蛇'), '贪吃蛇帮助');
    child.write('d');
    await waitFor(() => wire.includes('最高 1'), '非默认战绩');
    child.write('\x1d');
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('退出超时')), 3000)),
    ]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'state', 'snake.json'), 'utf8')), { best: 1 });
    assert.equal(fs.statSync(path.join(home, 'state', 'snake.json')).mode & 0o777, 0o600);
  } finally {
    if (exit === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
