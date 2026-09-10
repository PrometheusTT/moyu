import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { SignalTail } from '../bridge/signal.ts';
import { World, type Intent } from '../core/world.ts';
import { segments } from '../core/stick.ts';
import { paintWorld } from '../render/scene.ts';
import { stripPainter } from '../render/painter.ts';
import type { PixelTarget } from '../render/target.ts';
import { LogicalCanvas } from './canvas.ts';
import { drawMicroFighter } from './micro-sprites.ts';
import { NativePixelCanvas } from './pixel-canvas.ts';
import { paintPixelWorld, snapshotFighters, type FighterSnapshots } from '../render/pixel-scene.ts';
import type { GameCanvas, GameContext, GameInput, GameInstance, GameManifest, GameModule, HostEvent, PixelCanvas, PixelRenderContext } from './types.ts';

const EMPTY_INPUT: GameInput = { left: false, right: false, up: false, down: false, jump: false, primary: false, secondary: false };
const BG = 0x090a0e, GRID = 0x151722, INK = 0xecf0f8, ACCENT = 0xe43834, AMBER = 0xa67c00;

class InputLatch {
  private leftUntil = 0; private rightUntil = 0; private downUntil = 0;
  private lastHorizontal: -1 | 1 = 1;
  private up = false; private jump = false; private primary = false; private secondary = false;
  feed(bytes: Uint8Array, now: number): 'leave' | 'next' | 'help' | 'view' | 'play' | null {
    let played = false;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b === 0x71) return 'leave';
      if (b === 0x09) return 'next';
      if (b === 0x3f) return 'help';
      if (b === 0x65 || b === 0x45) return 'view';
      if (b === 0x1b && (bytes[i + 1] === 0x5b || bytes[i + 1] === 0x4f)) {
        let j = i + 2;
        while (j < bytes.length && !(bytes[j]! >= 0x40 && bytes[j]! <= 0x7e)) j++;
        const f = bytes[j];
        if (f !== undefined && f >= 0x41 && f <= 0x44) played = true;
        if (f === 0x41) this.up = true;
        else if (f === 0x42) this.downUntil = now + 150;
        else if (f === 0x43) { this.rightUntil = now + 150; this.lastHorizontal = 1; }
        else if (f === 0x44) { this.leftUntil = now + 150; this.lastHorizontal = -1; }
        i = j;
        continue;
      }
      if (b === 0x61 || b === 0x68) { this.leftUntil = now + 180; this.lastHorizontal = -1; }
      else if (b === 0x64 || b === 0x6c) { this.rightUntil = now + 180; this.lastHorizontal = 1; }
      else if (b === 0x73) this.downUntil = now + 180;
      else if (b === 0x77 || b === 0x6b) this.up = true;
      else if (b === 0x20) this.jump = true;
      else if (b === 0x6a || b === 0x66 || b === 0x3b) this.primary = true;
      else if (b === 0x75) this.secondary = true;
      if ('ahdlswkjf;u '.includes(String.fromCharCode(b))) played = true;
    }
    return played ? 'play' : null;
  }
  take(now: number): GameInput {
    let left = now < this.leftUntil;
    let right = now < this.rightUntil;
    if (left && right) {
      left = this.lastHorizontal === -1;
      right = this.lastHorizontal === 1;
    }
    const out = { left, right, up: this.up,
      down: now < this.downUntil, jump: this.jump, primary: this.primary, secondary: this.secondary };
    this.up = this.jump = this.primary = this.secondary = false;
    return out;
  }
  clear(): void {
    this.leftUntil = this.rightUntil = this.downUntil = 0;
    this.up = this.jump = this.primary = this.secondary = false;
  }
}

class StickGame implements GameInstance {
  private readonly world = new World(0x5eed);
  private previous: FighterSnapshots = new Map();
  constructor() { this.world.resize(180, 44); this.world.enemyLimit = 3; }
  update(dt: number, input: GameInput): void {
    this.previous = snapshotFighters(this.world);
    const intent: Intent = { move: input.left === input.right ? 0 : input.left ? -1 : 1,
      jump: input.jump || input.up, slash: input.primary };
    this.world.step(dt, intent);
    if (process.env.MOYU_REDUCE_MOTION === '1') {
      this.world.shake = 0;
      this.world.shakeX = 0;
      this.world.shakeY = 0;
      this.world.flash = 0;
    }
  }
  render(canvas: GameCanvas): void {
    if (!(canvas instanceof LogicalCanvas)) return;
    paintWorld(stripPainter(canvas), this.world);
  }
  renderPixels(canvas: PixelCanvas, context: PixelRenderContext): void {
    paintPixelWorld(canvas, this.world, context, this.previous);
  }
  renderMicro(c: GameCanvas): void {
    c.clear(BG);
    // 64/180 maps the 29.9-world-unit attack reach to the sprite's 11-pixel blade tip.
    const px = (x: number): number => 8 + (x / this.world.w) * (c.width - 16);
    const enemies = this.world.enemies;
    for (const f of enemies) {
      const x = px(f.x);
      drawMicroFighter(c, f, x, 0xb37b58, AMBER);
    }
    const playerX = px(this.world.player.x);
    if (this.world.respawn <= 0) drawMicroFighter(c, this.world.player, playerX, INK, AMBER,
      Math.min(1, (this.world.ground - this.world.player.y) / 10));
    else { c.line(playerX - 3, 7, playerX + 3, 7, ACCENT); }

    // 命中停顿本来就是手感最重的一帧；在微型画面里给刀尖三粒红色火花，
    // 比把血和断肢全部缩进来更清楚，也不会让待机画面变成噪点。
    if (this.world.hitstop > 0) {
      const x = Math.round(px(this.world.player.x) + this.world.player.face * 11);
      c.pixel(x, 1, ACCENT); c.pixel(x + this.world.player.face, 2, ACCENT); c.pixel(x, 3, ACCENT);
    }
  }
  onHostEvent(event: HostEvent): void {
    if (event === 'task-start') this.world.taskStart();
    else if (event === 'task-done') this.world.taskDone();
    this.previous = new Map();
  }
  renderExpanded(c: GameCanvas): void {
    c.clear(BG);
    const scale = c.width / this.world.w;
    const ground = c.height - 3;
    const verticalScale = Math.min(scale, ground / this.world.ground);
    for (const f of [...this.world.enemies, ...(this.world.respawn > 0 ? [] : [this.world.player])]) {
      const color = f === this.world.player ? (f.hurt > 0 ? ACCENT : INK) : f.windup >= 0 ? ACCENT : 0xb37b58;
      const body = { ...f, x: f.x * scale, y: ground - (this.world.ground - f.y) * verticalScale, h: f.h * verticalScale };
      for (const s of segments(body)) {
        if (s.part === 'head') c.rect(Math.round(s.x0 - 1), Math.round(s.y0 - 1), 2, 2, color);
        else c.line(s.x0, s.y0, s.x1, s.y1, s.part === 'blade' ? AMBER : color);
      }
    }
    if (this.world.respawn > 0) c.line(this.world.player.x * scale - 3, ground, this.world.player.x * scale + 3, ground, ACCENT);
    if (this.world.hitstop > 0 && this.world.player.atk >= 0) {
      const x = (this.world.player.x + this.world.player.face * this.world.fh * 1.15) * scale;
      c.line(x, ground - 8, x, ground - 6, ACCENT);
    }
  }
  serialize(): unknown { return { kills: this.world.kills, bestCombo: this.world.bestCombo }; }
  restore(state: unknown): void {
    if (typeof state !== 'object' || state === null) return;
    const s = state as Record<string, unknown>;
    if (typeof s.kills === 'number') this.world.kills = s.kills;
    if (typeof s.bestCombo === 'number') this.world.bestCombo = s.bestCombo;
  }
  hud(): string { return `火柴快斩 ${this.world.kills}击破 ${this.world.respawn > 0 ? '重生中' : `血${this.world.player.hp}/4`}`; }
}

class SnakeGame implements GameInstance {
  // 微型屏上直接玩的 24×8 棋盘。旧版内部是 24×16 再压到 7 行，转弯时相邻
  // 两节经常量化到同一格，看起来像蛇突然断掉；8 行让操作与画面一一对应。
  private body: Array<[number, number]> = [[8, 4], [7, 4], [6, 4], [5, 4], [4, 4]];
  private food: [number, number] = [17, 4];
  private dir: [number, number] = [1, 0];
  private pendingDir: [number, number] | null = null;
  private acc = 0; private score = 0; private best = 0; private seed = 7;
  private rand(): number { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 0x100000000; }
  update(dt: number, input: GameInput): void {
    if (this.pendingDir === null) {
      if ((input.up || input.jump) && this.dir[0] !== 0) this.pendingDir = [0, -1];
      else if (input.down && this.dir[0] !== 0) this.pendingDir = [0, 1];
      else if (input.left && this.dir[1] !== 0) this.pendingDir = [-1, 0];
      else if (input.right && this.dir[1] !== 0) this.pendingDir = [1, 0];
    }
    this.acc += dt;
    if (this.acc < Math.max(0.06, 0.14 - this.score * 0.002)) return;
    this.acc = 0;
    if (this.pendingDir !== null) { this.dir = this.pendingDir; this.pendingDir = null; }
    const head = this.body[0]!;
    const next: [number, number] = [(head[0] + this.dir[0] + 24) % 24, (head[1] + this.dir[1] + 8) % 8];
    if (this.body.some(([x, y]) => x === next[0] && y === next[1])) { this.reset(); return; }
    this.body.unshift(next);
    if (next[0] === this.food[0] && next[1] === this.food[1]) {
      this.score++; this.best = Math.max(this.best, this.score); this.placeFood();
    } else this.body.pop();
  }
  private reset(): void {
    this.body = [[8, 4], [7, 4], [6, 4], [5, 4], [4, 4]];
    this.dir = [1, 0]; this.pendingDir = null; this.score = 0;
  }
  private placeFood(): void {
    for (let n = 0; n < 100; n++) {
      const p: [number, number] = [Math.floor(this.rand() * 24), Math.floor(this.rand() * 8)];
      if (!this.body.some(([x, y]) => x === p[0] && y === p[1])) { this.food = p; return; }
    }
  }
  render(c: GameCanvas): void {
    c.clear(BG); c.rect(7, 3, 50, 34, GRID);
    c.rect(8 + this.food[0] * 2, 4 + this.food[1] * 4, 2, 4, ACCENT);
    for (let i = this.body.length - 1; i >= 0; i--) {
      const [x, y] = this.body[i]!; c.rect(8 + x * 2, 4 + y * 4, 2, 4, i === 0 ? AMBER : INK);
    }
  }
  renderMicro(c: GameCanvas): void {
    c.clear(BG);
    c.rect(15 + this.food[0] * 2, this.food[1], 2, 2, ACCENT);
    for (let i = this.body.length - 1; i >= 0; i--) {
      const [x, y] = this.body[i]!;
      c.rect(15 + x * 2, y, 2, 2, i === 0 ? AMBER : INK);
    }
  }
  renderExpanded(c: GameCanvas): void {
    c.clear(BG);
    c.line(14, 3, 65, 3, 0x687080); c.line(14, 20, 65, 20, 0x687080);
    c.line(14, 3, 14, 20, 0x687080); c.line(65, 3, 65, 20, 0x687080);
    c.rect(16 + this.food[0] * 2, 4 + this.food[1] * 2, 2, 2, ACCENT);
    for (let n = this.body.length - 1; n >= 0; n--) {
      const [x, y] = this.body[n]!;
      c.rect(16 + x * 2, 4 + y * 2, 2, 2, n === 0 ? AMBER : INK);
    }
  }
  serialize(): unknown { return { best: this.best }; }
  restore(v: unknown): void { if (typeof (v as { best?: unknown } | null)?.best === 'number') this.best = (v as { best: number }).best; }
  hud(): string { return `贪吃蛇 · ${this.score} · 最高 ${this.best} · Tab 换游戏`; }
}

const SHAPES = [
  [[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]],
  [[2, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
] as const;

class BlocksGame implements GameInstance {
  private board = new Uint8Array(10 * 18); private shape = 0; private rot = 0;
  private x = 3; private y = 0; private acc = 0; private score = 0; private best = 0; private seq = 1;
  private moveDirection = 0; private moveWait = 0;
  private cells(shape = this.shape, rot = this.rot, px = this.x, py = this.y): Array<[number, number]> {
    return SHAPES[shape]!.map(([ax, ay]) => {
      let x: number = ax, y: number = ay;
      if (shape !== 1) for (let r = 0; r < rot; r++) [x, y] = [(shape === 0 ? 3 : 2) - y, x];
      return [px + x, py + y];
    });
  }
  private blocked(x: number, y: number, rot = this.rot): boolean {
    return this.cells(this.shape, rot, x, y).some(([cx, cy]) => cx < 0 || cx >= 10 || cy >= 18 || (cy >= 0 && this.board[cy * 10 + cx] !== 0));
  }
  update(dt: number, i: GameInput): void {
    const direction = i.left === i.right ? 0 : i.left ? -1 : 1;
    this.moveWait -= dt;
    if (direction !== 0 && (direction !== this.moveDirection || this.moveWait <= 0)) {
      if (!this.blocked(this.x + direction, this.y)) this.x += direction;
      this.moveWait = direction !== this.moveDirection ? 0.18 : 0.09;
    }
    this.moveDirection = direction;
    if ((i.up || i.primary) && !this.blocked(this.x, this.y, (this.rot + 1) % 4)) this.rot = (this.rot + 1) % 4;
    this.acc += dt * (i.down ? 8 : 1);
    if (i.jump) while (!this.blocked(this.x, this.y + 1)) this.y++;
    if (this.acc < Math.max(0.12, 0.65 - this.score * 0.008) && !i.jump) return;
    this.acc = 0;
    if (!this.blocked(this.x, this.y + 1)) { this.y++; return; }
    for (const [x, y] of this.cells()) if (y >= 0) this.board[y * 10 + x] = this.shape + 1;
    this.clearLines(); this.spawn();
  }
  private clearLines(): void {
    for (let y = 17; y >= 0; y--) if (this.board.subarray(y * 10, y * 10 + 10).every((v) => v !== 0)) {
      this.board.copyWithin(10, 0, y * 10); this.board.fill(0, 0, 10); this.score += 10; this.best = Math.max(this.best, this.score); y++;
    }
  }
  private spawn(): void {
    this.shape = this.seq++ % SHAPES.length; this.rot = 0; this.x = 3; this.y = 0;
    if (this.blocked(this.x, this.y)) { this.board.fill(0); this.score = 0; }
  }
  render(c: GameCanvas): void {
    c.clear(BG); c.rect(20, 1, 22, 38, GRID);
    const colors = [INK, 0x59c3c3, AMBER, ACCENT, INK, AMBER, 0x59c3c3];
    for (let y = 0; y < 18; y++) for (let x = 0; x < 10; x++) {
      const v = this.board[y * 10 + x] ?? 0; if (v !== 0) c.rect(21 + x * 2, 2 + y * 2, 2, 2, colors[(v - 1) % colors.length]!);
    }
    for (const [x, y] of this.cells()) if (y >= 0) c.rect(21 + x * 2, 2 + y * 2, 2, 2, colors[this.shape]!);
  }
  renderMicro(c: GameCanvas): void {
    c.clear(BG);
    const ox = Math.floor((c.width - 22) / 2);
    c.line(ox, 0, ox, 7, GRID); c.line(ox + 21, 0, ox + 21, 7, GRID);
    const colors = [INK, 0x59c3c3, AMBER, ACCENT, INK, AMBER, 0x59c3c3];
    // 跟随活动方块的 8 行窗口。完整 18 行直接压缩会让方块只有半个点高，
    // 而局部窗口让移动、旋转、接触都保持一行一个台阶。
    const top = Math.max(0, Math.min(10, this.y - 5));
    for (let y = top; y < top + 8; y++) for (let x = 0; x < 10; x++) {
      const v = this.board[y * 10 + x] ?? 0;
      if (v !== 0) c.rect(ox + 1 + x * 2, y - top, 2, 1, colors[(v - 1) % colors.length]!);
    }
    for (const [x, y] of this.cells()) if (y >= 0) {
      if (y >= top && y < top + 8) c.rect(ox + 1 + x * 2, y - top, 2, 1, colors[this.shape]!);
    }
    // 相机跟随时活动方块会保持在画面中段；右框上的金色刻度显示它在完整 18 行里的深度。
    c.pixel(ox + 21, Math.min(7, Math.round(this.y * 7 / 17)), AMBER);
  }
  serialize(): unknown { return { best: this.best }; }
  restore(v: unknown): void { if (typeof (v as { best?: unknown } | null)?.best === 'number') this.best = (v as { best: number }).best; }
  hud(): string { return `落块 · ${this.score} · 最高 ${this.best} · Tab 换游戏`; }
  renderExpanded(c: GameCanvas): void {
    c.clear(BG);
    const ox = 28, oy = 2;
    c.line(ox, oy - 1, ox, oy + 18, 0x687080);
    c.line(ox + 22, oy - 1, ox + 22, oy + 18, 0x687080);
    c.line(ox, oy + 18, ox + 22, oy + 18, 0x687080);
    let landing = this.y;
    while (!this.blocked(this.x, landing + 1)) landing++;
    for (const [x, y] of this.cells(this.shape, this.rot, this.x, landing))
      if (y >= 0) c.rect(ox + 2 + x * 2, oy + y, 2, 1, 0x687080);
    for (let y = 0; y < 18; y++) for (let x = 0; x < 10; x++)
      if (this.board[y * 10 + x]) c.rect(ox + 2 + x * 2, oy + y, 2, 1, INK);
    for (const [x, y] of this.cells()) if (y >= 0) c.rect(ox + 2 + x * 2, oy + y, 2, 1, AMBER);
  }
}

function manifest(id: string, name: string, description: string, viewport: { width: number; height: number }): GameManifest {
  return { id, name, description, viewport, microViewport: { width: 80, height: 8 }, version: '1.0.0', apiVersion: 1, author: 'Moyu', entry: 'builtin',
    display: { micro: id === 'stick-slash', minRows: id === 'stick-slash' ? 4 : 6, glyphs: id === 'stick-slash' ? 'dots' : 'blocks' },
    palette: ['#090a0e', '#ecf0f8', '#e43834', '#a67c00'],
    controls: id === 'stick-slash'
      ? [{ action: 'move', label: '移动', keys: ['A/D', '方向键'] }, { action: 'primary', label: '砍', keys: ['J'] }, { action: 'jump', label: '跳', keys: ['空格'] }]
      : id === 'snake' ? [{ action: 'move', label: '方向', keys: ['WASD', '方向键'] }]
        : [{ action: 'move', label: '移动', keys: ['A/D'] }, { action: 'primary', label: '旋转', keys: ['J'] }, { action: 'down', label: '下落', keys: ['S'] }, { action: 'jump', label: '直落', keys: ['空格'] }] };
}

export const BUILTIN_GAMES: GameModule[] = [
  { manifest: manifest('stick-slash', '火柴快斩', '连续动作与打击反馈', { width: 180, height: 44 }), create: () => new StickGame() },
  { manifest: manifest('snake', '贪吃蛇', '格子移动与成长', { width: 64, height: 40 }), create: () => new SnakeGame() },
  { manifest: manifest('blocks', '落块', '旋转、下落与消行', { width: 64, height: 40 }), create: () => new BlocksGame() },
];

type CartridgeSlot = {
  module: GameModule;
  instance: GameInstance;
  canvas: LogicalCanvas;
  microCanvas: LogicalCanvas;
  expandedCanvas: LogicalCanvas;
};

const OPTIONAL_GAME_HOOKS = [
  'renderMicro', 'renderExpanded', 'renderPixels', 'onHostEvent', 'serialize', 'restore', 'hud',
] as const;

function gameInstance(value: unknown): GameInstance {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new Error('create 必须返回游戏实例');
  }
  if (value instanceof Promise) {
    void value.catch(() => { /* rejected async factories are invalid, but still observed */ });
    throw new Error('create 不能返回 Promise 或 thenable');
  }
  const candidate = value as Record<string, unknown>;
  const then = candidate.then;
  if (typeof then === 'function') throw new Error('create 不能返回 Promise 或 thenable');
  const required = (name: 'update' | 'render'): ((...args: never[]) => unknown) => {
    const method = candidate[name];
    if (typeof method !== 'function') throw new Error(`游戏实例缺少 ${name}()`);
    return method.bind(value) as (...args: never[]) => unknown;
  };
  const normalized: GameInstance = {
    update: required('update') as GameInstance['update'],
    render: required('render') as GameInstance['render'],
  };
  const hooks = normalized as unknown as Record<string, unknown>;
  for (const name of OPTIONAL_GAME_HOOKS) {
    const method = candidate[name];
    if (method === undefined) continue;
    if (typeof method !== 'function') throw new Error(`游戏实例的 ${name} 必须是函数`);
    hooks[name] = method.bind(value);
  }
  return normalized;
}

function failureMessage(value: unknown): string {
  try {
    const detail: unknown = value instanceof Error ? value.message || value.name : value;
    return String(detail) || '未知错误';
  } catch { return '未知错误'; }
}

export class Arcade {
  readonly keys = { clear: (): void => { this.input.clear(); } };
  private readonly input = new InputLatch(); private readonly tail: SignalTail;
  private readonly slots: CartridgeSlot[] = [];
  private readonly failures = new Map<string, string>();
  private active = 0; private lastMs = 0; private acc = 0; private poll = 0;
  private stepped = false;
  private paused = false; private instructions = true; private viewToggle = false;
  private displayRows = 24; private displayTier: PixelTarget['tier'] = 'braille';
  private alert: string | null = null; private urgent = false; private notice: string | null = null;
  constructor(eventsFile?: string, modules: GameModule[] = BUILTIN_GAMES, startId?: string) {
    for (const module of modules) try {
      const context: GameContext = Object.freeze({ seed: Date.now() & 0x7fffffff, random: () => Math.random() });
      const instance = gameInstance(module.create(context));
      const micro = module.manifest.microViewport ?? { width: 80, height: 8 };
      this.slots.push({
        module,
        instance,
        canvas: new LogicalCanvas(module.manifest.viewport.width, module.manifest.viewport.height),
        microCanvas: new LogicalCanvas(micro.width, micro.height),
        expandedCanvas: new LogicalCanvas(80, 24),
      });
    } catch (error) {
      this.failures.set(module.manifest.id, failureMessage(error));
    }
    const selected = startId === undefined ? -1 : this.slots.findIndex((slot) => slot.module.manifest.id === startId);
    if (selected >= 0) this.active = selected;
    this.tail = new SignalTail(eventsFile); this.loadAll();
  }
  failureFor(id: string): string | undefined { return this.failures.get(id); }
  get available(): number { return this.slots.length; }
  resize(_w: number, _h: number): void { /* logical viewports are fixed */ }
  feed(bytes: Uint8Array, now = Date.now()): boolean {
    const command = this.input.feed(bytes, now);
    if (command === 'leave') return true;
    if (command === 'next' && this.slots.length > 0) {
      this.slots[this.active]!.instance.onHostEvent?.('pause'); this.save(this.active);
      this.active = (this.active + 1) % this.slots.length; this.resetClock(); this.instructions = true;
    }
    if (command === 'help') { this.instructions = !this.instructions; this.resetClock(); }
    if (command === 'view') { this.viewToggle = true; this.input.clear(); }
    if (command === 'play' && this.playable()) this.instructions = false;
    return false;
  }
  takeViewToggle(): boolean { const value = this.viewToggle; this.viewToggle = false; return value; }
  setDisplay(rows: number, tier: PixelTarget['tier']): void {
    if (rows !== this.displayRows || tier !== this.displayTier) this.resetClock();
    this.displayRows = rows; this.displayTier = tier;
  }
  playable(): boolean {
    const slot = this.slots[this.active];
    if (slot === undefined) return false;
    const m = slot.module.manifest;
    const game = slot.instance;
    return this.displayRows <= 2
      ? m.display?.micro === true && this.displayTier !== 'half'
        && (game.renderMicro !== undefined || (this.displayTier === 'graphics' && game.renderPixels !== undefined))
      : this.displayRows >= this.minimumRows();
  }
  private minimumRows(): number {
    const rows = this.slots[this.active]?.module.manifest.display?.minRows ?? 6;
    return this.displayTier === 'half' ? rows * 2 : rows;
  }
  panel(): [string, string] {
    const slot = this.slots[this.active];
    if (slot === undefined) return ['没有可用游戏', '请检查已安装 Cartridge · Esc 返回'];
    const m = slot.module.manifest;
    if (!this.playable()) return [m.name, this.displayRows <= 2
      ? `E 展开 · 需${this.minimumRows()}行 · Esc 返回`
      : `需${this.minimumRows()}行，请放大终端或使用 moyu play · Esc 返回`];
    if (!this.instructions) return [slot.instance.hud?.() ?? m.name, 'E 大小 · ? 帮助 · Esc 返回'];
    const controls = m.controls.map((c) => `${c.keys[0] ?? ''} ${c.label}`).join(' · ');
    return [`${m.name} · ${controls}`, 'E 大小 · Tab 换 · Esc 返回'];
  }
  get showingInstructions(): boolean { return this.instructions || !this.playable(); }
  private resetClock(): void { this.lastMs = 0; this.acc = 0; this.stepped = false; this.input.clear(); }
  advance(now: number): void {
    const elapsed = this.lastMs === 0 ? 0 : Math.max(0, Math.min(0.25, (now - this.lastMs) / 1000)); this.lastMs = now;
    if (++this.poll >= 8) {
      this.poll = 0;
      for (const event of this.tail.poll()) {
        const e: HostEvent = event === 'start' ? 'task-start' : event === 'notify' ? 'task-notify' : 'task-done';
        for (const slot of this.slots) slot.instance.onHostEvent?.(e);
        if (e === 'task-done') { this.alert = ''; this.urgent = true; this.notice = '任务完成'; }
        else if (e === 'task-notify') { this.alert = ''; this.urgent = true; this.notice = '需要你确认'; }
        else { this.urgent = false; this.notice = null; }
      }
    }
    if (this.paused || this.instructions || !this.playable()) { this.acc = 0; return; }
    this.acc += elapsed;
    // 不足一个模拟步时保留脉冲。持续方向在每个子步生效，跳/攻击只消费一次。
    if (this.acc < 1 / 60) return;
    let first = this.input.take(now);
    const held = { ...EMPTY_INPUT, left: first.left, right: first.right, down: first.down };
    while (this.acc >= 1 / 60) {
      this.slots[this.active]!.instance.update(1 / 60, first);
      this.stepped = true;
      first = held; this.acc -= 1 / 60;
    }
  }
  render(target: PixelTarget, profile: 'standard' | 'micro' = 'standard'): void {
    const slot = this.slots[this.active];
    if (slot === undefined) { target.fill(BG); return; }
    const game = slot.instance;
    target.setGlyphStyle?.(slot.module.manifest.display?.glyphs ?? 'blocks');
    if (profile === 'micro' && !this.playable()) { target.fill(BG); return; }
    if (target.tier === 'graphics' && game.renderPixels !== undefined) {
      game.renderPixels(new NativePixelCanvas(target), {
        view: profile === 'micro' ? 'micro' : 'expanded',
        interpolation: this.paused || this.instructions || !this.stepped ? 1 : Math.max(0, Math.min(1, this.acc * 60)),
        theme: process.env.MOYU_THEME === 'light' ? 'light' : 'dark',
      });
      return;
    }
    if (profile === 'standard' && target.tier !== 'graphics' && game.renderExpanded !== undefined) {
      const height = Math.max(8, Math.min(24, target.pixelH));
      if (slot.expandedCanvas.height !== height) slot.expandedCanvas = new LogicalCanvas(80, height);
      const canvas = slot.expandedCanvas; game.renderExpanded(canvas); canvas.blit(target); return;
    }
    const micro = profile === 'micro' && target.tier !== 'graphics' && game.renderMicro !== undefined;
    const canvas = micro ? slot.microCanvas : slot.canvas;
    if (micro) game.renderMicro!(canvas); else game.render(canvas);
    canvas.blit(target);
  }
  takeAlert(): string | null { const a = this.alert; this.alert = null; if (a !== null) this.save(this.active); return a; }
  hud(): { left: string; right: string; short: string; urgent: boolean } {
    const slot = this.slots[this.active];
    if (slot === undefined) {
      const short = this.notice ?? '没有可用游戏';
      return { left: short, right: 'Ctrl+] / Esc 返回', short, urgent: this.urgent };
    }
    const game = slot.instance, name = slot.module.manifest.name;
    const line = game.hud?.() ?? `${name} · Tab 换游戏`;
    const short = this.notice === null ? line : `${this.notice} · ${name}`;
    return { left: short, right: 'Ctrl+] / Esc 返回', short, urgent: this.urgent };
  }
  private stateFile(index: number): string { return path.join(process.env.MOYU_HOME ?? path.join(homedir(), '.moyu'), 'state', `${this.slots[index]!.module.manifest.id}.json`); }
  pause(): void {
    this.paused = true; this.resetClock();
    const game = this.slots[this.active]?.instance;
    if (game !== undefined) { this.save(this.active); game.onHostEvent?.('pause'); }
  }
  resume(): void {
    this.paused = false; this.resetClock(); this.instructions = true; this.urgent = false; this.notice = null;
    this.slots[this.active]?.instance.onHostEvent?.('resume');
  }
  private loadAll(): void {
    for (let i = 0; i < this.slots.length; i++) try {
      const value: unknown = JSON.parse(fs.readFileSync(this.stateFile(i), 'utf8')); this.slots[i]!.instance.restore?.(value);
    } catch { /* first run or damaged save: start clean */ }
  }
  private save(index: number): void {
    const slot = this.slots[index];
    if (slot === undefined) return;
    try {
      const value = slot.instance.serialize?.(); if (value === undefined) return;
      const file = this.stateFile(index); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    } catch { /* play must not depend on persistence */ }
  }
}
