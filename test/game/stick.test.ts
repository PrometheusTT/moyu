/**
 * 骨架的**可读性**回归 —— 断言的不是数学正确，是"在最矮的那条游戏区里还看得出是个人"。
 *
 * 这个文件存在的原因：角度全都是对的，但半块渲染是一个像素一个格子、**没有子像素**，
 * 所以身高被压到 10 像素以下时，几度的角度差在取整之后会全部塌到同一列上。
 * 实际踩到的样子是：空手那条胳膊的前臂角（`elbowB`）叠加在肩角上正好把肩角抵消掉，
 * 前臂变成垂直，整条胳膊贴在躯干那一列里 —— 画面上只剩"一个点加一条线"。
 *
 * 所以这里量的是**取整之后还剩多少**：两只脚分不分得开、两只手在不在躯干两侧、
 * 光栅化之后一共占多少列。三个数都是能被"角度改小一点"静默吃掉的东西。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, poseIdle, type Body, type Seg } from '../../src/core/stick.ts';
import { World } from '../../src/core/world.ts';

/** `fh` 的夹取范围。低档那一端就是外壳给的最矮游戏区。 */
const H_LO = 8;
const H_HI = 26;

/** 某个部件的远端（手 / 脚）—— 它是那个部件最后一段的终点。 */
function far(segs: Seg[], part: string): { x: number; y: number } {
  const s = segs.filter((x) => x.part === part);
  const l = s[s.length - 1]!;
  return { x: l.x1, y: l.y1 };
}

/** 光栅化成"占了哪些格子"。一像素一格，和终端里看到的是同一件事。 */
function cells(segs: Seg[]): Set<string> {
  const out = new Set<string>();
  for (const s of segs) {
    if (s.part === 'head') {
      const r = Math.max(1, Math.round(s.r));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) out.add(`${Math.round(s.x0 + dx)},${Math.round(s.y0 + dy)}`);
        }
      }
      continue;
    }
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0))));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.add(`${Math.round(s.x0 + (s.x1 - s.x0) * t)},${Math.round(s.y0 + (s.y1 - s.y0) * t)}`);
    }
  }
  return out;
}

/** 遍历所有身高 × 待机相位 × 朝向 × 有无刀。待机是唯一"没有大动作藏着"的姿态。 */
function eachIdle(f: (b: Body, segs: Seg[], label: string) => void): void {
  for (let h = H_LO; h <= H_HI; h++) {
    for (let k = 0; k < 24; k++) {
      for (const face of [1, -1] as const) {
        for (const armed of [true, false]) {
          const b: Body = { x: 40, y: 30, h, face, pose: poseIdle(k * 0.31), armed };
          f(b, segments(b), `h=${h} t=${(k * 0.31).toFixed(2)} face=${face} armed=${armed}`);
        }
      }
    }
  }
}

test('站着不动时两只脚是分开的（并成一条就变成"一根竖线"）', () => {
  eachIdle((_b, segs, label) => {
    const gap = Math.abs(far(segs, 'legA').x - far(segs, 'legB').x);
    assert.ok(gap >= 2.5, `${label}：两脚只差 ${gap.toFixed(2)} px，取整后会并成一列`);
  });
});

test('站着不动时两只手在躯干两侧，各自离肩至少 1.5 px（空手那条胳膊曾经整条看不见）', () => {
  eachIdle((b, segs, label) => {
    const sx = segs.find((s) => s.part === 'armA')!.x0;   // 两条胳膊都从肩起
    // 乘 face 换到"身体自己的左右"，这样朝左朝右用同一个判据。
    const a = (far(segs, 'armA').x - sx) * b.face;
    const bb = (far(segs, 'armB').x - sx) * b.face;
    assert.ok(a * bb < 0, `${label}：两只手在同一侧（a=${a.toFixed(2)} b=${bb.toFixed(2)}）`);
    assert.ok(Math.abs(a) >= 1.5, `${label}：持刀手离肩只有 ${Math.abs(a).toFixed(2)} px`);
    assert.ok(Math.abs(bb) >= 1.5, `${label}：空手离肩只有 ${Math.abs(bb).toFixed(2)} px`);
  });
});

test('光栅化之后至少占 5 列（四肢全塌进躯干那一列就只剩 2–3 列）', () => {
  eachIdle((_b, segs, label) => {
    const cols = new Set([...cells(segs)].map((c) => c.slice(0, c.indexOf(',')))).size;
    assert.ok(cols >= 5, `${label}：只占 ${cols} 列`);
  });
});

test('最矮的游戏区（8 字符行 = 16 像素行）里身高仍有 9 px 以上', () => {
  // 身高是**由地面以上的可用高度反推**的，不是画布高度的固定比例 ——
  // 按固定比例算，下半屏这一档会得到 7 px，四肢就是在那时候塌掉的。
  const w = new World(1);
  w.resize(120, 16);
  assert.ok(w.fh >= 9, `16 像素行只给了 fh=${w.fh}`);
  assert.ok(w.fh <= H_HI);
  assert.ok(w.player.y === w.ground, '玩家没站在地上');
});

test('矮条形区域里跳起来头不会飞出画布（apex 按实际净空夹过）', () => {
  for (const rows of [16, 20, 26, 40, 78]) {
    const w = new World(7);
    w.resize(120, rows);
    let left = false;
    let top = Infinity;
    for (let i = 0; i < 240; i++) {
      w.step(1 / 60, { move: 0, jump: i % 40 === 0, slash: false });
      if (!w.player.onGround) left = true;
      top = Math.min(top, w.player.y - w.player.h);
    }
    assert.ok(left, `${rows} 像素行：跳都跳不起来了`);
    assert.ok(top >= 0, `${rows} 像素行：头飞出画布顶 ${(-top).toFixed(2)} px`);
  }
});
