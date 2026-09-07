import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPty } from '../../src/shell/pty.ts';

async function launch(graphics: boolean) {
  const { spawn } = await loadPty();
  const p = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    new URL('../../src/app/main.ts', import.meta.url).pathname, 'doctor', '--visual'], {
    cols: 100, rows: 24, cwd: new URL('../../', import.meta.url).pathname, encoding: null,
    env: { ...process.env, TERM: 'xterm-256color', MOYU_TIER: graphics ? 'graphics' : 'braille',
      MOYU_FORCE_GRAPHICS: '0', MOYU_TAKEOVER_FLAG: '', SSH_CONNECTION: '', TMUX: '', STY: '', MOYU_THEME: 'dark' },
  });
  let wire = '', answered = false, status: number | undefined;
  const decoder = new TextDecoder();
  p.onData(bytes => {
    wire += decoder.decode(Buffer.from(bytes), { stream: true });
    if (graphics && !answered && wire.includes('\x1b[c')) {
      answered = true; p.write('\x1b_Gi=31;OK\x1b\\\x1b[6;34;16t\x1b[?1;2c');
    }
  });
  p.onExit(e => { status = e.exitCode; });
  const wait = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `sample timeout, status=${status}: ${JSON.stringify(wire.slice(-160))}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  return { p, wait, wire: () => wire, status: () => status };
}

test('native pixel diagnostic negotiates, pauses, changes view, and clears its image on exit', { timeout: 12000 }, async () => {
  const s = await launch(true);
  try {
    await s.wait(() => s.wire().includes('a=T') && s.wire().includes('新版原生像素'));
    assert.ok(s.wire().includes('s=640,v=68'));
    s.p.write(' '); await s.wait(() => s.wire().includes('· 暂停'));
    const mark = s.wire().length;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(!s.wire().slice(mark).includes('a=T'), 'paused sample must not keep sending frames');
    s.p.write('\t'); await s.wait(() => s.wire().includes('旧版低分辨率中转'));
    s.p.write('e'); await s.wait(() => s.wire().includes('s=640,v=204'));
    s.p.write('l'); await s.wait(() => s.wire().includes('light'));
    const beforeExit = s.wire().length;
    s.p.write('\x1b'); await s.wait(() => s.status() !== undefined);
    assert.equal(s.status(), 0);
    assert.ok(s.wire().slice(beforeExit).includes('a=d,d=I,i=19801'));
    assert.ok(s.wire().slice(beforeExit).includes('\x1b[?1049l'));
    assert.ok(s.wire().slice(beforeExit).includes('\x1b[?25h'));
  } finally { if (s.status() === undefined) s.p.kill('SIGKILL'); }
});

test('unsupported native sample reports its requirement without sending an image', { timeout: 10000 }, async () => {
  const s = await launch(false);
  try {
    await s.wait(() => s.status() !== undefined);
    assert.equal(s.status(), 2);
    assert.match(s.wire(), /需要 Kitty Graphics/);
    assert.ok(!s.wire().includes('a=T'));
    assert.ok(!s.wire().includes('\x1b[?1049h'));
  } finally { if (s.status() === undefined) s.p.kill('SIGKILL'); }
});
