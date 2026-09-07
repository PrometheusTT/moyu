import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../../src/shell/regions.ts';
import { GraphicsTarget } from '../../src/render/graphics.ts';
import { Canvas, rgb } from '../../src/render/canvas.ts';
import { stripPainter, type Painter } from '../../src/render/painter.ts';
import { paintWorld } from '../../src/render/scene.ts';
import { World, NO_INTENT, type Intent } from '../../src/core/world.ts';
import type { PixelTarget } from '../../src/render/target.ts';

/**
 * 可读性回归：**"看不出来是人"这件事有没有被修好，以及会不会再坏回去。**
 *
 * 起因是实测出来的一条算术：出货形态是输入框上方 2 个字符行，半块档一格 2 个像素行，
 * 于是画布只有 4 像素高、火柴人 3 像素高 —— 大腿 0.75 像素。那个尺寸下任何姿势参数
 * 都救不回来，所以 R1 换的是渲染方式（kitty graphics 直送设备像素），不是美术参数。
 *
 * 这个文件断言的就是那次更换**在出货的那块矩形上**真的兑现了，以及六条美术规则里
 * 能被机器判定的那几条。**不断言"好看"** —— 好看只有人能判断（R1 验收项 5 归你）。
 * 断言的是"人眼要能读出形状"的几个必要条件，每条都能指名道姓地说出坏掉之后屏幕上
 * 会变成什么样：
 *
 *   身高   —— 回到 3 像素就等于回到"一根铁丝"，这是整个 R1 的存在理由
 *   描边   —— 描边一破，角色边缘就直接贴着天空的中间调，剪影糊在背景里
 *   笔宽   —— 笔宽掉到 1 就是铁丝，即使身高够也读不出四肢
 *   对比   —— 描边色被调亮 / 天空被调暗，描边就不再分隔角色和背景
 *   姿势保持 —— 关键帧退回连续插值，30fps 下每段只有 2 帧，眼睛抓不住斩击
 *   碎块   —— 碎块退回单像素，砍碎那一下就只是一把噪点
 *
 * 手段和 `test/render/canvas.test.ts` 同一套规矩：**把像素读回来**再断言，
 * 而不是断言"发了多少字节"。字节对不对是 `graphics.test.ts` 的事。
 */

/** 视网膜格（Ghostty 在 2× 屏上就是这个数），R1 的目标档。 */
const CELL = { w: 16, h: 34 };

/** 出货布局：100×40 的终端 → 内层 38 行 + 2 行的游戏条。不写死数字，常数改了这里跟着变。 */
const L = (() => {
  const r = computeLayout({ cols: 100, rows: 40, manualGameRows: 2 });
  assert.equal(r.kind, 'split', '100×40 应该能分屏');
  return r.kind === 'split' ? r.layout : null!;
})();

/* 调色板在这里**故意重抄一遍** —— 这是一份契约，不是重复。scene.ts 改了颜色，
 * 这里就该红：要么是有意改的（同步过来），要么是不小心把描边调亮了（正是要抓的）。 */
const BONE = rgb(236, 239, 246);        // 玩家
const KEY = rgb(6, 6, 9);               // 描边，必须比最暗的天空还暗
const PIECE_DEAD = rgb(92, 95, 108);    // 落地的碎块
/** 血。画在玩家**之后**，所以它贴着 BONE 是应该的，见描边那条测试。 */
const BLOOD = rgb(214, 34, 46);

const lum = (c: number): number =>
  0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);

/** 无敌帧闪烁（出生时 0.6s，玩家被画成 FOE）过去所需的步数。不等它就一个 BONE 都扫不到。 */
const WARMUP = 45;

type Rig = { t: PixelTarget; p: Painter; w: World };

function rig(target: PixelTarget, seed: number): Rig {
  const p = stripPainter(target);
  const w = new World(seed);
  w.resize(p.vw, p.vh);                  // 主程序就是这么喂的（main.ts 的 game.resize(p.vw, p.vh)）
  for (let i = 0; i < WARMUP; i++) w.step(1 / 60, NO_INTENT);
  return { t: target, p, w };
}

/** 出货那块矩形上的像素档。 */
const gfx = (seed: number): Rig => rig(new GraphicsTarget(L.fieldCols, L.gameRows, CELL.w, CELL.h), seed);

/** 打一段真实战斗：60Hz 模拟、30fps 作画，走位 + 每 11 帧一刀 + 每 53 帧一跳。 */
function fight(r: Rig, frames: number): void {
  r.w.taskStart();
  for (let f = 0; f < frames; f++) {
    const move: -1 | 0 | 1 = Math.floor(f / 37) % 2 === 0 ? 1 : -1;
    const i: Intent = { move, jump: f % 53 === 0, slash: f % 11 === 0 };
    r.w.step(1 / 60, i);
    r.w.step(1 / 60, { move, jump: false, slash: false });
  }
  paintWorld(r.p, r.w);
}

/** 某个颜色的外接框 + 像素数。 */
function scan(t: PixelTarget, want: number): { n: number; w: number; h: number } {
  let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < t.pixelH; y++) {
    for (let x = 0; x < t.pixelW; x++) {
      if (t.getPixel(x, y) !== want) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { n, w: n === 0 ? 0 : x1 - x0 + 1, h: n === 0 ? 0 : y1 - y0 + 1 };
}

test('出货那块 2 行条上，火柴人有 36 设备像素以上高 —— 半块档只有 4（R1 的存在理由）', () => {
  // 这条测的是整个 R1 的收益本身。两边用**同一块矩形、同一份世界代码**，差别只在渲染目标：
  // 像素档一格是 16×34 设备像素，半块档一格是 1×2 —— 于是 world.resize 拿到的
  // 可用高度差 17 倍，反推出来的身高（fh）跟着差一个数量级。
  const g = gfx(7);
  paintWorld(g.p, g.w);
  const tall = scan(g.t, BONE);
  assert.ok(tall.n > 0, `一个 BONE 像素都没扫到 —— 要么调色板改了，要么无敌帧闪烁没等完（WARMUP=${WARMUP}）`);
  assert.ok(tall.h >= 36, `像素档火柴人只有 ${tall.h} 设备像素高（实测基线 47），读不出四肢`);

  const half = rig(new Canvas(L.fieldCols, L.gameRows), 7);
  paintWorld(half.p, half.w);
  const wire = scan(half.t, BONE);
  assert.ok(wire.n > 0, '半块档一个 BONE 都没有 —— 这条对照自己坏了');
  assert.ok(wire.h <= 5, `半块档居然有 ${wire.h} 像素高 —— 那这条对照没意义了，基线是 4`);
  assert.ok(tall.h / wire.h >= 8,
    `像素档只比半块档高 ${(tall.h / wire.h).toFixed(1)} 倍（实测基线 11.8）—— R1 的收益在缩水`);

  // 顺带钉住虚拟坐标层：模拟跑在固定虚拟高度上，所以换字号不该改变手感。
  assert.equal(g.p.vh, 44, '条形的虚拟高度（STRIP_VH）变了 —— 世界会跟着字号变高变矮');
  assert.equal(half.p.k, 1, '半块档必须 k=1，否则它的字节数会和 M0 的基线对不上');
});

test('描边把角色和背景彻底隔开：没有一个 BONE 像素直接贴着中间调', () => {
  // 六条美术规则里收益最大的一条。1 像素的暗边（KEY 比最暗的天空还暗）让剪影不依赖
  // "背景恰好比人暗"。它一破，角色边缘就直接压在天空的中间调上 —— 屏幕上看到的是
  // 一团糊在背景里的浅色，而不是一个人。
  //
  // 判据：BONE 的四邻居里不许出现亮度落在 (8, 90) 的**背景**像素。KEY 的亮度是 6.2，
  // 所以 ≤8 就是描边（或和它同暗的天空最深一带）；≥90 是刀光 / 波纹 / 自己的浅色部件。
  // 围巾（ACCENT）画在描边之后，允许贴着天空 —— 所以只扫 BONE。
  //
  // BLOOD（亮度 73.1）要放行：`paintWorld` 的顺序是 …→玩家→刀光→血→波纹，血是**盖在**
  // 玩家身上的，贴着 BONE 是对的。它也是玩家之后唯一一个中间调 —— 刀光和波纹都在 90 以上，
  // 所以这一条放行是从作画顺序推出来的，不是为了让测试变绿。地面高光（亮度 66.7）和
  // 血渍（36.9）都在玩家**之前**画，仍然落在窗口里被查着。
  for (const seed of [7, 11, 0x1234abcd]) {
    for (const frames of [0, 200, 600, 900]) {
      const g = gfx(seed);
      if (frames === 0) paintWorld(g.p, g.w); else fight(g, frames);
      const bad: string[] = [];
      for (let y = 0; y < g.t.pixelH; y++) {
        for (let x = 0; x < g.t.pixelW; x++) {
          if (g.t.getPixel(x, y) !== BONE) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= g.t.pixelW || ny >= g.t.pixelH) continue;   // 出框由 c=/r= 夹住
            const c = g.t.getPixel(nx, ny);
            if (c === BLOOD) continue;
            const l = lum(c);
            if (l > 8 && l < 90) bad.push(`(${x},${y})→(${nx},${ny}) 亮度 ${l.toFixed(1)}`);
          }
        }
      }
      assert.deepEqual(bad.slice(0, 4), [],
        `种子 ${seed} 第 ${frames} 帧：${bad.length} 处描边破口，角色边缘贴到了背景上`);
    }
  }
});

test('四肢是有宽度的笔，不是一根铁丝（行内游程中位数 ≥ 3）', () => {
  // 笔宽按身高走（R_LIMB = 1/22、R_TORSO = 1/15），40 设备像素上是 3–5 像素粗。
  // 掉回 1 就是铁丝 —— 身高够了照样读不出手脚。用中位数而不是最小值：
  // 胶囊两端本来就会收到 1 像素，那不是错。
  const g = gfx(11);
  paintWorld(g.p, g.w);
  const runs: number[] = [];
  for (let y = 0; y < g.t.pixelH; y++) {
    let run = 0;
    for (let x = 0; x <= g.t.pixelW; x++) {
      if (x < g.t.pixelW && g.t.getPixel(x, y) === BONE) { run++; continue; }
      if (run > 0) runs.push(run);
      run = 0;
    }
  }
  assert.ok(runs.length >= 10, `只有 ${runs.length} 段 BONE 游程 —— 人根本没画出来`);
  runs.sort((a, b) => a - b);
  const med = runs[runs.length >> 1]!;
  assert.ok(med >= 3, `BONE 行内游程中位数只有 ${med} 像素（实测基线 4）—— 四肢细成了铁丝`);
});

test('屏幕上最暗的一定是描边，最亮的一定属于主角（刀或他自己）', () => {
  // 描边的全部作用来自"它比背景里任何东西都暗"，剪影的可读性来自"主角比背景里任何东西都亮"。
  // 这条不测形状，测的是那两个前提：哪天有人把 KEY 调亮一档、或者把地面高光（亮度 66.7）
  // 调到主角之上，剪影会**静默地**糊回背景里，而上面那条邻接测试仍然是绿的
  // （邻居还是"暗"的，只是不再比角色暗多少了）。
  //
  // 最亮的那个像素允许是 STEEL（刀，绝大多数帧）也允许是 BONE —— 玩家死了正在重生那几帧
  // 没有刀，屏幕上最亮的是他飞出去的碎块（`paintWorld` 里 `q.mine` 的碎块就是 BONE）。
  // 所以门限写成"≥ BONE 的亮度"，而不是钉死某一个颜色。
  for (const seed of [7, 11, 0x1234abcd]) {
    for (const frames of [0, 200, 900]) {
      const g = gfx(seed);
      if (frames === 0) paintWorld(g.p, g.w); else fight(g, frames);
      let lo = 0xffffff, hi = 0;
      for (let y = 0; y < g.t.pixelH; y++) {
        for (let x = 0; x < g.t.pixelW; x++) {
          const c = g.t.getPixel(x, y);
          if (lum(c) < lum(lo)) lo = c;
          if (lum(c) > lum(hi)) hi = c;
        }
      }
      const at = `种子 ${seed} 第 ${frames} 帧`;
      assert.equal(lo, KEY, `${at}：最暗的像素是 #${lo.toString(16).padStart(6, '0')}，不是描边色`);
      assert.ok(lum(hi) >= lum(BONE),
        `${at}：最亮的像素是 #${hi.toString(16).padStart(6, '0')}（亮度 ${lum(hi).toFixed(1)}），`
        + `比主角（${lum(BONE).toFixed(1)}）还亮 —— 背景压过了角色`);
    }
  }
});

test('斩击读得出来：整段挥刀是 3–8 个各自保持 ≥2 帧的关键姿势，不是一段插值涂抹', () => {
  // 原来的斩击是 windup/strike/recover 三段连续插值 —— 30fps 下每段只有 2 帧，
  // 每帧都不一样，眼睛只看到一团抖动。改成关键姿势（holdK）之后每个姿势至少停 3 帧，
  // 段与段之间快切。这条把那个结构本身钉住：
  //
  //   distinct 太多 → 退回连续插值了（每帧一个新姿势）
  //   distinct 太少 → 关键帧被合并掉了，挥刀变成"出现-消失"
  //   某一段只有 1 帧 → 那一帧眼睛抓不住，等于没画
  //   相邻关键帧差得太少 → 幅度不够夸张，读不出"挥"这个动作
  //
  // 只在 `atk >= 0`（挥刀进行中）期间取样：挥完之后 idle 呼吸本来就每帧都在动。
  const g = gfx(7);
  const sigs: string[] = [];
  for (let f = 0; f < 24; f++) {
    g.w.step(1 / 60, { move: 0, jump: false, slash: f === 0 });
    g.w.step(1 / 60, NO_INTENT);
    if (g.w.player.atk < 0) continue;
    paintWorld(g.p, g.w);
    const on: string[] = [];
    for (let y = 0; y < g.t.pixelH; y++) {
      for (let x = 0; x < g.t.pixelW; x++) if (g.t.getPixel(x, y) === BONE) on.push(`${x},${y}`);
    }
    sigs.push(on.join(' '));
  }
  assert.ok(sigs.length >= 12, `挥刀只画了 ${sigs.length} 帧（实测基线 18）—— 命中窗口或帧率变了`);

  const id = new Map<string, number>();
  const runs: Array<{ id: number; n: number }> = [];
  for (const s of sigs) {
    if (!id.has(s)) id.set(s, id.size);
    const k = id.get(s)!;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.id === k) last.n++;
    else runs.push({ id: k, n: 1 });
  }
  assert.ok(id.size >= 3 && id.size <= 8,
    `挥刀期间出现 ${id.size} 个不同姿势（实测基线 6）—— 太多就是退回了逐帧插值，太少就是关键帧被合并了`);
  const short = runs.filter((r) => r.n < 2);
  assert.deepEqual(short, [], `有关键姿势只保持了 1 帧（30fps 下 33ms，眼睛抓不住）：${JSON.stringify(runs)}`);

  const keys = [...id.keys()].map((s) => new Set(s.split(' ')));
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    let same = 0;
    for (const q of b) if (a.has(q)) same++;
    const change = 1 - same / Math.max(a.size, b.size);
    assert.ok(change >= 0.15,
      `第 ${i} 个关键姿势只变了 ${(change * 100).toFixed(0)}%（实测基线 21–54%）—— 幅度不够，读不出挥刀`);
  }
});

test('碎块是肢体形状，不是单像素噪点', () => {
  // 砍碎那一下是这个 demo 的卖点（"酣畅淋漓"）。碎块按 segments(b) 切成带描边的方块，
  // 一块落地后在 40 像素的人身上应该有 8–18 个设备像素。退回单像素实现的话这个数会掉到 ~1，
  // 屏幕上就只是一把噪点 —— 而字节数和帧率都不会有任何变化，只有这里会红。
  const g = gfx(0x1234abcd);
  fight(g, 900);
  const rest = g.w.pieces.filter((p) => p.rest).length;
  assert.ok(rest >= 3, `900 帧战斗之后只有 ${rest} 块落地碎块 —— 这条测试自己坏了（没人被砍死？）`);
  const px = scan(g.t, PIECE_DEAD).n;
  assert.ok(px / rest >= 5,
    `每块落地碎块平均 ${(px / rest).toFixed(1)} 个设备像素（实测基线 8.6–17.5）—— 碎块退化成噪点了`);
});
