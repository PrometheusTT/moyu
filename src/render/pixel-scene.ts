import { segments, type Pose } from '../core/stick.ts';
import type { Fighter, World } from '../core/world.ts';
import type { PixelCanvas, PixelRenderContext } from '../platform/types.ts';

export const PIXEL_PALETTES = {
  dark: { bg: 0x101218, floor: 0x303641, hero: 0xeff2f6, foe: 0xb6a393, blade: 0xebc875, accent: 0xf17869 },
  light: { bg: 0xf3f4f6, floor: 0xb9bec7, hero: 0x242a33, foe: 0x755746, blade: 0x805b00, accent: 0xa9322b },
} as const;

export type FighterSnapshots = ReadonlyMap<Fighter, Fighter>;
export function snapshotFighters(world: World): FighterSnapshots {
  return new Map([world.player, ...world.enemies].map(f => [f, { ...f, pose: { ...f.pose } }]));
}

/** Continuous motion may interpolate; attacks, facing and impacts always use current semantics. */
export function interpolateFighter(current: Fighter, previous: Fighter | undefined, alpha: number): Fighter {
  if (previous === undefined || Math.hypot(current.x - previous.x, current.y - previous.y) > current.h * 2) return current;
  const t = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  const mix = (a: number, b: number): number => a + (b - a) * t;
  let pose = current.pose;
  const ordinary = (f: Fighter): boolean => f.atk < 0 && f.hurt <= 0 && f.windup < 0 && f.land <= 0;
  if (ordinary(current) && ordinary(previous) && current.face === previous.face && current.onGround === previous.onGround) {
    pose = { ...pose };
    for (const key of Object.keys(pose) as Array<keyof Pose>) pose[key] = mix(previous.pose[key], pose[key]);
  }
  return { ...current, x: mix(previous.x, current.x), y: mix(previous.y, current.y), pose };
}

export type PixelCamera = { scale: number; x: (worldX: number) => number; y: (worldY: number) => number };
export function pixelCamera(width: number, height: number, world: World, playerX = world.player.x): PixelCamera {
  // The nominal 44-unit scene gets four units of headroom for the skeleton's head/weapon extents.
  // Height, never world width, controls detail. A narrow expanded view follows the player.
  const scale = height / (world.h + 4);
  const visible = width / scale;
  const center = visible >= world.w ? world.w / 2 : Math.max(visible / 2, Math.min(world.w - visible / 2, playerX));
  return { scale, x: x => (x - center) * scale + width / 2, y: y => (y + 4) * scale };
}

/** A quiet, native-resolution combat scene; rendering never changes simulation or collision. */
export function paintPixelWorld(c: PixelCanvas, world: World, context: PixelRenderContext, previous?: FighterSnapshots): void {
  const palette = PIXEL_PALETTES[context.theme];
  c.clear(palette.bg);
  const player = interpolateFighter(world.player, previous?.get(world.player), context.interpolation);
  const camera = pixelCamera(c.width, c.height, world, player.x);
  const { scale, x, y } = camera;
  c.rect(0, Math.floor(y(world.ground)), c.width, Math.max(1, Math.round(scale * 0.6)), palette.floor);

  const draw = (f: Fighter, hero: boolean): void => {
    const body = interpolateFighter(f, previous?.get(f), context.interpolation);
    const segs = segments(body);
    const ink = f.hurt > 0 || f.windup >= 0 ? palette.accent : hero ? palette.hero : palette.foe;
    for (const s of segs) {
      const color = s.part === 'blade' ? palette.blade : ink;
      const radius = s.part === 'head' ? s.r * scale : Math.max(0.55,
        body.h * scale / (s.part === 'torso' ? 28 : s.part === 'blade' ? 48 : 38));
      c.stroke(x(s.x0), y(s.y0), x(s.x1), y(s.y1), radius, color);
      if (hero && s.part === 'torso') {
        // A single short scarf marks facing; it never hides either hand or the weapon.
        c.stroke(x(s.x1), y(s.y1), x(s.x1 - f.face * f.h * 0.22), y(s.y1 + f.h * 0.08),
          Math.max(0.55, body.h * scale / 45), palette.accent);
      }
    }
    if (hero && world.hitstop > 0 && f.atk >= 0 && process.env.MOYU_REDUCE_MOTION !== '1') {
      const blade = segs.find(s => s.part === 'blade');
      if (blade !== undefined) {
        const tx = x(blade.x1), ty = y(blade.y1), r = Math.max(2, scale * 2);
        c.line(tx - r, ty - r, tx + r, ty + r, palette.accent);
        c.line(tx + r, ty - r, tx - r, ty + r, palette.accent);
      }
    }
  };
  for (const enemy of world.enemies) draw(enemy, false);
  if (world.respawn <= 0) draw(world.player, true);
  else c.stroke(x(player.x - 4), y(world.ground - 1), x(player.x + 4), y(world.ground - 1), Math.max(0.6, scale), palette.accent);
}
