import { loadPty } from '../src/shell/pty.ts';
import { VtCursor } from '../src/shell/vtcursor.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-codex-smoke-'));
const { spawn } = await loadPty();
const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
  new URL('../src/app/main.ts', import.meta.url).pathname, '--', 'codex'],
  { cols: 100, rows: 40, cwd: new URL('../', import.meta.url).pathname, encoding: null,
    env: { ...process.env, TERM: 'xterm-256color', MOYU_TIER: 'braille', MOYU_HOME: temp, MOYU_TAKEOVER_FLAG: '' } });
const vt = new VtCursor({ cols: 100, rows: 40 });
let wire = '', exited = false;
child.onData(bytes => {
  const text = Buffer.from(bytes).toString('utf8');
  vt.feed(Buffer.from(bytes));
  wire += text;
  if (text.includes('\x1b[6n')) child.write('\x1b[' + vt.row + ';' + vt.col + 'R');
  if (text.includes('\x1b[c') || text.includes('\x1b[0c')) child.write('\x1b[?1;2c');
  if (text.includes('\x1b[?u')) child.write('\x1b[?0u');
  if (text.includes(']10;?')) child.write('\x1b]10;rgb:eeee/eeee/eeee\x1b\\');
  if (text.includes(']11;?')) child.write('\x1b]11;rgb:1616/1919/2323\x1b\\');
});
const exit = new Promise(resolve => child.onExit(() => { exited = true; resolve(); }));
async function wait(test, stage, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!test(wire)) {
    if (exited || Date.now() > deadline) throw new Error(stage + ' did not complete; startup screen requires manual inspection');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const results = {};
try {
  await wait(w => w.includes('Ctrl+] 开玩'), 'standby'); results.standby = true;
  await wait(w => w.includes('›'), 'Codex composer'); results.composer = true;
  let mark = wire.length;
  child.write('\x1d');
  await wait(w => w.slice(mark).includes('J 砍') && w.slice(mark).includes('Esc 返回'), 'help'); results.help = true;
  mark = wire.length; child.write('j');
  await wait(w => /[\u2800-\u28ff]/.test(w.slice(mark)), 'game frame'); results.play = true;
  mark = wire.length; child.write('e');
  await wait(w => w.slice(mark).includes('\x1b[1;34r'), 'expanded layout'); results.expanded = true;
  mark = wire.length; child.write('\x1b');
  await wait(w => w.slice(mark).includes('Ctrl+] 开玩') && w.slice(mark).includes('›'), 'composer restored');
  results.returned = true;
} catch (error) {
  results.blocked = error.message;
  // Preserve diagnostics locally; never print a user's Codex startup contents into CI output.
  fs.writeFileSync(path.join(temp, 'startup.ansi'), wire);
  results.diagnostics = path.join(temp, 'startup.ansi');
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1500))]);
  if (!exited) { child.kill('SIGKILL'); await exit; }
  console.log(JSON.stringify(results, null, 2));
  if (!results.blocked) fs.rmSync(temp, { recursive: true, force: true });
  process.exitCode = results.blocked ? 1 : 0;
}
