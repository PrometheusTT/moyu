import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { GraphicsTarget, IMAGE_ID, deleteImageSeq } from '../../src/render/graphics.ts';
import { rgb } from '../../src/render/canvas.ts';

/**
 * 和 `canvas.test.ts` 同一套规矩：把 `encode()` 吐出来的字节**解回**像素，再断言它逐点
 * 等于画进去的东西。这一档更需要这层保险 —— 半块档发错了字节屏幕上会花，肉眼能看见；
 * 这一档发错了键，终端只是**静默丢掉整条 APC**（`q=2` 把错误回复也抑制了，这是必须的，
 * 见 `graphics.ts` 头部），于是屏幕上什么都不出现，而且没有任何报错。
 *
 * 解码器**遇到不认识的键就抛**，所以它顺带锁死了输出词汇表：往 APC 里加一个没想清楚的键
 * 会立刻红，而不是等到某个终端上黑屏。
 */

const ESC = '\x1b';
const KEYS_FIRST = new Set(['a', 'f', 's', 'v', 'o', 'i', 'p', 'c', 'r', 'q', 'C', 'm']);

type Frame = {
  /** 图落在哪一行（APC 之前那条 CUP 的行号）。 */
  row: number;
  keys: Map<string, string>;
  /** inflate 之后的 RGB888。 */
  rgbBuf: Buffer;
  chunks: number;
};

/** 解析"一条 CUP + 一条或多条 APC"。多出任何别的字节都算编码器出错。 */
function decode(s: string): Frame {
  const cup = /^\x1b\[(\d+);(\d+)H/.exec(s);
  assert.ok(cup, `帧开头必须是一条 CUP（图落在光标处），实际 ${JSON.stringify(s.slice(0, 12))}`);
  assert.equal(cup[2], '1', '图必须从游戏区最左列开始');
  let i = cup[0].length;
  let first: Map<string, string> | null = null;
  let b64 = '';
  let chunks = 0;
  while (i < s.length) {
    assert.equal(s.slice(i, i + 3), `${ESC}_G`, `第 ${chunks + 1} 块不是 APC 开头`);
    const end = s.indexOf(`${ESC}\\`, i);
    assert.ok(end > 0, `第 ${chunks + 1} 块没有 ST 结尾 —— 终端会一直等下去，把后面的字节全吃掉`);
    const body = s.slice(i + 3, end);
    const semi = body.indexOf(';');
    assert.ok(semi >= 0, 'APC 里必须有 `;` 分隔键和载荷');
    const keys = parseKeys(body.slice(0, semi), chunks === 0);
    if (chunks === 0) first = keys;
    b64 += body.slice(semi + 1);
    chunks++;
    i = end + 2;
    const more = keys.get('m');
    if (chunks > 1 || first!.has('m')) {
      assert.ok(more !== undefined, `分块传输时第 ${chunks} 块少了 m=`);
      // 除最后一块都必须 m=1；最后一块必须显式 m=0，不然终端会一直等下一块。
      assert.equal(more, i < s.length ? '1' : '0', `第 ${chunks} 块的 m= 不对`);
    } else {
      assert.equal(more, undefined, '单块传输不该带 m=（带了终端会以为还有后续）');
    }
  }
  assert.ok(chunks > 0, '一条 APC 都没有');
  const keys = first!;
  return { row: Number(cup[1]), keys, rgbBuf: inflateSync(Buffer.from(b64, 'base64')), chunks };
}

function parseKeys(src: string, isFirst: boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (src === '') return out;
  for (const kv of src.split(',')) {
    const eq = kv.indexOf('=');
    assert.ok(eq > 0, `键值对 ${JSON.stringify(kv)} 不合法`);
    const k = kv.slice(0, eq);
    // 词汇表锁死：加新键必须先在这里过一遍脑子。
    assert.ok(KEYS_FIRST.has(k), `APC 里出现了意料之外的键 ${JSON.stringify(k)}`);
    if (!isFirst) assert.equal(k, 'm', `后续块只能带 m=，实际带了 ${k}= —— 协议要求，多写终端会当错误`);
    assert.ok(!out.has(k), `键 ${k} 重复了`);
    out.set(k, kv.slice(eq + 1));
  }
  return out;
}

/** 断言解回来的位图逐点等于 target 里的像素。 */
function assertSame(f: Frame, t: GraphicsTarget, what: string): void {
  assert.equal(f.rgbBuf.length, t.pixelW * t.pixelH * 3,
    `${what}：载荷长度和 s=×v= 对不上（补齐用的那几个字节漏出去了？）`);
  for (let y = 0; y < t.pixelH; y++) {
    for (let x = 0; x < t.pixelW; x++) {
      const at = (y * t.pixelW + x) * 3;
      const got = (f.rgbBuf[at]! << 16) | (f.rgbBuf[at + 1]! << 8) | f.rgbBuf[at + 2]!;
      assert.equal(got, t.getPixel(x, y), `${what}：像素 (${x},${y}) 解回来不一样`);
    }
  }
}

const A = rgb(12, 13, 18);
const B = rgb(236, 239, 246);
const C = rgb(214, 34, 46);

test('一帧解回来逐点等于画进去的东西', () => {
  const t = new GraphicsTarget(4, 2, 4, 4);          // 16×8 设备像素
  assert.equal(t.pixelW, 16);
  assert.equal(t.pixelH, 8);
  t.fill(A);
  t.fillRect(2, 1, 5, 3, B);
  t.setPixel(0, 0, C);
  t.setPixel(15, 7, C);
  const f = decode(t.encode(7));
  assert.equal(f.chunks, 1, '这么小的图不该分块');
  assertSame(f, t, '基本回读');
});

test('APC 的键就是协议要的那几个，值和缓冲/格数对得上', () => {
  const t = new GraphicsTarget(40, 2, 16, 34);        // 出货尺寸：640×68
  t.fill(A);
  const f = decode(t.encode(23));
  assert.equal(f.row, 23, '图必须落在游戏区顶行');
  const k = f.keys;
  assert.equal(k.get('a'), 'T', '必须是 a=T（传输并立即放置）');
  assert.equal(k.get('f'), '24', 'f=24 = RGB888');
  assert.equal(k.get('o'), 'z', 'o=z = zlib deflate');
  assert.equal(k.get('s'), '640');
  assert.equal(k.get('v'), '68');
  // c=/r= 硬夹住占的格数：探到的格像素万一过期，宁可让终端缩放糊一帧，也不能让图溢进上半屏。
  assert.equal(k.get('c'), '40', 'c= 必须是列数，不是像素数');
  assert.equal(k.get('r'), '2', 'r= 必须是行数，不是像素数');
  assert.equal(k.get('i'), String(IMAGE_ID));
  assert.equal(k.get('p'), '1', '同 i+p 重传 = 原地替换，这是 Ghostty 上唯一可用的更新方式');
  // q=2 是正确性要求：不抑制回复的话，回复会落在我们自己的 stdin 上被当成按键转发进内层。
  assert.equal(k.get('q'), '2', 'q=2 少了 —— 终端的 OK 回复会被路由进内层的输入框');
  assert.equal(k.get('C'), '1', 'C=1：别动光标');
});

test('大到要分块时，键只写在首块、m 标志正确、拼回来还是同一幅图', () => {
  const t = new GraphicsTarget(40, 2, 8, 17);         // 320×34
  // 纯噪声：deflate 压不动，于是必然跨过 4096 的分块线。种子化，字节数每次一样。
  let seed = 0x9e3779b9;
  for (let y = 0; y < t.pixelH; y++) {
    for (let x = 0; x < t.pixelW; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      t.setPixel(x, y, seed & 0xffffff);
    }
  }
  const s = t.encode(1);
  const f = decode(s);                                 // 分块规则全在 decode 里断言
  assert.ok(f.chunks > 1, `噪声帧只发了 ${f.chunks} 块 —— 这条测试自己失效了`);
  assertSame(f, t, '分块回读');
  // 每块的 base64 载荷都不能超过协议规定的 4096。
  for (const part of s.split(`${ESC}_G`).slice(1)) {
    const payload = part.slice(part.indexOf(';') + 1, part.indexOf(`${ESC}\\`));
    assert.ok(payload.length <= 4096, `有一块载荷 ${payload.length} 字节，超了协议的 4096`);
  }
});

test('世界没动就一个字节都不发；invalidate 之后重发', () => {
  const t = new GraphicsTarget(40, 2, 8, 17);
  t.fill(A);
  assert.ok(t.encode(1).length > 0, '第一帧必须发');
  assert.equal(t.encode(1), '', '同一幅图重发了 —— 暂停/等任务时这一档本该是完全免费的');
  assert.equal(t.lastBytes, 0);
  t.setPixel(3, 3, C);
  assert.ok(t.encode(1).length > 0, '改了一个像素却没发');
  t.invalidate();
  assert.ok(t.encode(1).length > 0, 'invalidate 之后必须整幅重发（ED 2 / 换屏之后终端里的图没了）');
});

test('删图字节：没上传过就不发，上传过发一次，发完之后必须整幅重传', () => {
  const t = new GraphicsTarget(4, 2, 4, 4);
  assert.equal(t.disposeSeq(), '', '还没上传过图就发 a=d —— 半块档/不支持的终端上会当文本打出来');
  t.fill(A);
  t.encode(1);
  assert.equal(t.disposeSeq(), deleteImageSeq(), '收起游戏区时必须删图');
  assert.equal(t.disposeSeq(), '', '删两次');
  // 删掉之后终端里已经没有图了，即使像素一个字节没变也必须重传，否则游戏区会一直空着。
  assert.ok(t.encode(1).length > 0, '删图之后没有重传，游戏区会一直是空的');
  assert.match(deleteImageSeq(), /^\x1b_Ga=d,d=I,i=19801,q=2\x1b\\$/, '大写 I：连图片数据一起释放');
});

test('像素数超上限时按整数倍降采样，但占的格数不变', () => {
  const t = new GraphicsTarget(40, 20, 16, 34);       // 640×680 = 43.5 万，超 40 万
  assert.ok(t.pixelW * t.pixelH <= 400_000, `${t.pixelW}×${t.pixelH} 没降下来，会开始掉帧`);
  assert.equal(t.pixelW, 320, '横向只能按整数倍降（16/2），否则会出摩尔纹似的锯齿');
  assert.equal(t.pixelH, 340);
  t.fill(A);
  const f = decode(t.encode(1));
  assert.equal(f.keys.get('c'), '40', '降采样改了占的格数 —— 图会溢出游戏区');
  assert.equal(f.keys.get('r'), '20');
});

test('出货尺寸跑真实战斗：字节/帧、编码毫秒、分块数都留在实测基线里', async () => {
  const { World } = await import('../../src/core/world.ts');
  const { paintWorld } = await import('../../src/render/scene.ts');
  const { stripPainter } = await import('../../src/render/painter.ts');
  // 两种格像素都测：视网膜（16×34）是**贵的那一档**，也是开发机的真实情况。
  const cases = [
    { cw: 8, ch: 17, avg: 1.4, peak: 2.5, note: '实测 0.94 / 1.52 KB' },
    { cw: 16, ch: 34, avg: 2.6, peak: 4.6, note: '实测 1.95 / 3.22 KB' },
  ];
  for (const c of cases) {
    const t = new GraphicsTarget(40, 2, c.cw, c.ch);
    const p = stripPainter(t);
    const w = new World(0x1234abcd);
    w.resize(p.vw, p.vh);
    w.taskStart();
    let total = 0;
    let peak = 0;
    let chunks = 0;
    const t0 = performance.now();
    for (let f = 0; f < 300; f++) {
      const move: -1 | 0 | 1 = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
      w.step(1 / 60, { move, jump: f % 53 === 0, slash: f % 11 === 0 });
      w.step(1 / 60, { move, jump: false, slash: false });
      paintWorld(p, w);
      const s = t.encode(1);
      total += t.lastBytes;
      if (t.lastBytes > peak) peak = t.lastBytes;
      chunks = Math.max(chunks, (s.match(/\x1b_G/g) ?? []).length);
    }
    const ms = (performance.now() - t0) / 300;
    const avg = total / 300;
    const tag = `格 ${c.cw}×${c.ch} → ${t.pixelW}×${t.pixelH}`;
    assert.ok(avg > 0, `${tag}：一个字节都没发 —— 这条测试自己坏了（世界没在动？）`);
    assert.ok(avg < c.avg * 1024, `${tag}：平均 ${(avg / 1024).toFixed(2)} KB/帧（${c.note}）`);
    assert.ok(peak < c.peak * 1024, `${tag}：最差 ${(peak / 1024).toFixed(2)} KB/帧（${c.note}）`);
    // 一块就够是设计里默认的（`graphics.ts` 头部那句"实测 1 块就够"）。哪天真实战斗
    // 开始分块，说明画面复杂度或尺寸变了，字节预算要重新量。
    assert.equal(chunks, 1, `${tag}：真实战斗帧分了 ${chunks} 块，字节预算要重新量`);
    // 这条是数量级守卫，不是那条 ≤1 ms 的门限 —— 跑测试的机器负载不可控，
    // 精确数字看 `moyu bench --strip --tier=graphics`（实测 0.18 / 0.46 ms）。
    assert.ok(ms < 3, `${tag}：编码 ${ms.toFixed(3)} ms/帧，比实测基线慢了一个数量级`);
  }
});

test('encode(0) = 画在光标处、不发绝对定位（doctor --gfx 的印图靠这个）', () => {
  // `--gfx` 把图印在**普通输出流**里：前面刚打了十几行文字，还可能滚过屏，所以那一刻
  // 绝对行号是未知的，只能相对定位。这条锁住"给 0 就一个定位字节都不发" ——
  // 漏一条 CUP 进去，图就会跳到屏幕第 N 行，把用户的 doctor 输出盖掉一块。
  const t = new GraphicsTarget(40, 2, 16, 34);
  t.fill(rgb(64, 160, 255));
  const at0 = t.encode(0);
  assert.ok(at0.startsWith('\x1b_G'), `给 0 还是发了定位：${JSON.stringify(at0.slice(0, 20))}`);
  assert.ok(!at0.includes('\x1b['), '整条里不该有任何 CSI');
  // 正数照旧发绝对定位 —— 游戏里靠它把图钉在条的顶边上。
  t.invalidate();
  assert.ok(t.encode(7).startsWith('\x1b[7;1H\x1b_G'));
});
