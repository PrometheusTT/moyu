import type { Fighter } from './world.ts';
import { segments, type Seg } from './stick.ts';

/** 身体和死亡碎片共用同一轮廓：六足菱蛛、三角螳螂、方甲虫、八足蛛王。 */
export function fighterSegments(f: Fighter): Seg[] {
  if (f.kind === 'player' || f.tag === undefined) return segments(f);
  const out: Seg[] = [];
  const h = f.h, x = f.x, y = f.y;
  const line = (a: number, b: number, c: number, d: number, part: Seg['part'] = 'torso'): void => {
    out.push({ x0: x + a * h * 0.75, y0: y + b * h, x1: x + c * h * 0.75, y1: y + d * h, part, r: 0 });
  };
  const boss = f.tag === 'boss', box = f.tag === 'brute', triangle = f.tag === 'runner';
  if (!boss && f.species) {
    const poly = (points: number[][]): void => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!, b = points[i + 1]!;
        line(a[0]!, a[1]!, b[0]!, b[1]!);
      }
    };
    const gait = Math.sin(f.walk * Math.PI * 2) * 0.1;
    const legs = (pairs: number, spread: number): void => {
      for (let i = 0; i < pairs; i++) for (const sign of [-1, 1]) {
        const a = sign * (0.2 + i * spread);
        poly([[sign * 0.18, -0.35], [a, -0.45 + gait * sign], [a + sign * 0.15, -0.02]]);
      }
    };
    switch (f.species) {
      case 'mantis':
        poly([[-0.3, -0.25], [0, -0.85], [0.32, -0.3], [-0.3, -0.25]]); legs(2, 0.3);
        for (const s of [-1, 1]) poly([[s * 0.15, -0.55], [s * 0.65, -0.9], [s * 0.5, -0.35]]);
        break;
      case 'crab':
        poly([[-0.4, -0.5], [0.4, -0.5], [0.35, -0.2], [-0.35, -0.2], [-0.4, -0.5]]); legs(3, 0.18);
        for (const s of [-1, 1]) poly([[s * 0.35, -0.4], [s * 0.7, -0.7], [s * 0.85, -0.48], [s * 0.55, -0.55]]);
        break;
      case 'eel':
        for (let i = 0; i < 7; i++) {
          const a = -0.9 + i * 0.25, b = a + 0.25;
          const ay = -0.28 + Math.sin(i * 1.3 + f.walk * 6) * 0.13;
          const by = -0.28 + Math.sin((i + 1) * 1.3 + f.walk * 6) * 0.13;
          poly([[a, ay], [b, by], [a, ay + 0.16], [a, ay]]);
        }
        break;
      case 'scorpion':
        poly([[-0.35, -0.25], [-0.35, -0.5], [0.35, -0.5], [0.35, -0.25], [-0.35, -0.25]]); legs(3, 0.2);
        poly([[-0.3, -0.4], [-0.75, -0.65], [-0.65, -1.05], [-0.3, -1.1], [-0.2, -0.85]]);
        poly([[0.3, -0.4], [0.8, -0.6], [0.65, -0.25]]);
        break;
      case 'scarab':
        poly([[-0.4, -0.3], [-0.32, -0.7], [0.32, -0.7], [0.4, -0.3], [-0.4, -0.3]]); legs(3, 0.15);
        line(0, -0.7, 0, -0.3); poly([[0.3, -0.6], [0.6, -0.85], [0.5, -0.45]]);
        break;
      case 'wolf':
        poly([[-0.5, -0.5], [0.25, -0.55], [0.4, -0.9], [0.5, -0.65], [0.8, -0.5], [0.3, -0.3], [-0.5, -0.3], [-0.5, -0.5], [-0.8, -0.75]]);
        for (const s of [-1, 1]) for (const offset of [-0.1, 0.1]) poly([[s * 0.35, -0.35], [s * 0.45 + offset, -0.2], [s * 0.55 + offset + gait, 0]]);
        break;
      case 'crystal':
        for (const s of [-1, 0, 1]) poly([[s * 0.25 - 0.2, -0.3], [s * 0.4, s === 0 ? -1 : -0.75], [s * 0.25 + 0.2, -0.3]]);
        legs(3, 0.2); break;
      case 'bat':
        poly([[-0.12, -0.3], [0, -0.85], [0.12, -0.3], [-0.12, -0.3]]);
        for (const s of [-1, 1]) poly([[0, -0.6], [s * 0.8, -0.95 + gait * 2], [s * 0.6, -0.35], [s * 0.4, -0.5], [s * 0.2, -0.25], [0, -0.6]]);
        break;
      case 'idol':
        poly([[-0.35, -0.3], [-0.3, -0.85], [0.3, -0.85], [0.35, -0.3], [-0.35, -0.3]]); legs(3, 0.2);
        poly([[-0.3, -0.85], [-0.4, -1.05], [0, -0.9], [0.4, -1.05], [0.3, -0.85]]);
        line(-0.15, -0.48, 0.15, -0.48); break;
    }
    for (const eye of [-0.1, 0.1]) out.push({ part: 'head', x0: x + eye * h, y0: y - h * 0.55, x1: x, y1: y, r: h * 0.045 });
    return out;
  }
  const pairs = boss ? 4 : triangle ? 2 : 3;
  const width = boss ? 0.48 : triangle ? 0.3 : 0.36;
  const top = box ? -0.64 : -0.56;
  const points = box ? [[-width, top], [width, top], [width, -0.26], [-width, -0.26]]
    : triangle ? [[f.face * 0.55, -0.35], [-f.face * 0.28, -0.8], [-f.face * 0.28, -0.25]]
      : [[-width, -0.4], [0, top - 0.18], [width, -0.4], [0, -0.18]];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    line(a[0]!, a[1]!, b[0]!, b[1]!);
  }
  for (let i = 0; i < pairs; i++) for (const side of [-1, 1]) {
    const gait = Math.sin(f.walk * Math.PI * 2 + i * 2.1 + (side > 0 ? Math.PI : 0));
    const spread = 0.35 + i * 0.18;
    line(side * width * 0.6, -0.32, side * spread, -0.4 + gait * 0.06, 'legA');
    line(side * spread, -0.4 + gait * 0.06, side * (spread + 0.12) + gait * 0.06, -Math.max(0, gait) * 0.1, 'legB');
  }
  // 双眼与向前伸出的口器；前摇时张开，维持可读的攻击预警。
  for (const eye of [-0.1, 0.1]) {
    out.push({ part: 'head', x0: x + (f.face * 0.18 + eye) * h, y0: y - h * 0.46,
      x1: x, y1: y, r: h * 0.055 });
  }
  const jaw = f.windup >= 0 ? 0.2 : 0.09;
  line(f.face * width, -0.32, f.face * (width + 0.22), -0.32 - jaw, 'armA');
  line(f.face * width, -0.32, f.face * (width + 0.22), -0.32 + jaw, 'armB');
  return out;
}
