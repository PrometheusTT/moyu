import { DirectionHold } from '../input/keys.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { SignalTail } from '../bridge/signal.ts';
import { Rng } from '../core/rng.ts';
import { World, bossPhase, BOSS_NAMES, bossAbilities, type Intent, type Piece, type EnemyTag } from '../core/world.ts';
import { ChapterDirector, parseChapterCheckpoint } from '../core/chapter.ts';
import { fighterSegments } from '../core/creature.ts';
import { heroHat } from '../core/stick.ts';
import { MAX_QI, BOSS_HIT_QI, SWORD_ARTS, SWORD_FORMS, FULL_ART_NAMES, parseFormProgress, selectSwordForm, currentSwordForm,
  ART_IDS, isSecretArt, artLevel, freshCultivation, parseCultivation, playerGrowth, type SwordArt } from '../core/martial.ts';
import { paintLandmark, paintSwordArt, paintBossPressure, type ArtPen } from '../render/wuxia.ts';
import { wrapWidth, clipWidth } from '../render/text.ts';
import { paintWorld } from '../render/scene.ts';
import { sceneForChapter, type SceneTheme } from '../render/theme.ts';
import { stripPainter } from '../render/painter.ts';
import type { PixelTarget } from '../render/target.ts';
import { LogicalCanvas } from './canvas.ts';
import { drawMicroFighter } from './micro-sprites.ts';
import { NativePixelCanvas } from './pixel-canvas.ts';
import { paintPixelWorld, snapshotFighters, type FighterSnapshots } from '../render/pixel-scene.ts';
import { isEnglish, uiName, artName, formName, fullArtName, chapterName, chapterStory, englishBattleNotice } from '../i18n.ts';
import type { GameCanvas, GameContext, GameInput, GameInstance, GameManifest, GameModule, HostEvent, PixelCanvas, PixelRenderContext } from './types.ts';

const EMPTY_INPUT: GameInput = { left: false, right: false, up: false, down: false, jump: false, primary: false, secondary: false, special: false };
const BG = 0x090a0e, GRID = 0x151722, INK = 0xecf0f8, ACCENT = 0xe43834, AMBER = 0xa67c00;
// 展开 braille 的战斗残留配色：暗红血迹、瘫地断肢的灰、杂兵碎块的棕。
const STAIN = 0x68121a, DEAD = 0x5c5f6c, FOE = 0xb37b58;
// 敌人变种本色：快刀手偏亮、重甲偏暗、boss 深红；其余走 FOE。
const FOE_RUNNER = 0xd8b48a, FOE_BRUTE = 0x7a5236, FOE_BOSS = 0xc0473a;

/** 格子从左到右恢复；数字补足临界时刻的信息，0 秒才显示就绪。 */
function cooldownTrack(remaining: number, total: number, cells: number): string {
  const left = Math.max(0, Number.isFinite(remaining) ? remaining : 0);
  const count = Math.max(1, Math.floor(cells));
  const filled = left <= 0 ? count : Math.min(count - 1, Math.max(0, Math.floor((1 - left / Math.max(total, 0.01)) * count)));
  return `[${'█'.repeat(filled)}${'░'.repeat(count - filled)}]`;
}
export function cooldownBar(remaining: number, total: number, cells = 4): string {
  const left = Math.max(0, Number.isFinite(remaining) ? remaining : 0);
  const seconds = Math.ceil(left * 10 - 1e-9) / 10;
  return `${cooldownTrack(left, total, cells)}${left <= 0 ? isEnglish() ? 'Ready' : '就绪' : `${Math.max(0.1, seconds).toFixed(1)}${isEnglish() ? 's' : '秒'}`}`;
}

/** 字符档下按变种取本色（图形/braille 档在各自渲染器里用调色板混色）。导出供渲染回归测试锁定区分度。 */
export function foeColor(tag: EnemyTag | undefined): number {
  return tag === 'boss' ? FOE_BOSS : tag === 'brute' ? FOE_BRUTE : tag === 'runner' ? FOE_RUNNER : FOE;
}

/** 两个 0xRRGGBB 按 k 线性插值。给展开档的章节布景上色用（其余档在各自渲染器里混）。 */
function mixRgb(a: number, b: number, k: number): number {
  const t = k <= 0 ? 0 : k >= 1 ? 1 : k;
  const r = Math.round(((a >>> 16) & 255) * (1 - t) + ((b >>> 16) & 255) * t);
  const g = Math.round(((a >>> 8) & 255) * (1 - t) + ((b >>> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

function canvasPen(c: GameCanvas, x: (n: number) => number, y: (n: number) => number): ArtPen {
  return {
    line: (a, b, d, e, color) => c.line(x(a), y(b), x(d), y(e), color),
    rect: (a, b, w, h, color) => c.rect(x(a), y(b), x(a + w) - x(a), y(b + h) - y(b), color),
    circle: (a, b, r, color) => {
      for (let row = -r; row <= r; row += Math.max(0.3, r / 8)) {
        const half = Math.sqrt(Math.max(0, r * r - row * row));
        c.line(x(a - half), y(b + row), x(a + half), y(b + row), color);
      }
    },
  };
}

/**
 * 通关金色冲击波：章节 settle 后由 `clearPulse`(1→0) 驱动，给"打完一关"一记看得见的节拍。
 * 高画布（展开/图形档）扩散两道亮环 + 几点上升金火星；矮画布（micro 两行条）改成从中心
 * 向两边推开的亮柱扫光。纯渲染、只在结算屏（result!==null）出现——裸 World 的字节/可读性
 * 测试没有 director/pulse，走不到这条路径；只用 line/pixel，`GameCanvas`/`PixelCanvas` 通用。
 */
function paintClearBurst(c: GameCanvas, pulse: number): void {
  if (pulse <= 0) return;
  const t = pulse <= 1 ? pulse : 1;
  const progress = 1 - t;               // 0（刚过关）→ 1（散尽）
  const bright = Math.pow(t, 0.6);      // 越扩越淡
  if (c.height < 12) {
    // 矮条：中心向两边推开的一对亮柱 + 顶行金色薄扫。
    const cx = c.width / 2;
    const spread = progress * (c.width / 2 + 2);
    const color = mixRgb(AMBER, INK, bright);
    for (const s of [-1, 1] as const) {
      const bx = Math.round(cx + s * spread);
      if (bx >= 0 && bx < c.width) c.line(bx, 0, bx, c.height - 1, color);
    }
    if (bright > 0.2) for (let x = 0; x < c.width; x++) c.pixel(x, 0, mixRgb(AMBER, INK, bright * 0.5));
    return;
  }
  const cx = c.width / 2, cy = c.height * 0.46;
  const maxR = Math.max(c.width, c.height) * 0.62;
  for (const [rf, wf] of [[1, 1], [0.62, 0.6]] as const) {
    const r = (0.12 + 0.88 * progress) * maxR * rf;
    if (r < 1) continue;
    const color = mixRgb(AMBER, INK, bright * wf);
    const steps = Math.max(12, Math.round(r * 0.8));
    let px = cx + r, py = cy;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const nx = cx + Math.cos(a) * r, ny = cy + Math.sin(a) * r * 0.9;
      c.line(px, py, nx, ny, color);
      px = nx; py = ny;
    }
  }
  if (bright > 0.15) {
    const embers = Math.max(5, Math.round(c.width / 12));
    for (let i = 0; i < embers; i++) {
      const phase = ((i * 7) % embers) / embers;   // 打散，不排成一条线
      const ex = (i + 0.5) / embers * c.width;
      const ey = c.height * (0.92 - (progress + phase * 0.3) * 0.85);
      if (ey >= 0) c.pixel(Math.round(ex), Math.round(ey), mixRgb(AMBER, INK, bright));
    }
  }
}

const HOST_POLL_MS = 100;

export type ArcadeStatus = 'idle' | 'task-done' | 'needs-input';
export type ArcadeAction = 'return-to-cli';

class InputLatch {
  private sequence: Array<{ key: string; at: number; face: -1 | 1 }> = [];
  private pendingArt: SwordArt | undefined;
  private pendingArtFace: -1 | 1 | undefined;
  private armor = false;
  private readonly directionHold = new DirectionHold();
  private record(key: string, now: number): void {
    if (!'ASD'.includes(key)) this.directionHold.interrupt();
    this.sequence = this.sequence.filter(item => now - item.at <= 650 && now >= item.at);
    if ('WASD'.includes(key)) {
      if (this.sequence.at(-1)?.key !== key) this.sequence.push({ key, at: now, face: this.lastHorizontal });
      this.sequence = this.sequence.slice(-2);
    } else {
      const combo = [...this.sequence.map(item => item.key), key].join('>');
      const art = ART_IDS.find(art => SWORD_ARTS[art].keys === combo);
      if (!this.pendingArt && art) {
        this.pendingArt = art;
        this.pendingArtFace = this.sequence[0]!.face;
        // A/D inside a completed command name must not force its aim or leave a walk latch.
        this.leftUntil = this.rightUntil = 0;
        this.lastHorizontal = this.pendingArtFace;
      }
      this.sequence = [];
    }
  }
  private upUntil = 0;
  private escape: 'ground' | 'esc' | 'seq' | 'str' = 'ground';
  private leftUntil = 0; private rightUntil = 0; private downUntil = 0;
  private lastHorizontal: -1 | 1 = 1;
  private up = false; private jump = false; private primary = false; private secondary = false; private special = false;
  private hold(key: 'left' | 'right' | 'down', until: number, now: number): number {
    if (key === 'down') {
      this.directionHold.interrupt();
      return now + (now < until ? 150 : 340);
    }
    if (key === 'left') this.rightUntil = 0;
    if (key === 'right') this.leftUntil = 0;
    return this.directionHold.press(key, until, now);
  }
  feed(bytes: Uint8Array, now: number, armorEnabled = false): 'leave' | 'next' | 'help' | 'view' | 'play' | 'page-prev' | 'page-next' | null {
    let played = false;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (this.escape === 'str') {
        if (b === 7) this.escape = 'ground';
        else if (b === 27) this.escape = 'esc';
        continue;
      }
      if (this.escape === 'seq') {
        if (b >= 0x40 && b <= 0x7e) {
          this.escape = 'ground';
          if (b === 0x41) { this.up = true; this.upUntil = now + 340; }
          else if (b === 0x42) this.downUntil = this.hold('down', this.downUntil, now);
          else if (b === 0x43) { this.rightUntil = this.hold('right', this.rightUntil, now); this.lastHorizontal = 1; }
          else if (b === 0x44) { this.leftUntil = this.hold('left', this.leftUntil, now); this.lastHorizontal = -1; }
          if (b >= 0x41 && b <= 0x44) { played = true; this.record('WSDA'[b - 0x41]!, now); }
        } else if (b === 27) this.escape = 'esc';
        continue;
      }
      if (this.escape === 'esc') {
        this.escape = b === 0x5b || b === 0x4f ? 'seq'
          : [0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(b) ? 'str' : 'ground';
        continue;
      }
      if (b === 27) { this.escape = 'esc'; continue; }
      if (b === 0x71) return 'leave';
      if (b === 0x09) return 'next';
      if (b === 0x3f) return 'help';
      if (b === 0x5b) return 'page-prev';
      if (b === 0x5d) return 'page-next';
      if (b === 0x65 || b === 0x45) return 'view';
      const last = this.sequence.at(-1);
      if (armorEnabled && b === 0x6b && last?.key === 'S' && now >= last.at && now - last.at <= 340) {
        this.armor = true;
        this.sequence = []; this.downUntil = this.upUntil = 0;
        this.up = this.jump = false;
        this.directionHold.interrupt(); played = true;
        continue;
      }
      if (b === 0x61 || b === 0x68) { this.leftUntil = this.hold('left', this.leftUntil, now); this.lastHorizontal = -1; }
      else if (b === 0x64 || b === 0x6c) { this.rightUntil = this.hold('right', this.rightUntil, now); this.lastHorizontal = 1; }
      else if (b === 0x73) this.downUntil = this.hold('down', this.downUntil, now);
      else if (b === 0x77 || b === 0x6b) { this.up = true; this.upUntil = now + 340; }
      else if (b === 0x20) { this.jump = true; this.directionHold.interrupt(); }
      else if (b === 0x6a || b === 0x66 || b === 0x3b) this.primary = true;
      else if (b === 0x75) this.secondary = true;
      else if (b === 0x69) this.special = true;
      const key = ({ a: 'A', h: 'A', d: 'D', l: 'D', s: 'S', w: 'W', k: 'W', j: 'J', f: 'J', ';': 'J', u: 'U', i: 'I' } as Record<string, string>)[String.fromCharCode(b)];
      if (key) this.record(key, now);
      if ('ahdlswkjf;ui '.includes(String.fromCharCode(b))) played = true;
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
    const art: SwordArt | undefined = this.pendingArt ?? (this.secondary && now < this.downUntil ? 'dugu'
      : this.special && now < this.downUntil ? 'liumai'
        : this.special && now < this.upUntil ? 'taiji' : undefined);
    const artFace = this.pendingArtFace;
    this.pendingArt = undefined; this.pendingArtFace = undefined;
    const armor = this.armor; this.armor = false;
    const out = { left, right, up: this.up, ...(armor ? { armor: true } : {}),
      down: now < this.downUntil, jump: this.jump, primary: this.primary, secondary: this.secondary, special: this.special };
    this.up = this.jump = this.primary = this.secondary = this.special = false;
    return art ? { ...out, art, ...(artFace === undefined ? {} : { artFace }) } : out;
  }
  clear(): void {
    this.sequence = []; this.pendingArt = undefined; this.pendingArtFace = undefined;
    this.armor = false;
    this.directionHold.interrupt();
    this.leftUntil = this.rightUntil = this.downUntil = 0;
    this.upUntil = 0;
    this.escape = 'ground';
    this.up = this.jump = this.primary = this.secondary = this.special = false;
  }
}

class StickGame implements GameInstance {
  private readonly world: World;
  private readonly director: ChapterDirector;
  private previous: FighterSnapshots = new Map();
  private scratch: FighterSnapshots = new Map();
  // 技能就绪脉冲：这些是渲染态、不进 world 快照，所以不扰动 world.test 的重放/确定性。
  private prevDashCool = 0;
  private prevSpinCool = 0;
  private readyPulse = 0;
  // 通关演出：章节 settle（result 从 null 翻成非空）的那一刻起一个 1→0 的脉冲，
  // 在三档渲染里画一记金色冲击波。同样是纯渲染态、不进 world 快照。
  private clearPulse = 0;
  private intermission = 0;
  constructor(seed: number) {
    this.world = new World(seed, { automaticSpawns: false });
    this.world.resize(180, 44);
    this.world.enemyLimit = 3;
    this.director = new ChapterDirector(seed);
    this.director.start(this.world);
  }
  configureViewport(width: number, height: number, tier: PixelTarget['tier']): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    // 与实际渲染高度一致；不封顶世界宽度，否则像素条两端仍是无法到达的空白。
    const viewHeight = tier === 'graphics' ? height : Math.min(24, height);
    const arena = tier !== 'graphics' && height <= 8 ? 90
      : Math.max(90, width * (this.world.h + 4) / viewHeight);
    if (arena === this.world.w) return;
    this.world.resizeArena(arena);
    this.previous.clear(); this.scratch.clear();
  }
  update(dt: number, input: GameInput): void {
    const previous = this.previous;
    this.previous = snapshotFighters(this.world, this.scratch);
    this.scratch = previous;
    const art = input.art ?? (input.down && input.secondary ? 'dugu'
      : input.down && input.special ? 'liumai' : input.up && input.special ? 'taiji' : undefined);
    const intent: Intent = { move: input.left === input.right ? 0 : input.left ? -1 : 1,
      jump: !art && (input.jump || input.up), slash: !art && input.primary,
      dash: !art && input.secondary === true, spin: !art && input.special === true, art, artFace: input.artFace,
      crouch: input.down === true };
    if (input.armor) intent.armor = true;
    this.world.enemyLimit = Math.min(6, 3 + Math.floor((this.director.chapter - 1) / 9));
    // 结算短暂停留后继续无尽关卡；J 可跳过停留，任务暂停仍由宿主控制。
    if (this.director.result !== null && this.world.phase === 'fight') this.intermission += dt;
    if (this.director.result !== null && (input.primary || this.intermission >= 1.4)
      && this.director.nextChapter(this.world)) {
      this.intermission = 0;
      this.clearPulse = 0;   // 翻页即收起上一关的通关冲击波，别糊进下一章开局。
      this.reduceMotion();
      return;
    }
    const settledBefore = this.director.result !== null;
    this.director.step(this.world, dt, intent);
    // 这一步刚把本章 settle → 点亮通关冲击波；否则按 dt 衰减（result 态下 world 不再步进，
    // 靠这里自行退火）。1.1s 够读一记"过关"，又不至于糊到玩家按 J 之后。
    if (!settledBefore && this.director.result !== null) this.clearPulse = 1;
    else this.clearPulse = Math.max(0, this.clearPulse - dt / 1.1);
    // 冷却跨过 0 的那一刻（>0 → <=0）起 0.25s 就绪脉冲；否则按 dt 衰减。
    const p = this.world.player;
    const crossed = (this.prevDashCool > 0 && p.dashCool <= 0) || (this.prevSpinCool > 0 && p.spinCool <= 0);
    this.readyPulse = crossed ? 0.25 : Math.max(0, this.readyPulse - dt);
    this.prevDashCool = p.dashCool;
    this.prevSpinCool = p.spinCool;
    this.reduceMotion();
  }
  private reduceMotion(): void {
    if (process.env.MOYU_REDUCE_MOTION === '1') {
      this.world.shake = 0;
      this.world.shakeX = 0;
      this.world.shakeY = 0;
      this.world.flash = 0;
      this.clearPulse = 0;   // 通关冲击波也是"动"，减动模式下一并按下。
    }
  }
  /** 当前章的氛围主题：把剧情落到画面（背景色 + 静态剪影布景）。 */
  private scene(): SceneTheme {
    return sceneForChapter(this.director.chapter);
  }
  render(canvas: GameCanvas): void {
    if (!(canvas instanceof LogicalCanvas)) return;
    paintWorld(stripPainter(canvas), this.world, this.scene());
  }
  renderPixels(canvas: PixelCanvas, context: PixelRenderContext): void {
    paintPixelWorld(canvas, this.world, context, this.previous, this.director.result !== null, this.scene());
    paintClearBurst(canvas, this.clearPulse);
  }
  renderMicro(c: GameCanvas): void {
    c.clear(BG);
    // 64/180 maps the 29.9-world-unit attack reach to the sprite's 11-pixel blade tip.
    const px = (x: number): number => 8 + (x / this.world.w) * (c.width - 16);
    const pen = canvasPen(c, px, y => y / this.world.ground * 7);
    const scene = this.scene();
    const backdrop = canvasPen(c, x => x * 7 / this.world.ground, y => y * 7 / this.world.ground);
    paintLandmark(backdrop, c.width * this.world.ground / 7, this.world.ground,
      { ...scene, groundTint: scene.skyTint, foeTint: scene.skyTint });
    const enemies = this.world.enemies;
    for (const f of enemies) {
      const x = px(f.x);
      drawMicroFighter(c, f, x, f.duelist ? f.duelist === 'qingfeng' ? 0x7dcac8 : 0xb29aca : foeColor(f.tag), AMBER);
    }
    const playerX = px(this.world.player.x);
    if (this.world.respawn <= 0) drawMicroFighter(c, this.world.player, playerX, (this.world.player.armorT ?? 0) > 0 ? 0xffd66b : INK, AMBER,
      Math.min(1, (this.world.ground - this.world.player.y) / 10));
    else { c.line(playerX - 3, 7, playerX + 3, 7, ACCENT); }

    // 命中停顿本来就是手感最重的一帧；在微型画面里给刀尖三粒红色火花，
    // 比把血和断肢全部缩进来更清楚，也不会让待机画面变成噪点。
    if (this.world.hitstop > 0) {
      const x = Math.round(px(this.world.player.x) + this.world.player.face * 11);
      c.pixel(x, 1, ACCENT); c.pixel(x + this.world.player.face, 2, ACCENT); c.pixel(x, 3, ACCENT);
    }
    paintSwordArt(pen, this.world.swordCast, this.world.fh);
    paintBossPressure(pen, this.world, false);
    paintClearBurst(c, this.clearPulse);
  }
  onHostEvent(event: HostEvent): void {
    if (event === 'task-start' && this.world.phase !== 'fight') this.world.taskStart();
    else if (event === 'task-done') this.world.taskDone();
    this.previous.clear();
    this.scratch.clear();
  }
  renderExpanded(c: GameCanvas): void {
    const w = this.world;
    c.clear(BG);
    const scale = c.width / w.w;
    const ground = c.height - 3;
    const verticalScale = Math.min(scale, ground / w.ground);
    // 屏幕震动整场一起抖 —— 命中的"咚"一半靠它。竖直分量本就被 world 夹得很小。
    const dx = w.shakeX;
    const dy = w.shakeY;
    const px = (x: number): number => (x + dx) * scale;
    const py = (y: number): number => ground - (w.ground - (y + dy)) * verticalScale;

    // 每章静态剪影布景，垫在最底（人身后）—— 把剧情落到画面。混向 BG 保持暗，不抢主体。
    const scene = this.scene();
    const pen = canvasPen(c, px, py);
    paintLandmark(pen, w.w, w.ground, scene);
    for (const prop of scene.landmark ? [] : scene.props) {
      const color = mixRgb(BG, scene.skyTint, 0.35 + prop.shade);
      const cx = px(prop.cx * w.w);
      const halfW = Math.max(1, prop.w * w.w * 0.5 * scale);
      const topY = py(w.ground - prop.top * w.ground);
      const floorY = py(w.ground);
      c.rect(Math.round(cx - halfW), Math.round(topY), Math.round(halfW * 2), Math.max(1, Math.round(floorY - topY)), color);
    }

    // 地上的血迹垫最底。
    for (const key of w.stains) c.pixel(Math.round(px(key % 4096)), Math.round(py(Math.floor(key / 4096))), STAIN);

    // 断肢：先躺平的（垫底），再飞着的。这是"砍碎"的回报，之前展开档整块丢了。
    const drawPiece = (p: Piece): void => {
      const color = p.rest ? DEAD : p.mine ? INK : FOE;
      if (p.head) { c.rect(Math.round(px(p.x) - 1), Math.round(py(p.y) - 1), 2, 2, color); return; }
      const vx = Math.cos(p.ang) * p.half;
      const vy = Math.sin(p.ang) * p.half;
      c.line(px(p.x - vx), py(p.y - vy), px(p.x + vx), py(p.y + vy), color);
    };
    for (const p of w.pieces) if (p.rest) drawPiece(p);
    for (const p of w.pieces) if (!p.rest) drawPiece(p);

    for (const f of [...w.enemies, ...(w.respawn > 0 ? [] : [w.player])]) {
      // boss 按阶段变色（暴走偏橙、困兽去饱和），其余走变种本色。
      const foe = f.duelist ? f.duelist === 'qingfeng' ? 0x7dcac8 : 0xb29aca : f.tag === 'boss'
        ? (bossPhase(f.hp, f.maxHp) === 1 ? FOE_BOSS : bossPhase(f.hp, f.maxHp) === 2 ? mixRgb(FOE_BOSS, AMBER, 0.5) : mixRgb(FOE_BOSS, DEAD, 0.45))
        : foeColor(f.tag);
      const color = f.hurt > 0 ? INK : f === w.player ? INK : f.windup >= 0 ? ACCENT : foe;
      const flash = w.hitstop > 0 && f.armed;   // 命中那几帧刀刃闪白
      const body = { ...f, x: px(f.x), y: py(f.y), h: f.h * verticalScale };
      const bodySegs = fighterSegments(body);
      for (const s of bodySegs) {
        if (s.part === 'head') c.rect(Math.round(s.x0 - 1), Math.round(s.y0 - 1), 2, 2, color);
        else c.line(s.x0, s.y0, s.x1, s.y1, s.part === 'blade' ? (flash ? INK : AMBER) : color);
      }
      // 主角身份标识：斗笠 + 红围巾（其余档位的渲染器里同款，这个档位一直缺）。
      if (f === w.player) {
        const head = bodySegs.find(s => s.part === 'head');
        if (head) for (const s of heroHat(head, body.h)) c.line(s.x0, s.y0, s.x1, s.y1, color);
        const torso = bodySegs.find(s => s.part === 'torso');
        if (torso) c.line(torso.x1, torso.y1, torso.x1 - f.face * body.h * 0.26, torso.y1 + body.h * 0.1, ACCENT);
      }
      // boss 头顶尖冠：字符档也一眼认出头目。
      if (f.tag === 'boss' && !f.duelist) {
        const topX = px(f.x), topY = py(f.y - f.h * 0.75);
        c.rect(Math.round(topX - 1), Math.round(topY - 2), 3, 1, color);
      }
    }
    if (w.respawn > 0) c.line(px(w.player.x) - 3, py(w.ground), px(w.player.x) + 3, py(w.ground), ACCENT);

    // 刀光：沿圆弧采样几段连成弧线，挥出的前半段更亮。
    for (const s of w.slashes) {
      const bright = s.life / s.max > 0.5;
      let ax = px(s.x + Math.cos(s.a0) * s.r);
      let ay = py(s.y + Math.sin(s.a0) * s.r);
      for (let i = 1; i <= 6; i++) {
        const a = s.a0 + (s.a1 - s.a0) * i / 6;
        const bx = px(s.x + Math.cos(a) * s.r);
        const by = py(s.y + Math.sin(a) * s.r);
        c.line(ax, ay, bx, by, bright ? INK : AMBER);
        ax = bx; ay = by;
      }
    }

    // 血花盖在最上，和 paintWorld 一样的层序（血是盖在刀光和身体之上的）。
    for (const b of w.blood) c.pixel(Math.round(px(b.x)), Math.round(py(b.y)), ACCENT);
    paintSwordArt(pen, w.swordCast, w.fh);
    paintBossPressure(pen, w);
    // 通关冲击波盖在最上：结算屏才亮，战斗中 clearPulse 恒 0。
    paintClearBurst(c, this.clearPulse);
  }
  serialize(): unknown {
    return { version: 2, kills: this.world.kills, bestCombo: this.world.bestCombo,
      checkpoint: this.director.checkpoint(), qi: this.world.qi,
      formProgress: structuredClone(this.world.formProgress), selectedArt: this.world.selectedArt,
      cultivation: structuredClone(this.world.cultivation) };
  }
  restore(state: unknown): void {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return;
    const s = state as Record<string, unknown>;
    const kills = savedCount(s.kills);
    const bestCombo = savedCount(s.bestCombo);
    const cultivation = s.version === 2 ? parseCultivation(s.cultivation) : freshCultivation();
    const qi = s.version === 2 ? savedCount(s.qi) : 0;
    if (cultivation === null || qi === null || qi > MAX_QI) return;
    if (s.version !== 2) cultivation.insight = kills ?? 0;
    const restoreArts = (): void => {
      this.world.cultivation = cultivation;
      this.world.refreshPlayerGrowth(true);
      this.world.qi = qi;
      this.world.formProgress = parseFormProgress(s.formProgress);
      this.world.selectedArt = ART_IDS.includes(s.selectedArt as SwordArt) ? s.selectedArt as SwordArt : 'dugu';
      this.intermission = 0;
      this.previous.clear(); this.scratch.clear();
    };
    if (s.version === 1 || s.version === 2) {
      if (kills === null || bestCombo === null) return;
      if (s.checkpoint === null) {
        if (bestCombo > kills) return;
        this.world.rng.reset(this.director.runSeed);
        this.world.kills = kills;
        this.world.bestCombo = bestCombo;
        this.director.start(this.world);
        restoreArts();
        return;
      }
      const checkpoint = parseChapterCheckpoint(s.checkpoint);
      if (checkpoint === null || kills < checkpoint.kills || bestCombo < checkpoint.bestCombo
        || bestCombo > kills) return;
      if (!this.director.restore(this.world, checkpoint)) return;
      this.world.kills = kills;
      this.world.bestCombo = bestCombo;
      restoreArts();
      return;
    }
    if (s.version !== undefined) return;
    // 旧版只保存累计战绩；继续接受它，坏字段则整份忽略。
    if (kills === null || bestCombo === null || bestCombo > kills) return;
    this.world.rng.reset(this.director.runSeed);
    this.world.kills = kills;
    this.world.bestCombo = bestCombo;
    this.director.start(this.world);
    restoreArts();
  }
  hud(): string {
    if (isEnglish()) return this.hudEnglish();
    const result = this.director.result;
    if (result !== null) {
      const checkpoint = this.director.checkpoint()!;
      // 章节完成屏是天然的剧情节拍（按 J 进下一章前）：亮出刚打完这章的标题。
      // 保留"第N章完成"连续子串，HUD 正则（arcade.test）照旧匹配；标题追加在后面。
      const title = this.director.chapterTitle();
      const story = this.director.chapterStory();
      return this.world.phase === 'fight'
        ? `第${result.chapter}章完成 · ${result.score}分 · J 下一章 / 自动继续 · 累计${checkpoint.score}分 ${checkpoint.kills}击破 连击${checkpoint.bestCombo} · 『${title}』${story}`
        : `第${result.chapter}章完成 · 『${title}』 · ${story} · ${result.score}分 · 等待下个任务`;
    }
    const p = this.world.player;
    const training = playerGrowth(this.world.cultivation.insight);
    const skills = `护体S>K${cooldownBar(p.armorCool ?? 0, training.armorCooldown)} · 冲刺U${cooldownBar(p.dashCool, 0.7 * training.skillCooldown)} · 旋斩I${cooldownBar(p.spinCool, 1.6 * training.skillCooldown)}`;
    const combo = this.world.combo >= 2 ? ` · 连击${this.world.combo}` : '';
    const pulse = this.readyPulse > 0 ? ' 就绪✦' : '';
    const life = this.world.respawn > 0 ? '重生中' : `血${p.hp}/${p.maxHp ?? 4}`;
    const w = this.world;
    const next = ART_IDS.find(art => !isSecretArt(art) && w.cultivation.insight < SWORD_ARTS[art].unlock);
    const growth = `修${training.level}重${training.nextInsight === null ? ' 已圆满' : ` ${w.cultivation.insight}/${training.nextInsight}悟`} · `
      + (next ? `悟${SWORD_ARTS[next].short} ${w.cultivation.insight}/${SWORD_ARTS[next].unlock}` : '剑谱齐备');
    const headline = w.artNoticeT > 0 ? w.artNotice : `第${this.director.chapter}关 ${this.director.chapterTitle()}`;
    const boss = w.enemies.find(e => e.tag === 'boss');
    const battle = boss ? ` · BOSS ${BOSS_NAMES[boss.bossKind ?? 'spider']} ${boss.hp}/${boss.maxHp ?? 5}${boss.quakeX !== undefined ? boss.bossKind === 'crystal' ? ' 冰阵！跳跃/离开蓝线' : ' 地裂！跳跃/离开红线' : boss.windup >= 0 ? ' 蓄势！' : ''}` : '';
    const cleanup = this.director.activeStep >= 1800 ? ` · 清场中 剩${w.enemies.length}敌` : '';
    const state = (p.armorT ?? 0) > 0 ? `防御中 ${p.armorT!.toFixed(1)}秒` : (p.stunT ?? 0) > 0 ? '受控，按S>K解控'
      : (p.slowT ?? 0) > 0 ? '减速，按S>K解控' : '可行动';
    return `${life} 气${w.qi}/${MAX_QI} · 火柴快斩 · ${state} · ${skills} · ${headline}${battle}${cleanup} · ${growth} · ${w.kills}击破${combo}${pulse}`;
  }
  private hudEnglish(): string {
    const result = this.director.result, w = this.world;
    if (result !== null) {
      const checkpoint = this.director.checkpoint()!;
      const title = chapterName(result.chapter, this.director.chapterTitle());
      const story = chapterStory(result.chapter, this.director.chapterStory());
      return w.phase === 'fight'
        ? `Chapter ${result.chapter} clear · ${result.score} pts · J next / auto continue · Total ${checkpoint.score} pts ${checkpoint.kills} kills Best combo ${checkpoint.bestCombo} · ${title} · ${story}`
        : `Chapter ${result.chapter} clear · ${title} · ${story} · ${result.score} pts · Waiting for next task`;
    }
    const p = w.player, growth = playerGrowth(w.cultivation.insight);
    const next = ART_IDS.find(art => !isSecretArt(art) && w.cultivation.insight < SWORD_ARTS[art].unlock);
    const life = w.respawn > 0 ? 'Respawning' : `HP ${p.hp}/${p.maxHp ?? 4}`;
    const state = (p.armorT ?? 0) > 0 ? `Guarding ${p.armorT!.toFixed(1)}s`
      : (p.stunT ?? 0) > 0 ? 'Stunned: S>K to break free'
        : (p.slowT ?? 0) > 0 ? 'Slowed: S>K to break free' : 'Ready to act';
    const skills = `Guard S>K ${cooldownBar(p.armorCool ?? 0, growth.armorCooldown)} · Dash U ${cooldownBar(p.dashCool, 0.7 * growth.skillCooldown)} · Spin I ${cooldownBar(p.spinCool, 1.6 * growth.skillCooldown)}`;
    const headline = w.artNoticeT > 0 ? englishBattleNotice(w.artNotice)
      : `Stage ${this.director.chapter}: ${chapterName(this.director.chapter, this.director.chapterTitle())}`;
    const boss = w.enemies.find(e => e.tag === 'boss');
    const battle = boss ? ` · BOSS ${uiName(BOSS_NAMES[boss.bossKind ?? 'spider'])} ${boss.hp}/${boss.maxHp ?? 5}${boss.quakeX !== undefined ? boss.bossKind === 'crystal' ? ' Ice field! Jump or leave the blue line' : ' Ground strike! Jump or leave the red line' : boss.windup >= 0 ? ' Charging!' : ''}` : '';
    const cleanup = this.director.activeStep >= 1800 ? ` · Clear remaining ${w.enemies.length}` : '';
    const training = `Cultivation ${growth.level}${growth.nextInsight === null ? ' Max' : ` Insight ${w.cultivation.insight}/${growth.nextInsight}`} · ${next ? `Next ${artName(next, true)} ${w.cultivation.insight}/${SWORD_ARTS[next].unlock}` : 'All arts unlocked'}`;
    return `${life} Qi ${w.qi}/${MAX_QI} · Stick Slash · ${state} · ${skills} · ${headline}${battle}${cleanup} · ${training} · ${w.kills} kills${w.combo >= 2 ? ` · Combo ${w.combo}` : ''}${this.readyPulse > 0 ? ' Ready✦' : ''}`;
  }
  details(): string[] {
    if (isEnglish()) return this.detailsEnglish();
    const w = this.world;
    const growth = playerGrowth(w.cultivation.insight);
    const arts = ART_IDS.flatMap(art => {
      const spec = SWORD_ARTS[art];
      if (isSecretArt(art) && w.cultivation.mastery[art] === 0) return art === 'getsuga'
        ? '秘卷·月影：48悟后，向上向右挥刀' : '秘卷·日轮：80悟后，向上向左挥刀';
      const selection = selectSwordForm(art, w.qi, w.formProgress[art]);
      const status = w.cultivation.insight < spec.unlock ? `${w.cultivation.insight}/${spec.unlock}悟`
        : `${artLevel(w.cultivation, art)}重 · ${selection ? selection.full ? FULL_ART_NAMES[art] : SWORD_FORMS[art][selection.index]!.name : `需${spec.cost}气`}`;
      return [`${spec.keys} ${spec.name} · ${status}`,
        ...[0, 1, 2].map(tier => {
          const count = SWORD_FORMS[art].length / 3;
          return `${['起手', '60气', '100气'][tier]}档 · 耗${spec.cost + tier * 3}气：${SWORD_FORMS[art].slice(tier * count, (tier + 1) * count).map(f => f.name).join(' → ')}`;
        }), `高档末式收势：${FULL_ART_NAMES[art]}`];
    });
    return ['剑谱：三档轮换 · 按键不变', '两键340ms / 三键650ms · 每档记忆进度', '三键招式按起始朝向释放，左右键位不变',
      `修为${growth.level}重 · 生命上限${growth.maxHp} · ${growth.nextInsight === null ? '已圆满' : `下重${w.cultivation.insight}/${growth.nextInsight}悟`}`,
      '20/60/120/220/360/540悟逐步成长，存档保留',
      `冲刺/旋斩冷却缩短${Math.round((1 - growth.skillCooldown) * 100)}% · 普攻伤害不变`,
      `S>K 护体罡气：解控，举剑定身防御${growth.armorDuration.toFixed(2)}秒，仍会掉血`,
      `防御期间不可移动/攻击/跳跃；零耗气，冷却${growth.armorCooldown.toFixed(2)}秒`,
      '冷却条从左到右填满，数字显示剩余秒数',
      '初期头目：单斩、短冲撞、单处冰阵',
      '后续逐步增加双斩、强击退、多处冰阵', '冰阵减速逐步增强，跳跃/离开蓝线可躲',
      '33关起螳螂可短控；39关起金色蓄势抗打断',
      `储气上限${MAX_QI} · 每式少量扣气，不清空`,
      '各剑法演出及衍生招式为游戏编排', ...arts, `击破+12气 · 普通命中剑客/Boss+${BOSS_HIT_QI}气`,
      '剑招不回气 · 高档轮完自动收势', '剑客：正面普攻可拼剑，剑招/绕背破守', '收招时追击；蓄势时跳跃或冲刺躲避', '战斗不限时，全部击败才结算'];
  }
  private detailsEnglish(): string[] {
    const w = this.world, growth = playerGrowth(w.cultivation.insight);
    const arts = ART_IDS.flatMap(art => {
      const spec = SWORD_ARTS[art];
      if (isSecretArt(art) && w.cultivation.mastery[art] === 0)
        return [art === 'getsuga' ? 'Secret Moon Scroll: 48 insight, then up > right > slash'
          : 'Secret Sun Scroll: 80 insight, then up > left > slash'];
      const selection = selectSwordForm(art, w.qi, w.formProgress[art]);
      const status = w.cultivation.insight < spec.unlock ? `Insight ${w.cultivation.insight}/${spec.unlock}`
        : `Mastery ${artLevel(w.cultivation, art)} · ${selection ? selection.full ? fullArtName(art) : formName(art, selection.index) : `Needs ${spec.cost} qi`}`;
      return [`${spec.keys} ${artName(art)} · ${status}`,
        ...[0, 1, 2].map(tier => {
          const count = SWORD_FORMS[art].length / 3;
          return `${['Opening', '60 qi', '100 qi'][tier]} tier · Costs ${spec.cost + tier * 3} qi: ${SWORD_FORMS[art].slice(tier * count, (tier + 1) * count).map((_, i) => formName(art, tier * count + i)).join(' → ')}`;
        }), `Final high-tier form: ${fullArtName(art)}`];
    });
    return ['Sword Arts: three rotating tiers · same key combos', 'Two keys within 340ms / three within 650ms · each tier remembers progress',
      'Three-key arts aim in your starting direction',
      `Cultivation ${growth.level} · Max HP ${growth.maxHp} · ${growth.nextInsight === null ? 'Max level' : `Next level ${w.cultivation.insight}/${growth.nextInsight} insight`}`,
      'Grow at 20/60/120/220/360/540 insight; progress is saved',
      `Dash/spin cooldown reduced ${Math.round((1 - growth.skillCooldown) * 100)}%; normal slash damage unchanged`,
      `S>K Iron Guard: break control, defend in place for ${growth.armorDuration.toFixed(2)}s; still take damage`,
      `Cannot move, attack or jump during guard; costs no qi; cooldown ${growth.armorCooldown.toFixed(2)}s`,
      'Cooldown bars fill left to right; numbers show seconds remaining',
      'Early bosses: single strikes, short dashes and one ice field',
      'Later bosses add double strikes, strong knockback and multiple ice fields',
      'Jump or leave the blue line to evade slowing ice',
      'Mantis gains short control at stage 33; charging scarab resists interruption at stage 39',
      `Max qi ${MAX_QI}; each form spends a little, not the whole meter`,
      'Sword arts and derived forms are original game interpretations', ...arts,
      `Kill +12 qi; normal hits on duelists/bosses +${BOSS_HIT_QI} qi`,
      'Sword arts do not restore qi; high tiers end with a finisher',
      'Duelists can parry frontal slashes; use an art or attack from behind',
      'Punish recovery; dodge a charge by jumping or dashing',
      'Combat has no time limit; defeat every enemy to clear the stage'];
  }
  combatHud(rows: number): string[] {
    if (isEnglish()) return this.combatHudEnglish(rows);
    const w = this.world, p = w.player, result = this.director.result;
    const life = w.respawn > 0 ? '重生中' : `血${p.hp}/${p.maxHp ?? 4}`;
    const defense = (p.armorT ?? 0) > 0 ? `防御中 ${p.armorT!.toFixed(1)}秒` : (p.stunT ?? 0) > 0 ? '受控：S>K 解控'
      : (p.slowT ?? 0) > 0 ? '减速：S>K 解控' : '可行动';
    const status = `${life} 气${w.qi} ${defense}`;
    const growth = playerGrowth(w.cultivation.insight);
    const armorCd = `护S>K${cooldownBar(p.armorCool ?? 0, growth.armorCooldown, 3)}`;
    const attackCd = `冲U${cooldownBar(p.dashCool, 0.7 * growth.skillCooldown, 3)} 旋I${cooldownBar(p.spinCool, 1.6 * growth.skillCooldown, 3)}`;
    const compactCd = `护${cooldownTrack(p.armorCool ?? 0, growth.armorCooldown, 3)} 冲${cooldownTrack(p.dashCool, 0.7 * growth.skillCooldown, 3)} 旋${cooldownTrack(p.spinCool, 1.6 * growth.skillCooldown, 3)}`;
    const boss = w.enemies.find(e => e.tag === 'boss') ?? w.enemies.find(e => e.duelist);
    const threat = boss ? `${boss.duelist ? boss.duelist === 'qingfeng' ? '青锋' : '玄衣' : BOSS_NAMES[boss.bossKind ?? 'spider']} ${boss.hp}/${boss.maxHp ?? 5}` : '';
    const warning = boss?.quakeX !== undefined ? boss.bossKind === 'crystal' ? '冰阵！跳跃 / 离开蓝线' : '地裂！跳跃 / 离开红线'
      : boss && (boss.followupT ?? 0) > 0 ? bossAbilities(boss).stun ? '双斩！第二镰带硬直' : '双斩！小心第二镰'
      : boss && boss.windup >= 0 ? '蓄势！准备闪避' : (boss?.guard ?? 0) > 0 ? '守势：剑招 / 绕背破守' : '';
    const selected = selectSwordForm(w.selectedArt, w.qi, w.formProgress[w.selectedArt]), cast = w.swordCast;
    const following = cast ? selected : selected ? selectSwordForm(w.selectedArt, w.qi - selected.cost,
      w.formProgress[w.selectedArt].map((n, i) => n + (i === selected.tier ? 1 : 0))) : null;
    const nextForm = cast ? `${cast.full ? FULL_ART_NAMES[cast.art] : currentSwordForm(cast).name}`
      : selected ? `${SWORD_ARTS[w.selectedArt].keys} ${selected.full ? FULL_ART_NAMES[w.selectedArt] : SWORD_FORMS[w.selectedArt][selected.index]!.name}`
        : `攒气 ${w.qi}/${SWORD_ARTS[w.selectedArt].cost}`;
    if (rows <= 2) return [result ? `${life} · 第${this.director.chapter}关完成`
      : (p.armorT ?? 0) > 0 ? `${life} · 防御中 ${p.armorT!.toFixed(1)}秒`
        : warning ? `${life} · ${warning}` : `${life} 气${w.qi} · ${nextForm}`,
      result ? '已清场 J继续 ?谱' : `${compactCd}${warning ? ' !' : ''} ?谱`];
    if (result) return [...[`第${result.chapter}章完成`, this.director.chapterTitle(), `${result.score}分 · ${result.kills}击破`,
      'J 下一章 / 自动继续', ''].slice(0, rows - 1), '?谱 E大小 Esc退'];
    const lines = rows <= 3 ? [status, compactCd]
      : rows <= 4 ? [status, warning || threat || nextForm, compactCd]
        : rows <= 5 ? [status, warning || threat || `${this.director.chapter}关`, nextForm, compactCd]
      : [status, warning || threat || `${this.director.chapter}关 ${this.director.chapterTitle()}`,
        `${nextForm} · 修${growth.level}重`, armorCd, attackCd,
        following ? `接 ${SWORD_FORMS[w.selectedArt][following.index]!.name}` : '攒气续招 · 战斗不限时'];
    return [...lines.slice(0, rows - 1), '?谱 E大小 Esc退'];
  }
  private combatHudEnglish(rows: number): string[] {
    const w = this.world, p = w.player, result = this.director.result;
    const life = w.respawn > 0 ? 'Respawning' : `HP ${p.hp}/${p.maxHp ?? 4}`;
    const defense = (p.armorT ?? 0) > 0 ? `Guarding ${p.armorT!.toFixed(1)}s`
      : (p.stunT ?? 0) > 0 ? 'Stunned: S>K breaks free'
        : (p.slowT ?? 0) > 0 ? 'Slowed: S>K breaks free' : 'Ready';
    const growth = playerGrowth(w.cultivation.insight);
    const status = `${life} Qi ${w.qi} ${defense}`;
    const guardCd = `Guard S>K ${cooldownBar(p.armorCool ?? 0, growth.armorCooldown, 3)}`;
    const attackCd = `Dash U ${cooldownBar(p.dashCool, 0.7 * growth.skillCooldown, 3)} Spin I ${cooldownBar(p.spinCool, 1.6 * growth.skillCooldown, 3)}`;
    const compactCd = `G${cooldownTrack(p.armorCool ?? 0, growth.armorCooldown, 3)} D${cooldownTrack(p.dashCool, 0.7 * growth.skillCooldown, 3)} S${cooldownTrack(p.spinCool, 1.6 * growth.skillCooldown, 3)}`;
    const boss = w.enemies.find(e => e.tag === 'boss') ?? w.enemies.find(e => e.duelist);
    const threat = boss ? `${boss.duelist ? boss.duelist === 'qingfeng' ? 'Azure Blade' : 'Dark Robe' : uiName(BOSS_NAMES[boss.bossKind ?? 'spider'])} ${boss.hp}/${boss.maxHp ?? 5}` : '';
    const warning = boss?.quakeX !== undefined ? boss.bossKind === 'crystal' ? 'Ice field! Jump / leave blue line' : 'Ground strike! Jump / leave red line'
      : boss && (boss.followupT ?? 0) > 0 ? bossAbilities(boss).stun ? 'Double slash! Second hit stuns' : 'Double slash! Dodge the second hit'
        : boss && boss.windup >= 0 ? 'Charging! Dodge now' : (boss?.guard ?? 0) > 0 ? 'Guarding: use an art / attack from behind' : '';
    const selected = selectSwordForm(w.selectedArt, w.qi, w.formProgress[w.selectedArt]), cast = w.swordCast;
    const following = cast ? selected : selected ? selectSwordForm(w.selectedArt, w.qi - selected.cost,
      w.formProgress[w.selectedArt].map((n, i) => n + (i === selected.tier ? 1 : 0))) : null;
    const nextForm = cast ? cast.full ? fullArtName(cast.art) : formName(cast.art, cast.formIndex ?? 0)
      : selected ? `${SWORD_ARTS[w.selectedArt].keys} ${selected.full ? fullArtName(w.selectedArt) : formName(w.selectedArt, selected.index)}`
        : `Build qi ${w.qi}/${SWORD_ARTS[w.selectedArt].cost}`;
    if (rows <= 2) return [result ? `${life} · Stage ${this.director.chapter} clear`
      : (p.armorT ?? 0) > 0 ? `${life} · Guarding ${p.armorT!.toFixed(1)}s`
        : warning ? `${life} · ${warning}` : `${life} Qi ${w.qi} · ${nextForm}`,
      result ? 'Clear! J next ? arts' : `${compactCd}${warning ? ' !' : ''} ? arts`];
    if (result) return [...[`Chapter ${result.chapter} clear`, chapterName(result.chapter, this.director.chapterTitle()),
      `${result.score} pts · ${result.kills} kills`, 'J next / auto continue', ''].slice(0, rows - 1), '? arts E size Esc back'];
    const lines = rows <= 3 ? [status, compactCd]
      : rows <= 4 ? [status, warning || threat || nextForm, compactCd]
        : rows <= 5 ? [status, warning || threat || `Stage ${this.director.chapter}`, nextForm, compactCd]
          : [status, warning || threat || `Stage ${this.director.chapter}: ${chapterName(this.director.chapter, this.director.chapterTitle())}`,
            `${nextForm} · Cultivation ${growth.level}`, guardCd, attackCd,
            following ? `Next ${formName(w.selectedArt, following.index)}` : 'Build qi for the next form · No time limit'];
    return [...lines.slice(0, rows - 1), '? arts E size Esc back'];
  }
}

function savedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  hud(): string { return isEnglish() ? `Snake · ${this.score} · Best ${this.best} · Tab switch game`
    : `贪吃蛇 · ${this.score} · 最高 ${this.best} · Tab 换游戏`; }
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
  hud(): string { return isEnglish() ? `Blocks · ${this.score} · Best ${this.best} · Tab switch game`
    : `落块 · ${this.score} · 最高 ${this.best} · Tab 换游戏`; }
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
    display: { micro: id === 'stick-slash', minRows: id === 'stick-slash' ? 4 : 6,
      glyphs: id === 'stick-slash' ? 'dots' : 'blocks', responsive: id === 'stick-slash' },
    palette: ['#090a0e', '#ecf0f8', '#e43834', '#a67c00'],
    controls: id === 'stick-slash'
      ? [{ action: 'move', label: '移动', keys: ['A/D', '方向键'] }, { action: 'primary', label: '砍', keys: ['J'] }, { action: 'jump', label: '跳', keys: ['空格'] }, { action: 'secondary', label: '冲刺斩', keys: ['U'] }, { action: 'special', label: '旋斩', keys: ['I'] }, { action: 'armor', label: '解控霸体', keys: ['S>K'] }]
      : id === 'snake' ? [{ action: 'move', label: '方向', keys: ['WASD', '方向键'] }]
        : [{ action: 'move', label: '移动', keys: ['A/D'] }, { action: 'primary', label: '旋转', keys: ['J'] }, { action: 'down', label: '下落', keys: ['S'] }, { action: 'jump', label: '直落', keys: ['空格'] }] };
}

export const BUILTIN_GAMES: GameModule[] = [
  { manifest: manifest('stick-slash', '火柴快斩', '连续动作与打击反馈', { width: 180, height: 44 }), create: context => new StickGame(context.seed) },
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
  'renderMicro', 'renderExpanded', 'renderPixels', 'configureViewport', 'onHostEvent', 'serialize', 'restore', 'hud', 'details', 'combatHud',
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
  private panelPage = 0;
  readonly keys = { clear: (): void => { this.input.clear(); } };
  private readonly input = new InputLatch(); private readonly tail: SignalTail;
  private readonly slots: CartridgeSlot[] = [];
  private readonly failures = new Map<string, string>();
  private active = 0; private lastMs = 0; private acc = 0; private lastHostPoll = Number.NEGATIVE_INFINITY;
  private stepped = false;
  private saveElapsed = 0;
  private paused = false; private instructions = true; private viewToggle = false;
  private displayRows = 24; private displayTier: PixelTarget['tier'] = 'braille';
  private statusValue: ArcadeStatus = 'idle'; private pendingAction: ArcadeAction | null = null;
  constructor(eventsFile?: string, modules: GameModule[] = BUILTIN_GAMES, startId?: string,
    contextSeed = Date.now() & 0x7fffffff) {
    for (const module of modules) try {
      const source = new Rng(contextSeed);
      const context: GameContext = Object.freeze({ seed: contextSeed >>> 0, random: () => source.float() });
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
  get name(): string { return uiName(this.slots[this.active]?.module.manifest.name ?? '摸鱼'); }
  resize(_w: number, _h: number): void { /* logical viewports are fixed */ }
  feed(bytes: Uint8Array, now = Date.now()): boolean {
    const command = this.input.feed(bytes, now, this.slots[this.active]?.module.manifest.id === 'stick-slash');
    if (command === 'leave') return true;
    if (command === 'next' && this.slots.length > 0) {
      try { this.slots[this.active]!.instance.onHostEvent?.('pause'); } catch { /* isolate cartridges */ }
      this.save(this.active);
      this.active = (this.active + 1) % this.slots.length; this.resetClock(); this.instructions = true;
    }
    if (command === 'help') { this.instructions = !this.instructions; this.panelPage = 0; this.resetClock(); }
    if (command === 'page-prev' || command === 'page-next') {
      if (!this.instructions) { this.instructions = true; this.panelPage = 0; this.resetClock(); }
      else this.panelPage += command === 'page-prev' ? -1 : 1;
    }
    if (command === 'view') { this.viewToggle = true; this.input.clear(); }
    if (command === 'play' && this.playable()) this.instructions = false;
    return false;
  }
  enter(): void {
    this.statusValue = 'idle';
    this.pendingAction = null;
    // 进游戏即活：世界立刻推进并渲染，不再拦一张"按键才开始"的空白说明页。
    // 控制提示留在侧栏（? 帮助 / Esc 返回），? 仍随时叫出完整说明。太小放不下时
    // playable() 为假，showingInstructions 自然回到 true，让出/返回逻辑照旧接管。
    // Tab 换游戏仍先亮一次新游戏的操作（next 里置 instructions=true），因为那是没见过的新键位。
    if (this.playable()) { this.instructions = false; this.resetClock(); }
  }
  get status(): ArcadeStatus { return this.statusValue; }
  takeAction(): ArcadeAction | null {
    const action = this.pendingAction;
    this.pendingAction = null;
    return action;
  }
  pollHostEvents(now = Date.now()): void {
    if (now < this.lastHostPoll) this.lastHostPoll = now - HOST_POLL_MS;
    if (now - this.lastHostPoll < HOST_POLL_MS) return;
    this.lastHostPoll = now;
    const events = this.tail.poll();
    if (events.length === 0) return;
    let sawStart = false; let sawDone = false; let sawNotify = false;
    for (const event of events) {
      const e: HostEvent = event === 'start' ? 'task-start' : event === 'notify' ? 'task-notify' : 'task-done';
      for (const slot of this.slots) try { slot.instance.onHostEvent?.(e); } catch { /* isolate cartridges */ }
      if (e === 'task-start') sawStart = true;
      else if (e === 'task-done') sawDone = true;
      else sawNotify = true;
    }
    if (this.statusValue !== 'task-done') {
      if (sawDone) this.statusValue = 'task-done';
      else if (sawNotify) this.statusValue = 'needs-input';
      else if (sawStart && this.statusValue === 'needs-input') this.statusValue = 'idle';
    }
    if (!sawDone && !sawNotify) return;
    this.pendingAction = 'return-to-cli';
    this.input.clear();
    if (this.paused) this.save(this.active);
    else this.pause();
  }
  takeViewToggle(): boolean { const value = this.viewToggle; this.viewToggle = false; return value; }
  setDisplay(rows: number, tier: PixelTarget['tier']): void {
    if (rows !== this.displayRows || tier !== this.displayTier) this.resetClock();
    this.displayRows = rows; this.displayTier = tier;
  }
  configureViewport(target: PixelTarget): void {
    const slot = this.slots[this.active];
    try { slot?.instance.configureViewport?.(target.pixelW, target.pixelH, target.tier); }
    catch (error) { if (slot) this.failures.set(slot.module.manifest.id, failureMessage(error)); }
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
  panel(): [string, string, ...string[]] {
    const slot = this.slots[this.active];
    if (isEnglish()) {
      if (slot === undefined) return ['No games available', 'Check installed Cartridges · Esc back'];
      const m = slot.module.manifest, name = uiName(m.name);
      if (!this.playable()) return [name, this.displayRows <= 2
        ? `E expand · Needs ${this.minimumRows()} rows · Esc back`
        : `Needs ${this.minimumRows()} rows; enlarge the terminal or use moyu play · Esc back`];
      const controls = m.controls.map(c => `${uiName(c.keys[0] ?? '')} ${uiName(c.label)}`).join(' · ');
      if (!this.instructions) {
        const lines = slot.instance.combatHud?.(this.displayRows) ?? [slot.instance.hud?.() ?? name, '? help E size Esc back'];
        return [lines[0] ?? name, lines[1] ?? '', ...lines.slice(2)];
      }
      return [`${name} · ${controls}`, 'E size · Tab switch · Esc back', ...(slot.instance.details?.() ?? [])];
    }
    if (slot === undefined) return ['没有可用游戏', '请检查已安装 Cartridge · Esc 返回'];
    const m = slot.module.manifest;
    if (!this.playable()) return [m.name, this.displayRows <= 2
      ? `E 展开 · 需${this.minimumRows()}行 · Esc 返回`
      : `需${this.minimumRows()}行，请放大终端或使用 moyu play · Esc 返回`];
    const controls = m.controls.map((c) => `${c.keys[0] ?? ''} ${c.label}`).join(' · ');
    if (!this.instructions) {
      const lines = slot.instance.combatHud?.(this.displayRows) ?? [slot.instance.hud?.() ?? m.name, '?帮助 E大小 Esc退'];
      return [lines[0] ?? m.name, lines[1] ?? '', ...lines.slice(2)];
    }
    return [`${m.name} · ${controls}`, 'E 大小 · Tab 换 · Esc 返回', ...(slot.instance.details?.() ?? [])];
  }
  get showingInstructions(): boolean { return this.instructions || !this.playable(); }
  /** 先按终端列宽折行，再分页；任何剑谱条目都能到达，不静默裁掉尾部。 */
  panelRows(width: number, rows: number): string[] {
    if (width <= 0 || rows <= 0) return [];
    if (!this.showingInstructions) return this.panel().slice(0, rows)
      .map(line => clipWidth(line.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), width));
    const lines = this.panel().flatMap(line => wrapWidth(line.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), width));
    const size = Math.max(1, rows - 1), pages = Math.max(1, Math.ceil(lines.length / size));
    this.panelPage = ((this.panelPage % pages) + pages) % pages;
    const page = lines.slice(this.panelPage * size, (this.panelPage + 1) * size);
    while (page.length < size) page.push('');
    if (rows > 1) page.push(this.showingInstructions
      ? isEnglish() ? `Esc back · [ ] page ${this.panelPage + 1}/${pages} · ? close`
        : `Esc 返回 · [ ]翻页 ${this.panelPage + 1}/${pages} · ?收起`
      : width < 26 ? `? Esc退 []${this.panelPage + 1}/${pages}`
        : `?帮助 Esc退 [ ]翻页 ${this.panelPage + 1}/${pages}`);
    return page;
  }
  private resetClock(): void { this.lastMs = 0; this.acc = 0; this.stepped = false; this.input.clear(); }
  advance(now: number): void {
    const elapsed = this.lastMs === 0 ? 0 : Math.max(0, Math.min(0.25, (now - this.lastMs) / 1000)); this.lastMs = now;
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
    this.saveElapsed += elapsed;
    if (this.saveElapsed >= 5) { this.saveElapsed = 0; this.save(this.active); }
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
      const width = slot.module.manifest.display?.responsive ? target.pixelW : 80;
      if (slot.expandedCanvas.height !== height || slot.expandedCanvas.width !== width) slot.expandedCanvas = new LogicalCanvas(width, height);
      const canvas = slot.expandedCanvas; game.renderExpanded(canvas); canvas.blit(target); return;
    }
    const micro = profile === 'micro' && target.tier !== 'graphics' && game.renderMicro !== undefined;
    if (micro && slot.module.manifest.display?.responsive && slot.microCanvas.width !== target.pixelW)
      slot.microCanvas = new LogicalCanvas(target.pixelW, slot.microCanvas.height);
    const canvas = micro ? slot.microCanvas : slot.canvas;
    if (micro) game.renderMicro!(canvas); else game.render(canvas);
    canvas.blit(target);
  }
  hud(): { left: string; right: string; short: string; urgent: boolean } {
    if (isEnglish()) {
      const notice = this.statusValue === 'task-done' ? 'Task complete'
        : this.statusValue === 'needs-input' ? 'Needs your input' : null;
      const slot = this.slots[this.active], name = uiName(slot?.module.manifest.name ?? 'Moyu');
      const line = slot?.instance.hud?.() ?? `${name} · Tab switch game`;
      const short = notice === null ? slot === undefined ? 'No games available' : line : `${notice} · ${name}`;
      return { left: short, right: 'Ctrl+] / Esc back', short, urgent: notice !== null };
    }
    const notice = this.statusValue === 'task-done' ? '任务完成'
      : this.statusValue === 'needs-input' ? '需要你确认' : null;
    const slot = this.slots[this.active];
    if (slot === undefined) {
      const short = notice ?? '没有可用游戏';
      return { left: short, right: 'Ctrl+] / Esc 返回', short, urgent: notice !== null };
    }
    const game = slot.instance, name = slot.module.manifest.name;
    const line = game.hud?.() ?? `${name} · Tab 换游戏`;
    const short = notice === null ? line : `${notice} · ${name}`;
    return { left: short, right: 'Ctrl+] / Esc 返回', short, urgent: notice !== null };
  }
  private stateFile(index: number): string { return path.join(process.env.MOYU_HOME ?? path.join(homedir(), '.moyu'), 'state', `${this.slots[index]!.module.manifest.id}.json`); }
  pause(): void {
    if (this.paused) return;
    this.paused = true; this.resetClock();
    const game = this.slots[this.active]?.instance;
    if (game !== undefined) {
      try { game.onHostEvent?.('pause'); } catch { /* isolate cartridges */ }
      this.save(this.active);
    }
  }
  resume(): void {
    if (!this.paused) return;
    this.paused = false; this.resetClock();
    try { this.slots[this.active]?.instance.onHostEvent?.('resume'); } catch { /* isolate cartridges */ }
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
      const file = this.stateFile(index);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch { /* play must not depend on persistence */ }
  }
}
