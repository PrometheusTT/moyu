// Run: node --experimental-strip-types scripts/visual-qa.mjs [output-directory]
// Produces actual ANSI frames, an interactive font/theme preview, and an SVG contact sheet.
// No runtime dependency is installed. The preview is a font rendering check, not terminal certification.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Arcade } from '../src/platform/arcade.ts';
import { BrailleTarget } from '../src/render/braille.ts';
import { PlaySurface } from '../src/platform/surface.ts';
import { stringWidth } from '../src/shell/wcwidth.ts';
const output = path.resolve(process.argv[2] ?? '/tmp/moyu-visual-qa');
fs.mkdirSync(output, { recursive: true });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-visual-state-'));
process.env.MOYU_HOME = stateDir;
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function screen(rows) {
  const cells = Array.from({ length: rows }, () => Array.from({ length: 80 }, () => ({ ch: ' ', fg: 'var(--ink)', bg: 'var(--bg)' })));
  let x = 0, y = 0, fg = 'var(--ink)', bg = 'var(--bg)';
  return {
    feed(raw) {
      const tokens = raw.match(/\x1b\[[0-9;]*[A-Za-z]|[^\x1b]/gu) ?? [];
      for (const token of tokens) {
        if (token.startsWith('\x1b[')) {
          const params = token.slice(2, -1).split(';').map(Number), final = token.at(-1);
          if (final === 'H') { y = (params[0] || 1) - 1; x = (params[1] || 1) - 1; }
          if (final === 'm') for (let i = 0; i < params.length; i++) {
            const p = params[i];
            if (p === 0) { fg = 'var(--ink)'; bg = 'var(--bg)'; }
            if (p === 39) fg = 'var(--ink)';
            if (p === 49) bg = 'var(--bg)';
            if ((p === 38 || p === 48) && params[i + 1] === 2) {
              const color = '#' + params.slice(i + 2, i + 5).map(n => n.toString(16).padStart(2, '0')).join('');
              if (p === 38) fg = color; else bg = color; i += 4;
            }
          }
          continue;
        }
        const width = stringWidth(token);
        if (cells[y]?.[x] && width > 0) cells[y][x] = { ch: token, fg, bg, width };
        if (width === 2 && cells[y]?.[x + 1]) cells[y][x + 1] = { ch: '', fg, bg, width: 0 };
        x += width;
      }
    },
    html() {
      return cells.map(row => '<div class="line">' + row.map(c => c.ch === '' ? '' :
        '<span style="color:' + c.fg + ';background:' + c.bg + ';width:' + (c.width ?? 1) + 'ch">' + escape(c.ch) + '</span>').join('') + '</div>').join('');
    },
    cells: () => structuredClone(cells),
  };
}
const samples = [];
try {
  for (const [id, rows] of [['stick-slash', 2], ['stick-slash', 6], ['snake', 6], ['blocks', 6]]) {
    const game = new Arcade(path.join(stateDir, 'events'), undefined, id);
    const target = new BrailleTarget(40, rows, { defaultBackground: true, defaultForeground: 0xecf0f8 });
    const surface = new PlaySurface(), terminal = screen(rows);
    const frames = [], raw = [], captures = [];
    game.setDisplay(rows, 'braille');
    let now = 1000;
    for (let f = 0; f < 64; f++) {
      if (f === 8) game.feed(Buffer.from(id === 'snake' ? 'd' : 'j'), now);
      if (id === 'stick-slash') {
        if (f >= 20 && f < 30) game.feed(Buffer.from('d'), now);
        if (f === 32) game.feed(Buffer.from(' '), now);
        if (f === 46) game.feed(Buffer.from('j'), now);
      }
      if (id === 'snake' && f === 24) game.feed(Buffer.from('w'), now);
      if (id === 'snake' && f === 36) game.feed(Buffer.from('a'), now);
      if (id === 'blocks' && f === 28) game.feed(Buffer.from(' '), now);
      if (id === 'blocks' && f === 38) game.feed(Buffer.from('j'), now);
      game.advance(now);
      const encoded = surface.render(game, target, 1, 80, rows);
      terminal.feed(encoded); frames.push(terminal.html()); raw.push(encoded);
      if ([8, 13, 26, 37, 52, 60].includes(f)) captures.push({ label: id + ' / ' + rows + ' rows / frame ' + f, cells: terminal.cells().map(r => r.slice(0, 40)) });
      now += 67;
    }
    samples.push({ id, rows, frames, raw, captures });
  }
  const data = JSON.stringify(samples.map(({ id, rows, frames }) => ({ id, rows, frames }))).replaceAll('<', '\\u003c');
  const html = '<!doctype html><meta charset="utf-8"><title>Moyu visual QA</title>' +
    '<style>:root{--bg:#161923;--ink:#edf0f6}body{margin:32px;background:var(--bg);color:var(--ink);font:16px system-ui}button,select{font:inherit;margin:4px;padding:6px}section{margin:24px 0}h2{font-size:16px;font-weight:500}.terminal{font:20px/28px "DejaVu Sans Mono",monospace;white-space:pre}.line{height:28px}.line span{display:inline-block}p{max-width:75ch;line-height:1.6}</style>' +
    '<h1>Moyu · terminal glyph preview</h1><p>真实 ANSI 输出的字符预览。首次提示保持到第一个操作；动画依次展示攻击、移动、跳跃。此页面验证字体呈现，不代表 Termius 或其他终端已通过实机测试。</p>' +
    '<button id="pause">暂停</button><button id="restart">重新进入</button><button id="theme">深浅主题</button><label>字体 <select id="font"><option>DejaVu Sans Mono</option><option>monospace</option><option>Menlo</option><option>Consolas</option></select></label><input id="frame" type="range" min="0" max="63" value="0"><span id="counter"></span>' +
    samples.map((s, i) => '<section><h2>' + s.id + ' · ' + s.rows + ' rows</h2><div class="terminal" id="sample' + i + '"></div></section>').join('') +
    '<script>const samples=' + data + ';let f=0,playing=true,light=false;const slider=document.getElementById("frame");function draw(){samples.forEach((s,i)=>document.getElementById("sample"+i).innerHTML=s.frames[f]);slider.value=f;document.getElementById("counter").textContent=f+"/63"}draw();setInterval(()=>{if(playing){f=(f+1)%64;draw()}},100);document.getElementById("pause").onclick=()=>{playing=!playing};document.getElementById("restart").onclick=()=>{f=0;draw()};slider.oninput=()=>{playing=false;f=Number(slider.value);draw()};document.getElementById("theme").onclick=()=>{light=!light;document.documentElement.style.setProperty("--bg",light?"#f4f5f7":"#161923");document.documentElement.style.setProperty("--ink",light?"#24262d":"#edf0f6")};document.getElementById("font").onchange=e=>document.querySelectorAll(".terminal").forEach(n=>n.style.fontFamily=e.target.value+",monospace");</script>';
  fs.writeFileSync(path.join(output, 'preview.html'), html);
  fs.writeFileSync(path.join(output, 'playing.html'), html.replace('let f=0,playing=true', 'let f=13,playing=false'));
  fs.writeFileSync(path.join(output, 'light.html'), html.replace('let f=0,playing=true', 'let f=37,playing=false')
    .replace('light=false', 'light=true').replace('--bg:#161923;--ink:#edf0f6', '--bg:#f4f5f7;--ink:#24262d'));
  fs.writeFileSync(path.join(output, 'frames.json'), JSON.stringify(samples.map(({id, rows, raw}) => ({id, rows, raw}))));
  const shots = samples.flatMap(s => s.captures.filter((_, i) => [0,1,3].includes(i)));
  const width = 1320, rowHeight = 260;
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + (Math.ceil(shots.length / 2) * rowHeight) + '"><rect width="100%" height="100%" fill="#161923"/>';
  shots.forEach((shot, n) => {
    const ox = 20 + (n % 2) * 650, oy = 42 + Math.floor(n / 2) * rowHeight;
    svg += '<text x="' + ox + '" y="' + (oy - 15) + '" font-family="DejaVu Sans" font-size="16" fill="#a4afc2">' + escape(shot.label) + '</text>';
    shot.cells.forEach((row, y) => row.forEach((c, x) => {
      if (c.ch.trim() === '') return;
      const fg = c.fg.startsWith('var') ? '#edf0f6' : c.fg;
      svg += '<text x="' + (ox + x * 16) + '" y="' + (oy + y * 34 + 27) + '" font-family="DejaVu Sans Mono" font-size="26" fill="' + fg + '">' + escape(c.ch) + '</text>';
    }));
  });
  fs.writeFileSync(path.join(output, 'contact.svg'), svg + '</svg>');
  console.log(output);
} finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
