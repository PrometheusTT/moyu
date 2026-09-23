import assert from 'node:assert/strict';
import { spawn } from '@lydell/node-pty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows smoke test must run on Windows');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-windows-smoke-'));
const entry = path.join(root, 'bin', 'moyu.mjs');

function run(args, marker, afterMarker) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.Path = `${home}${path.delimiter}${process.env.PATH ?? ''}`;
    env.MOYU_HOME = home;
    env.MOYU_EVENTS = path.join(home, 'events.log');
    env.MOYU_TIER = 'braille';
    const child = spawn(process.execPath, [entry, ...args], {
      cols: 90, rows: 24, cwd: root, encoding: null, handleFlowControl: false,
      env,
    });
    let output = '';
    let triggered = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`Timed out waiting for ${marker}: ${output.slice(-1500)}`));
    }, 20000);
    child.onData(data => {
      output += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      if (!triggered && output.includes(marker)) {
        triggered = true;
        afterMarker?.(child);
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        const diagnostic = `${output.slice(0, 1000)}\n[tail]\n${output.slice(-1000)}`;
        assert.equal(exitCode, 0, diagnostic);
        assert.ok(output.includes(marker), diagnostic);
        resolve(output);
      } catch (error) { reject(error); }
    });
  });
}

try {
  fs.writeFileSync(path.join(home, 'moyu-native-test.ps1'), "Write-Host 'MOYU_PS_OK'\nStart-Sleep -Seconds 1\n");
  const play = await run(['play', 'stick-slash'], '\x1b[?1049h', child => {
    setTimeout(() => child.write('\x1d'), 500);
  });
  assert.ok(play.includes('\x1b[?1049l'), 'standalone play must restore the terminal');
  const wrap = await run(['--', 'moyu-native-test'], 'MOYU_PS_OK');
  assert.ok(wrap.includes('MOYU_PS_OK'));
  process.stdout.write('Windows native play and PowerShell CLI wrapper passed.\n');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
