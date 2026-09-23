import { probeCaps } from '../render/caps.ts';
import { GraphicsTarget } from '../render/graphics.ts';
import { fitRow } from '../render/text.ts';
import { Teardown } from '../shell/teardown.ts';
import { PixelSample } from './pixel-sample.ts';
import { isEnglish } from '../i18n.ts';

/** Diagnostic only: same simulation, switch between old and native pixel rendering with Tab. */
export async function cmdPixelDemo(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(isEnglish() ? 'moyu doctor --visual needs an interactive terminal\n' : 'moyu doctor --visual 需要真终端\n'); return 2;
  }
  if ((process.stdout.columns ?? 0) < 42 || (process.stdout.rows ?? 0) < 12) {
    process.stderr.write(isEnglish() ? 'The pixel comparison needs at least 42 columns and 12 rows; the default image remains 40×2 cells.\n'
      : '像素对比需要至少 42 列、12 行，画面默认仍为 40×2 字符格。\n'); return 2;
  }
  const wasRaw = process.stdin.isRaw;
  let graphicsStarted = false;
  const teardown = new Teardown(() => ({ deleteImage: graphicsStarted }));
  teardown.onRestore(() => {
    try { process.stdin.setRawMode(wasRaw); } catch { /* terminal gone */ }
    process.stdin.pause();
  });
  teardown.install();
  await teardown.acquire({ deleteImage: false });
  process.stdin.setRawMode(true); process.stdin.resume();
  let caps;
  try {
    caps = await probeCaps({ stdin: process.stdin, write: s => { process.stdout.write(s); }, env: process.env,
      cols: process.stdout.columns, rows: process.stdout.rows, tty: true });
  } finally { process.stdin.setRawMode(wasRaw); process.stdin.pause(); }
  if (caps.tier !== 'graphics') {
    process.stderr.write(isEnglish()
      ? `This comparison needs Kitty Graphics, but the selected tier is ${caps.tier} (${caps.probe}).\nRun it in a Kitty Graphics terminal. This command will not force an unsupported image.\n`
      : `本轮样片需要 Kitty Graphics，未启用：${caps.why}\n`
        + '请在支持 Kitty Graphics 的终端运行，或查看导出的浏览器像素预览。此命令不会强制发送不支持的图片。\n');
    teardown.run();
    try { await teardown.released(); } catch { /* 本地已经恢复 */ }
    return 2;
  }
  // An exit pressed during capability negotiation must not be lost.
  if (caps.leftover.includes(3) || caps.leftover.includes(27) || caps.leftover.includes(113)) {
    teardown.run();
    try { await teardown.released(); } catch { /* 本地已经恢复 */ }
    return 0;
  }
  const sample = new PixelSample(), target = new GraphicsTarget(40, 2, caps.cellW, caps.cellH);
  let paused = false, legacy = false, expanded = false, theme: 'dark' | 'light' = process.env.MOYU_THEME === 'light' ? 'light' : 'dark';
  let timer: NodeJS.Timeout | undefined, done = false, blocked = false, dirty = true;
  let last = performance.now(), accumulator = 0;
  await teardown.update({ deleteImage: true });
  return new Promise<number>(resolve => {
    const finish = (): void => {
      if (done) return; done = true;
      teardown.run();
      void teardown.released().catch(() => {}).finally(() => { resolve(0); });
    };
    const onData = (bytes: Buffer): void => {
      if (bytes.includes(3) || bytes.includes(27) || bytes.includes(113)) { finish(); return; }
      for (const byte of bytes) {
        if (byte === 9) legacy = !legacy;
        if (byte === 32) paused = !paused;
        if (byte === 114) sample.reset();
        if (byte === 108) theme = theme === 'dark' ? 'light' : 'dark';
        if (byte === 101) { expanded = !expanded; target.resize(40, expanded ? 6 : 2); }
      }
      dirty = true; accumulator = 0; last = performance.now();
    };
    const onResize = (): void => {
      if (process.stdout.columns < 42 || process.stdout.rows < 12) { finish(); return; }
      dirty = true; target.invalidate();
    };
    const onDrain = (): void => { blocked = false; };
    teardown.onRestore(() => {
      if (timer !== undefined) clearInterval(timer);
      process.stdin.off('data', onData); process.stdout.off('resize', onResize); process.stdout.off('drain', onDrain);
      try { process.stdin.setRawMode(wasRaw); } catch { /* terminal gone */ }
      process.stdin.pause();
    });
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('data', onData); process.stdout.on('resize', onResize); process.stdout.on('drain', onDrain);
    graphicsStarted = true;
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?7l\x1b[?25l');
    const draw = (): void => {
      if (done) return;
      const now = performance.now(), elapsed = Math.min(0.25, (now - last) / 1000); last = now;
      if (!paused) {
        accumulator += elapsed;
        while (accumulator >= 1 / 60) { sample.step(); accumulator -= 1 / 60; }
      }
      if (blocked || (paused && !dirty)) return;
      let out = '';
      if (dirty) {
        const english = isEnglish();
        const renderLabel = legacy ? english ? 'old low-resolution pass' : '旧版低分辨率中转'
          : english ? 'native pixels' : '新版原生像素';
        const playbackLabel = paused ? english ? 'paused' : '暂停' : english ? 'playing' : '播放';
        out += target.disposeSeq() + '\x1b[2J'; target.invalidate();
        out += '\x1b[1;1H' + fitRow(`Moyu · ${renderLabel} · ${playbackLabel}`, '', process.stdout.columns - 1);
        out += '\x1b[2;1H' + fitRow(`${target.pixelW}×${target.pixelH} px · ${target.rows} ${english ? 'rows' : '行'} · ${theme} · ${caps.fps}fps`, '', process.stdout.columns - 1);
        out += `\x1b[${target.rows + 4};1H` + fitRow(english ? 'Tab old/new · Space pause · r replay' : 'Tab 新旧 · 空格 暂停 · r 重播', '', process.stdout.columns - 1);
        out += `\x1b[${target.rows + 5};1H` + fitRow(english ? 'e two/six rows · l dark/light · Esc exit' : 'e 两/六行 · l 深浅 · Esc 退出', '', process.stdout.columns - 1);
      }
      sample.render(target, legacy, theme, paused ? 1 : accumulator * 60);
      out += target.encode(3); dirty = false;
      if (out) blocked = !process.stdout.write(out);
    };
    draw(); timer = setInterval(draw, 1000 / caps.fps);
  });
}
