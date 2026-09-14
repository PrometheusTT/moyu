import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPty } from '../dist/shell/pty.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { spawn } = await loadPty();
const requestedModes = process.argv.slice(2);
const modes = requestedModes.length > 0 ? requestedModes : ['source', 'dist'];
const validModes = new Set(['source', 'dist']);
for (const mode of modes) {
  if (!validModes.has(mode)) throw new Error(`unknown startup-smoke mode: ${mode}; expected source or dist`);
}

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
if (modes.includes('source') && (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 6))) {
  throw new Error(`source startup smoke requires Node >=22.6; current Node is ${process.versions.node}`);
}

const sourceFlags = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const entries = {
  source: [...sourceFlags, path.join(root, 'src', 'app', 'supervisor.ts'), path.join(root, 'src', 'app', 'main.ts')],
  dist: [path.join(root, 'dist', 'app', 'supervisor.js'), path.join(root, 'dist', 'app', 'main.js')],
};
const sizes = [
  { name: 'normal', cols: 100, rows: 40 },
  { name: 'zero', cols: 0, rows: 0 },
  { name: 'tiny', cols: 1, rows: 1 },
];
const results = [];
const ambientKeys = [
  'COLUMNS', 'LINES', 'TMUX', 'STY', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TERM_PROGRAM',
  'COLORTERM', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'NODE_OPTIONS',
];

function smokeEnv(home) {
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home,
    TMPDIR: home,
    MOYU_HOME: home,
    MOYU_EVENTS: path.join(home, 'events.log'),
    MOYU_TIER: 'braille',
    MOYU_REDUCE_MOTION: '1',
    TERM: 'xterm-256color',
  });
  for (const key of ambientKeys) delete env[key];
  return env;
}

async function run(mode, size) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-startup-'));
  const child = spawn(process.execPath, [...entries[mode], 'play', 'stick-slash'], {
    cols: size.cols,
    rows: size.rows,
    cwd: root,
    env: smokeEnv(home),
    encoding: null,
    handleFlowControl: false,
  });
  let wire = '';
  let exited = false;
  const decoder = new TextDecoder();
  child.onData(bytes => { wire += decoder.decode(Buffer.from(bytes), { stream: true }); });
  const exit = new Promise(resolve => child.onExit(value => { exited = true; resolve(value); }));
  const deadline = Date.now() + 3000;
  const started = () => size.cols > 1 ? wire.includes('火柴快斩') : wire.length > 0;
  while (!started() && !exited && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  try {
    assert.equal(exited, false, `${mode}/${size.name} exited during startup`);
    assert.ok(wire.length > 0, `${mode}/${size.name} did not render startup bytes`);
    if (size.cols > 1) assert.ok(wire.includes('火柴快斩'),
      `${mode}/${size.name} did not render the requested game`);
    assert.equal(wire.includes('RangeError'), false, `${mode}/${size.name} raised RangeError`);
    if (size.cols <= 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(exited, false, `${mode}/${size.name} exited after first paint`);
      assert.equal(wire.includes('RangeError'), false, `${mode}/${size.name} raised delayed RangeError`);
      if (size.name === 'tiny') {
        const rows = [...wire.matchAll(/\x1b\[(\d+);\d+H/g)].map(match => Number(match[1]));
        assert.deepEqual(rows.filter(row => row > size.rows), [],
          `${mode}/${size.name} addressed rows outside the physical terminal`);
        assert.ok(wire.includes('终端太小'), `${mode}/${size.name} did not enter the resize wait state`);
        assert.equal(wire.includes('火柴快斩'), false,
          `${mode}/${size.name} rendered an active game while too small`);
      }
    }
    child.write(Buffer.from([0x1d]));
    const result = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
    assert.ok(result, `${mode}/${size.name} did not exit after Ctrl+]`);
    assert.equal(result.exitCode, 0, `${mode}/${size.name} exited ${result.exitCode}`);
    results.push({ mode, size: size.name, bytes: Buffer.byteLength(wire), exitCode: result.exitCode });
  } finally {
    if (!exited) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const mode of modes) for (const size of sizes) await run(mode, size);
console.log(JSON.stringify(results, null, 2));
