import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePlay } from '../../src/platform/play.ts';
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
