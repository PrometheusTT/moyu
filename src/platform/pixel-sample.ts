import { World } from '../core/world.ts';
import type { PixelTarget } from '../render/target.ts';
import { paintWorld } from '../render/scene.ts';
import { stripPainter } from '../render/painter.ts';
import { paintPixelWorld, snapshotFighters, type FighterSnapshots } from '../render/pixel-scene.ts';
import { LogicalCanvas } from './canvas.ts';
import { NativePixelCanvas } from './pixel-canvas.ts';

/** Deterministic, shared simulation for native-terminal A/B and offline pixel exports. No saves. */
export class PixelSample {
  world: World;
  private previous: FighterSnapshots = new Map();
  private readonly legacy = new LogicalCanvas(180, 44);
  private frame = 0;
  constructor() { this.world = this.makeWorld(); }
  private makeWorld(): World {
    const world = new World(0x5eed);
    world.resize(180, 44); world.enemyLimit = 3; world.taskStart();
    return world;
  }
  reset(): void { this.world = this.makeWorld(); this.previous = new Map(); this.frame = 0; }
  step(): void {
    if (this.frame >= 720) this.reset();
    this.previous = snapshotFighters(this.world);
    const f = this.frame++;
    this.world.step(1 / 60, {
      move: f < 60 ? 0 : Math.floor((f - 60) / 90) % 2 === 0 ? 1 : -1,
      jump: f === 150 || f === 420,
      slash: f === 60 || f === 240 || f === 300 || f === 480 || f === 540 || f === 600,
    });
  }
  render(target: PixelTarget, legacy: boolean, theme: 'dark' | 'light', interpolation = 1): void {
    if (legacy) {
      paintWorld(stripPainter(this.legacy), this.world);
      this.legacy.blit(target);
    } else {
      paintPixelWorld(new NativePixelCanvas(target), this.world,
        { view: target.rows <= 2 ? 'micro' : 'expanded', interpolation, theme }, this.previous);
    }
  }
}
