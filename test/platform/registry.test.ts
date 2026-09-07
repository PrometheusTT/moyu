import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadGameModules, validateManifest } from '../../src/platform/registry.ts';

function manifest(id = 'tiny-test') {
  return {
    id, name: 'Tiny Test', version: '1.0.0', apiVersion: 1, author: 'test',
    description: 'test cartridge', entry: 'index.mjs', viewport: { width: 32, height: 24 },
    palette: ['#000000', '#ffffff'], controls: [],
  };
}

test('manifest validation pins the API and blocks path escape', () => {
  assert.equal(validateManifest(manifest()).id, 'tiny-test');
  assert.throws(() => validateManifest({ ...manifest(), apiVersion: 2 }), /apiVersion 1/);
  assert.throws(() => validateManifest({ ...manifest(), entry: '../outside.mjs' }), /相对路径/);
  assert.throws(() => validateManifest({ ...manifest(), palette: ['red'] }), /palette/);
  assert.equal(validateManifest({ ...manifest(), microViewport: { width: 80, height: 8 } }).microViewport?.height, 8);
  assert.throws(() => validateManifest({ ...manifest(), microViewport: { width: 80, height: 2 } }), /microViewport/);
});

test('local trusted cartridge joins built-ins without shadowing them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-registry-'));
  const previous = process.env.MOYU_HOME;
  process.env.MOYU_HOME = home;
  try {
    const dir = path.join(home, 'games', 'tiny-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'moyu.game.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(dir, 'index.mjs'), `export default { create() { return { update() {}, render(c) { c.clear(0); } }; } };\n`);
    const modules = await loadGameModules();
    assert.deepEqual(modules.slice(0, 3).map((m) => m.manifest.id), ['stick-slash', 'snake', 'blocks']);
    assert.equal(modules.filter((m) => m.manifest.id === 'tiny-test').length, 1);

    const duplicate = path.join(home, 'games', 'snake');
    fs.mkdirSync(duplicate, { recursive: true });
    fs.writeFileSync(path.join(duplicate, 'moyu.game.json'), JSON.stringify(manifest('snake')));
    fs.writeFileSync(path.join(duplicate, 'index.mjs'), `export default { create() { throw new Error('must not load'); } };\n`);
    assert.equal((await loadGameModules()).filter((m) => m.manifest.id === 'snake').length, 1);
  } finally {
    if (previous === undefined) delete process.env.MOYU_HOME; else process.env.MOYU_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
