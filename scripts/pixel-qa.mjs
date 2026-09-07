// Development-only export of the actual encoded Kitty RGB frames. No image library required.
// node --experimental-strip-types scripts/pixel-qa.mjs [output-directory]
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { PixelSample } from '../src/platform/pixel-sample.ts';
import { GraphicsTarget } from '../src/render/graphics.ts';
import { PIXEL_PALETTES } from '../src/render/pixel-scene.ts';
const out = path.resolve(process.argv[2] ?? '/tmp/moyu-pixel-qa');
fs.mkdirSync(out, { recursive: true });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([head, type, data, tail]);
}
function png(width, height, rgb) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scan = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(scan, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
function decoded(target) {
  target.invalidate();
  const encoded = target.encode(1);
  const chunks = [...encoded.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  if (!chunks.length) throw new Error('Missing Kitty frame');
  const rgb = inflateSync(Buffer.from(chunks.map(c => c[2]).join(''), 'base64'));
  if (rgb.length !== target.pixelW * target.pixelH * 3) throw new Error('Invalid RGB payload');
  return { rgb, bytes: Buffer.byteLength(encoded) };
}
const scenarios = [
  { cw: 8, ch: 17, rows: 2, theme: 'dark' },
  { cw: 16, ch: 34, rows: 2, theme: 'dark' },
  { cw: 16, ch: 34, rows: 2, theme: 'light' },
  { cw: 16, ch: 34, rows: 6, theme: 'dark' },
];
const all = [], measurements = [], captures = [];
for (const s of scenarios) {
  const sample = new PixelSample(), oldTarget = new GraphicsTarget(40, s.rows, s.cw, s.ch), newTarget = new GraphicsTarget(40, s.rows, s.cw, s.ch);
  const frames = []; let bytes = 0, peak = 0, ms = 0;
  for (let f = 0; f < 180; f++) {
    sample.step(); sample.step();
    sample.render(oldTarget, true, s.theme);
    const start = performance.now(); sample.render(newTarget, false, s.theme); const current = decoded(newTarget); ms += performance.now() - start;
    const previous = decoded(oldTarget); bytes += current.bytes; peak = Math.max(peak, current.bytes);
    const oldPng = png(oldTarget.pixelW, oldTarget.pixelH, previous.rgb), newPng = png(newTarget.pixelW, newTarget.pixelH, current.rgb);
    frames.push([oldPng.toString('base64'), newPng.toString('base64')]);
    if ([0, 33, 47, 78, 128].includes(f)) {
      const name = `${newTarget.pixelW}x${newTarget.pixelH}-${s.theme}-f${f}`;
      fs.writeFileSync(path.join(out, `${name}-before.png`), oldPng);
      fs.writeFileSync(path.join(out, `${name}-after.png`), newPng);
      captures.push({ name, width: newTarget.pixelW, height: newTarget.pixelH, before: previous.rgb, after: current.rgb });
    }
  }
  const width = newTarget.pixelW, height = newTarget.pixelH;
  all.push({ ...s, width, height, frames });
  measurements.push({ width, height, theme: s.theme, fps: 30, averageBytes: Math.round(bytes / 180), peakBytes: peak, meanRenderEncodeMs: +(ms / 180).toFixed(3) });
}
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(measurements, null, 2));
const data = JSON.stringify(all).replaceAll('<', '\\u003c');
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Moyu 原生像素 A/B</title>
<style>body{margin:24px;background:#101218;color:#eff2f6;font:15px/1.6 system-ui}h1{font-size:24px}h2{font-size:16px;margin:20px 0 8px}p{max-width:75ch}button,select,input{font:inherit;margin:4px;padding:5px}section{margin:24px 0}.pair{display:flex;flex-wrap:wrap;gap:20px}.label{color:#b6bfce;margin-bottom:5px}img{display:block;image-rendering:pixelated}#samples{overflow:auto}small{color:#b6bfce}</style>
<h1>Moyu · 原生像素对比</h1><p>左为旧版 180×44 中转，右为直接像素绘制。图像从实际 Kitty 载荷解码，同一物理状态；旧版保持原有暗色。这里只验证源画面，原生终端清除与显示效果仍需实测。</p>
<button id="play">暂停</button><button id="reset">重播</button><label>速度 <select id="fps"><option>30</option><option>15</option></select> fps</label><label>显示 <select id="zoom"><option value="1">原始设备像素 1:1</option><option value="0.5">Retina 2× 对应 CSS 大小</option><option value="2">放大 2 倍检查</option></select></label>
<input id="frame" type="range" min="0" max="179" value="0"><span id="count"></span><div id="samples"></div>
<script>const data=${data};let f=0,playing=true,last=0;const host=document.getElementById('samples');data.forEach((s,i)=>{host.insertAdjacentHTML('beforeend','<section><h2>'+s.width+'×'+s.height+' · '+s.rows+' 行 · '+s.theme+'</h2><div class="pair"><div><div class="label">旧版</div><img id="old'+i+'" alt="旧版像素帧"></div><div><div class="label">原生像素</div><img id="new'+i+'" alt="新版像素帧"></div></div></section>')});function draw(){data.forEach((s,i)=>{['old','new'].forEach((name,j)=>{const img=document.getElementById(name+i);img.src='data:image/png;base64,'+s.frames[f][j];img.style.width=s.width*Number(document.getElementById('zoom').value)+'px';img.style.height=s.height*Number(document.getElementById('zoom').value)+'px'})});document.getElementById('frame').value=f;document.getElementById('count').textContent=f+'/179'}function tick(now){const fps=Number(document.getElementById('fps').value);if(playing&&now-last>=1000/fps){f=(f+(fps===15?2:1))%180;last=now;draw()}requestAnimationFrame(tick)}document.getElementById('play').onclick=()=>{playing=!playing;document.getElementById('play').textContent=playing?'暂停':'播放'};document.getElementById('reset').onclick=()=>{f=0;draw()};document.getElementById('frame').oninput=e=>{playing=false;f=Number(e.target.value);document.getElementById('play').textContent='播放';draw()};document.getElementById('zoom').onchange=draw;draw();requestAnimationFrame(tick);</script></html>`;
fs.writeFileSync(path.join(out, 'preview.html'), html);
fs.writeFileSync(path.join(out, 'still.html'), html.replace('let f=0,playing=true', 'let f=33,playing=false'));
// Contact sheet is raw RGB copying, not a synthetic reconstruction of dots or glyphs.
const selected = captures.filter(c => c.name.startsWith('640x68-dark'));
const sheetW = 1280, sheetH = selected.length * 88;
const sheet = Buffer.alloc(sheetW * sheetH * 3);
const bg = PIXEL_PALETTES.dark.bg;
for (let i = 0; i < sheet.length; i += 3) { sheet[i] = bg >> 16; sheet[i + 1] = (bg >> 8) & 255; sheet[i + 2] = bg & 255; }
selected.forEach((shot, n) => [shot.before, shot.after].forEach((rgb, side) => {
  for (let y = 0; y < shot.height; y++) rgb.copy(sheet, ((n * 88 + y) * sheetW + side * 640) * 3, y * 640 * 3, (y + 1) * 640 * 3);
}));
fs.writeFileSync(path.join(out, 'contact.png'), png(sheetW, sheetH, sheet));
console.log(JSON.stringify({ output: out, measurements }, null, 2));
