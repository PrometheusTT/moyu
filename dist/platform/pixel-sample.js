import { World } from "../core/world.js";
import { paintWorld } from "../render/scene.js";
import { stripPainter } from "../render/painter.js";
import { paintPixelWorld, snapshotFighters } from "../render/pixel-scene.js";
import { LogicalCanvas } from "./canvas.js";
import { NativePixelCanvas } from "./pixel-canvas.js";
/** Deterministic, shared simulation for native-terminal A/B and offline pixel exports. No saves. */
export class PixelSample {
    world;
    previous = new Map();
    legacy = new LogicalCanvas(180, 44);
    frame = 0;
    constructor() { this.world = this.makeWorld(); }
    makeWorld() {
        const world = new World(0x5eed);
        world.resize(180, 44);
        world.enemyLimit = 3;
        world.taskStart();
        return world;
    }
    reset() { this.world = this.makeWorld(); this.previous = new Map(); this.frame = 0; }
    step() {
        if (this.frame >= 720)
            this.reset();
        this.previous = snapshotFighters(this.world);
        const f = this.frame++;
        this.world.step(1 / 60, {
            move: f < 60 ? 0 : Math.floor((f - 60) / 90) % 2 === 0 ? 1 : -1,
            jump: f === 150 || f === 420,
            slash: f === 60 || f === 240 || f === 300 || f === 480 || f === 540 || f === 600,
        });
    }
    render(target, legacy, theme, interpolation = 1) {
        if (legacy) {
            paintWorld(stripPainter(this.legacy), this.world);
            this.legacy.blit(target);
        }
        else {
            paintPixelWorld(new NativePixelCanvas(target), this.world, { view: target.rows <= 2 ? 'micro' : 'expanded', interpolation, theme }, this.previous);
        }
    }
}
