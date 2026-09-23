/**
 * 战斗模拟。**零 I/O、零终端知识** —— 只有数字和向量，所以它能无头单测。
 *
 * ## 这个 demo 的设计意图（一句话：手感 > 系统）
 *
 * "酣畅淋漓地砍火柴人"要的是**每一刀都有回报**，所以：
 *
 *   - 杂兵**一刀一个**。没有血条、没有硬直抵抗 —— 挥空才是唯一的惩罚。
 *   - 每次命中给三样东西：**顿帧**（普通命中 16~40ms，期间缓存输入）、**屏幕震动**、
 *     **断肢按刀的方向飞出去**。三样缺一样都会立刻变"软"。顿帧是最便宜也最关键的那个：
 *     它让"砍到了"这件事有一个可感知的重量，而代价只是几帧不更新。
 *   - 断口位置**跟着距离走**：贴身砍是脖子，够到边缘砍是腿。这让同一个动作有变化，
 *     也解释了"为什么这刀砍下去是这个结果"。
 *
 * ## 关于顿帧为什么冻结**所有**东西
 *
 * 只冻结被砍的那个会让画面看起来卡，而不是有力。整世界冻结（包括刀光停在挥出的中途）
 * 才是格斗游戏里那种"咚"的感觉。震动和闪光**不**冻结 —— 它们是冲击的表现，不是世界的一部分。
 */

import { Rng } from './rng.ts';
import { fighterSegments } from './creature.ts';
import { MAX_QI, BOSS_HIT_QI, SWORD_ARTS, SWORD_FORMS, FULL_ART_NAMES, selectSwordForm, currentSwordForm,
  artLevel, artDuration, artRecovery, isSecretArt, freshCultivation, freshFormProgress, playerGrowth, type SwordArt, type SwordCast } from './martial.ts';
import { poseAir, poseBossCharge, poseBossSlam, poseBossSweep, poseBossWindup, poseHurt, poseIdle, poseLand, poseSlash, poseWalk, poseWindup, segments, type Body, type Pose, type Seg } from './stick.ts';

/** 玩家每帧的意图。由输入层（latch）产出，模拟层不认识按键。 */
export type Intent = {
  /** -1 左 / 0 停 / 1 右 */
  move: -1 | 0 | 1;
  jump: boolean;
  slash: boolean;
  /** 冲刺斩：朝身前窜一段，路上的杂兵全带碎。可选：省略视为未按。 */
  dash?: boolean;
  /** 旋斩：原地 360° 扫倒一圈。可选：省略视为未按。 */
  spin?: boolean;
  /** 蹲下（S/↓ 的缓冲窗）。挥刀时按住 → 低扫「蹲斩」。可选：省略视为未按。 */
  crouch?: boolean;
  /** 护体罡气：受控时也能解控，短暂霸体但不免伤。 */
  armor?: boolean;
  art?: SwordArt | undefined;
  /** 组合指令开始时的朝向，独立于指令内的移动键。 */
  artFace?: -1 | 1 | undefined;
};

export const NO_INTENT: Intent = { move: 0, jump: false, slash: false, dash: false, spin: false, crouch: false };
export const PLAYER_MOVE_MULTIPLIER = 1.2;
export const SLASH_RECOVERY = 0.26;
export const ARMOR_TIME = 0.8;
export const ARMOR_COOLDOWN = 6;

/** 'title' 等第一刀，'fight' 打，'clear' 清屏技放完，'paused' 等下一个任务。 */
export type Phase = 'title' | 'fight' | 'clear' | 'paused';

/** 敌人变种：外观（颜色）+ 已有的尺寸/速度差异；boss 额外多段血。玩家不带 tag。 */
export type EnemyTag = 'grunt' | 'runner' | 'brute' | 'boss' | 'swordsman';

/** 挥刀的变招：由起手瞬间的世界状态决定（空中/蹲下/朝前），拳皇式组合技全靠它。 */
export type AttackKind = 'normal' | 'air' | 'sweep' | 'lunge';

/** Boss 招式：近战重击 / 冲撞 / 范围横扫。 */
type BossMove = 'melee' | 'charge' | 'sweep';
export type BossHazard = { x: number; radius: number; timer: number; life: number; hit: boolean;
  frost?: boolean; owner?: Fighter; slow?: { duration: number; multiplier: number } };
export type Species = 'mantis' | 'crab' | 'eel' | 'scorpion' | 'scarab' | 'wolf' | 'crystal' | 'bat' | 'idol';
export type BossKind = 'spider' | 'mantis' | 'scarab' | 'crystal';
export const BOSS_NAMES: Record<BossKind, string> = { spider: '蛛王', mantis: '螳螂王', scarab: '金甲虫王', crystal: '冰晶王' };
/** 跳过剑宗的第九关倍数，确保每种怪物王都能轮到；不消耗随机流。 */
export function bossKindForChapter(chapter: number): BossKind {
  const index = Math.max(0, Math.floor(chapter / 3) - Math.floor(chapter / 9) - 1);
  return (['mantis', 'scarab', 'crystal', 'spider'] as const)[index % 4]!;
}
export function bossArmored(f: Fighter): boolean {
  return !!f.bossKind && f.bossKind !== 'spider' && bossAbilities(f).armor && f.windup > 0 && f.windup <= 0.2;
}
/** 按实际关卡解锁，不因残血越过教学阶段；预警和实招共享同一份能力表。 */
export function bossAbilities(f: Fighter) {
  const rank = Math.max(0, Math.min(20, f.bossRank ?? 0));
  const frostGrowth = Math.min(1, Math.max(0, (rank - 3) / 6));
  return { doubleStrike: rank >= 4, stun: rank >= 10, push: rank >= 5, armor: rank >= 12,
    frostOffsets: rank >= 6 ? [-1, 0, 1] : [0],
    slow: rank >= 3 ? { duration: 0.4 + frostGrowth * 0.4, multiplier: 0.8 - frostGrowth * 0.2 } : undefined,
    chargeTime: Math.min(0.32, 0.22 + rank * 0.005),
    windup: Math.max(0.75, 1.05 - rank * 0.015) + (f.bossKind === 'crystal' ? 0.1 : 0),
    recovery: Math.max(1.1, 1.6 - rank * 0.025) };
}
/** 新头目的预警与命中共用尺寸；螳螂双镰覆盖整个身体前方。 */
export function variantBossReach(f: Fighter): number { return f.h * (f.bossKind === 'mantis' ? 0.95 : 0.8); }
function bossHeight(fh: number, ground: number, kind?: BossKind): number {
  return Math.round(kind && kind !== 'spider' ? Math.min(fh * 1.6, (ground - 1) / 1.3) : fh * 1.6);
}

/**
 * Boss 阶段随剩余血量收紧：5-4 重压、3-2 暴走、1 困兽。
 * 纯函数、零副作用，测试可直接对照。
 */
export function bossPhase(hp: number, maxHp = 5): 1 | 2 | 3 {
  if (hp >= maxHp * 0.8) return 1;
  if (hp >= maxHp * 0.4) return 2;
  return 3;
}

/** 每三关只加一格血，63关封顶；场景循环不会重置成长。 */
export function bossDifficulty(chapter: number): { rank: number; hp: number; speed: number; cooldown: number; windup: number } {
  const rank = Math.min(20, Math.max(0, Math.floor(((Number.isFinite(chapter) ? chapter : 3) - 3) / 3)));
  return { rank, hp: 5 + rank, speed: 1 + rank * 0.02, cooldown: Math.max(0.65, 1 - rank * 0.0175),
    windup: Math.max(0.65, 0.85 - rank * 0.01) };
}
export function duelistHp(chapter: number, boss = false): number {
  const difficulty = bossDifficulty(chapter);
  return boss ? difficulty.hp + 1 : 3 + Math.min(5, Math.floor(difficulty.rank / 3));
}
function duelistWindup(f: Fighter): number {
  return Math.max(0.65, 0.95 - (f.bossRank ?? 0) * 0.0125 - (bossPhase(f.hp, f.maxHp) === 3 ? 0.05 : 0));
}
export function bossQuakeOffsets(f: Fighter): readonly number[] {
  if (f.bossKind === 'crystal') return bossAbilities(f).frostOffsets;
  return (f.bossRank ?? 0) >= 12 ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
}
/** 预警和实际出招使用同一份招式表，避免红线与判定范围不一致。 */
export function duelistFormFor(f: Fighter): { art: SwordArt; formIndex: number } {
  const art: SwordArt = f.duelist === 'qingfeng' ? 'dugu' : 'liumai';
  const forms = f.duelist === 'qingfeng' ? [1, 2, 3] : [0, 4, 5];
  const rank = f.bossRank ?? 0;
  const count = rank < 3 ? 1 : f.tag === 'boss' && rank >= 8 ? 3 : 2;
  return { art, formIndex: forms[(f.atkSeq ?? 0) % count]! };
}

/**
 * 出招表：**确定性**地按 `seq` 轮换，零 RNG。
 * - Phase 1：只近战（守住满血=长前摇近战的回归）。
 * - Phase 2：近战 / 冲撞交替。
 * - Phase 3：近战 / 冲撞 / 横扫三循环。
 */
function bossMoveFor(phase: 1 | 2 | 3, seq: number): BossMove {
  if (phase === 1) return 'melee';
  if (phase === 2) return seq % 2 === 0 ? 'charge' : 'melee';
  const pick = seq % 3;
  return pick === 0 ? 'sweep' : pick === 1 ? 'charge' : 'melee';
}

export type Fighter = {
  kind: 'player' | 'grunt';
  /** 敌人变种标签；玩家和老的字面量省略它。 */
  tag?: EnemyTag;
  species?: Species;
  /** 地裂蓄力的固定落点，不跟随玩家漂移。 */
  quakeX?: number;
  maxHp?: number;
  bossRank?: number;
  bossKind?: BossKind;
  /** 螳螂第二斩倒计时；冲撞使用 dashT，冰阵使用 hazards。 */
  followupT?: number;
  stunT?: number;
  slowT?: number;
  slowFactor?: number;
  controlImmuneT?: number;
  armorT?: number;
  armorCool?: number;
  duelist?: 'qingfeng' | 'xuanyi';
  guard?: number;
  pressureHits?: number;
  enemyCast?: SwordCast;
  x: number;
  y: number;
  vx: number;
  vy: number;
  h: number;
  face: 1 | -1;
  onGround: boolean;
  hp: number;
  /** 走路相位 0..1 */
  walk: number;
  /** 呼吸/待机相位（秒） */
  anim: number;
  /** 攻击已进行的秒数；-1 = 没在攻击 */
  atk: number;
  /** 这一刀的变招：空中=air 俯冲、蹲下=sweep 低扫、朝前=lunge 前冲，否则 normal。玩家专用，省略视为 normal。 */
  atkKind?: AttackKind;
  /** 这一刀的判定做过了没 —— 一刀只能判定一次 */
  atkHit: boolean;
  /** 输入缓冲：在收招段按了下一刀，收招结束立刻接上（连打的手感全靠它） */
  atkQueued: boolean;
  /** 受击残留（秒），驱动受击姿态 */
  hurt: number;
  /** 落地压扁残留（秒）；> 0 时走 `poseLand`。只有真的从空中砸下来才会被点亮 */
  land: number;
  invuln: number;
  /** 杂兵前摇剩余（秒）；-1 = 没在起手 */
  windup: number;
  cool: number;
  speed: number;
  /** 冲刺斩进行中剩余（秒）；<= 0 = 没在冲。 */
  dashT: number;
  /** 冲刺斩冷却剩余（秒）。 */
  dashCool: number;
  /** 旋斩进行中剩余（秒）；<= 0 = 没在转。 */
  spinT: number;
  /** 旋斩冷却剩余（秒）。 */
  spinCool: number;
  /** 蹲斩（低扫）冷却剩余（秒）。玩家专用，省略视为 0（就绪）。 */
  sweepCool?: number;
  /** 前冲斩冷却剩余（秒）。玩家专用，省略视为 0（就绪）。 */
  lungeCool?: number;
  /** boss 已出招次数：确定性地轮换招式（不抽 RNG）。boss 专用，省略视为 0。 */
  atkSeq?: number;
  pose: Pose;
  armed: boolean;
};

/** 一块断肢。刚体：位置 + 朝向 + 角速度。 */
export type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 朝向（数学角，段方向 = (cos a, sin a)） */
  ang: number;
  av: number;
  /** 半长；头是半径 */
  half: number;
  head: boolean;
  /** 已经躺平了 —— 不再模拟，成为地上的尸堆（静止的东西 diff 免费） */
  rest: boolean;
  /** 玩家的碎块用亮色，杂兵用暗色 */
  mine: boolean;
};

export type Blood = { x: number; y: number; vx: number; vy: number; life: number };

/** 刀光：一段圆弧 + 剩余寿命。 */
export type Slash = { x: number; y: number; r: number; a0: number; a1: number; life: number; max: number; big: boolean };

export type SpawnSide = 'left' | 'right';
export type SpawnFormation =
  | { kind: 'single'; side: SpawnSide }
  | { kind: 'pair'; side: SpawnSide }
  | { kind: 'pincer' }
  | { kind: 'fill'; side: SpawnSide };

export type WorldOptions = { automaticSpawns?: boolean };

/** 落地压扁的持续时间。30fps 下约 3 帧 —— 少于这个数就一闪而过看不见（见 `poseLand`）。 */
const LAND_TIME = 0.1;

/** 冲刺斩：窜出的持续时间与冷却。短促、可连用，是走位也是进攻。 */
const DASH_TIME = 0.18;
const DASH_COOL = 0.7;
/** 旋斩：转一圈的持续时间与冷却。范围技，冷却明显更长。 */
const SPIN_TIME = 0.34;
const SPIN_COOL = 1.6;
/** 组合技冷却：蹲斩（低扫，横扫一排）比前冲斩（补位破距）范围更大，冷却也更长。 */
const SWEEP_COOL = 0.9;
const LUNGE_COOL = 0.7;

/** Boss：多段血、更大更慢、前摇更长的重击。只由章节导演在 boss 章生成。 */
const BOSS_WINDUP = 0.85;
const GRUNT_WINDUP = 0.42;
/** 非致命命中后的短暂无敌，防止冲刺/旋斩在一次动作里把 boss 连成秒杀。 */
const STAGGER_INVULN = 0.25;
/** 连击里程碑：跨过这些数时那一刀额外顿一记，"越连越沉"（只加顿帧，不改计分）。 */
const MILESTONES = [5, 10, 15, 20];
/** Boss 分阶段：满血(5-4)重压近战；暴走(3-2)加冲撞；困兽(1)加范围横扫。 */
const BOSS_CHARGE_TIME = 0.3;   // 冲撞窜出的持续（比玩家冲刺略长，看得清）
const BOSS_SWEEP_TIME = 0.34;   // 范围横扫（复用旋斩的时长/整圈刀光观感）
const BOSS_SWEEP_REACH_FH = 1.7;

export class World {
  biome: number | undefined;
  hazards: BossHazard[] = [];
  qi = 0;
  cultivation = freshCultivation();
  formProgress = freshFormProgress();
  swordCast: SwordCast | null = null;
  selectedArt: SwordArt = 'dugu';
  private artBossHits = new Map<Fighter, number>();
  private queuedArt: { art: SwordArt; face: -1 | 1 } | null = null;
  artNotice = '';
  artNoticeT = 0;
  private buffered: Intent = { ...NO_INTENT };
  private bufferT = 0;
  w = 80;
  h = 24;
  /** 地面所在的像素行（脚底贴在这一行上）。 */
  ground = 20;
  /** 火柴人身高（像素）。整套物理都按它缩放，所以任何画布尺寸下手感一致。 */
  fh = 12;
  /** 起跳初速。按"头顶不撞出画布"配出来的 —— 矮条形区域里自动变成小跳。 */
  jumpV = 12 * 5.4;

  readonly rng: Rng;
  phase: Phase = 'title';
  player: Fighter;
  enemies: Fighter[] = [];
  pieces: Piece[] = [];
  blood: Blood[] = [];
  /** 地上的血迹，打包成 `y * 4096 + x`。静止 → diff 之后每帧零成本。 */
  stains: number[] = [];
  slashes: Slash[] = [];

  /** 震动幅度（像素），指数衰减。 */
  shake = 0;
  shakeX = 0;
  shakeY = 0;
  /** 全世界冻结剩余（秒）。 */
  hitstop = 0;
  /** 清屏技的冲击波半径；null = 没在放。 */
  waveR: number | null = null;
  /** 全屏闪白剩余（秒）。只有清屏技用 —— 全画布变色是一次全量重绘，不能常用。 */
  flash = 0;

  kills = 0;
  /** 本次任务砍了多少 —— 横幅上报的就是这个数。 */
  taskKills = 0;
  combo = 0;
  bestCombo = 0;
  /** 当前固定步里出现过的最高连击；导演用它避开同帧受击/超时清零。 */
  stepComboPeak = 0;
  private comboT = 0;
  /** 玩家死了，重生倒计时。 */
  respawn = 0;
  deaths = 0;

  /** 打了多久（秒），出怪节奏按它加压。 */
  heat = 0;
  /** 宿主可限制实际参与战斗的敌人数，避免仅在渲染层隐藏敌人。 */
  enemyLimit = 11;
  private spawnT = 1.2;
  private readonly automaticSpawns: boolean;
  /** 清屏特效借用 gameplay RNG；任务恢复时回到清屏前，避免改变后续战斗。 */
  private taskRngState: number | null = null;
  time = 0;

  constructor(seed = 0x5eed1234, options: WorldOptions = {}) {
    this.rng = new Rng(seed);
    this.automaticSpawns = options.automaticSpawns !== false;
    this.player = this.makePlayer();
  }

  /* ── 尺寸 ──────────────────────────────────────────────────────── */

  /**
   * 画布尺寸变了（终端 resize / 焦点联动分屏）。
   *
   * 位置按比例缩放而不是清场：正在打的一场不该因为拖了一下窗口就重来。
   */
  resize(w: number, h: number): void {
    const speed0 = this.playerSpeed();
    const nw = Math.max(8, w);
    const nh = Math.max(2, h);
    const sx = nw / this.w;
    const sy = nh / this.h;
    this.w = nw;
    this.h = nh;
    this.ground = nh - Math.max(1, Math.round(nh * 0.08));
    // 身高**由地面以上的可用高度反推**，不是画布高度的固定比例。
    //
    // 原来是 `0.40 × 画布高`，在外壳的下半屏里直接崩了：焦点在 CLI 时游戏区约 8 行
    // = 16 个像素行，算出来 fh=7。7 像素高的火柴人，大腿只有 1.7 像素、
    // 髋角 0.18 弧度 → 两条腿的横向差不到 1 个像素，于是四肢全叠在躯干那一列上，
    // 画出来是"一个点 + 一条竖线"，根本不像人（用户的原话是"太抽象"）。
    //
    // 反推的写法保证矮区域里**尽可能占满**：留 1 像素贴地余量、再留 0.45×身高 给
    // 跳跃的头顶空间，剩下的全给身高。26 是上限 —— 再高就该做镜头而不是放大人。
    //
    // 条形区域（游戏只有 1~4 个字符行）另算：那里跳跃本来就无处可跳，所以不留头顶空间，
    // 把整条高度都给身高，只在头顶留一个像素的空气。4 个像素行能站一个 3 像素高的人。
    const budget = this.ground - 1;
    this.fh = budget >= 8
      ? clamp(Math.round(Math.min(budget / 1.45, 26)), 8, 26)
      : Math.max(1, this.ground - (this.ground >= 5 ? 1 : 0));
    // 跳跃初速：apex = v²/(2g)，g = fh×26。夹到实际头顶空间，头就永远不会飞出画布 ——
    // 没有空间时它就是 0，跳键变成空操作。**宁可不能跳，也不要头飞出画布。**
    const head = Math.max(0, this.ground - this.fh - 1);
    this.jumpV = Math.min(this.fh * 5.4, Math.sqrt(2 * this.fh * 26 * head));

    // 杂兵的速度按**玩家速度的变化比例**缩，而不是按竖直比例 sy —— 走路是横向的事，
    // 而且每个杂兵的速度里有一份随机偏移，按比例缩才能把那份个体差异留着。
    const ratio = this.playerSpeed() / speed0;
    for (const f of [this.player, ...this.enemies]) {
      f.x *= sx;
      f.y = this.ground;
      f.h = f.kind === 'player' ? this.fh : f.tag === 'boss' && !f.duelist ? bossHeight(this.fh, this.ground, f.bossKind) : Math.round(this.fh * (f.duelist ? 1.05 : 0.9));
      f.speed = f.kind === 'player' ? this.playerMoveSpeed() : f.speed * ratio;
      f.vx *= ratio;
      f.vy = 0;
      f.onGround = true;
    }
    for (const p of this.pieces) { p.x *= sx; p.y *= sy; }
    for (const b of this.blood) { b.x *= sx; b.y *= sy; }
    // 血迹坐标是打包的整数，缩放会算出重复格子，直接丢掉重来 —— 它只是装饰。
    this.stains.length = 0;
    this.slashes.length = 0;
  }

  /* ── 外部信号 ──────────────────────────────────────────────────── */

  /** 宽像素条扩展真实可走动边界；不落地、不重置招式或关卡。 */
  resizeArena(width: number): void {
    if (!Number.isFinite(width) || width < 8 || width === this.w) return;
    const sx = width / this.w, oldSpeed = this.playerSpeed();
    this.w = width;
    const ratio = this.playerSpeed() / oldSpeed;
    for (const f of [this.player, ...this.enemies]) {
      f.x *= sx; f.vx *= ratio; f.speed *= ratio;
      if (f.quakeX !== undefined) f.quakeX *= sx;
      if (f.enemyCast) f.enemyCast.x *= sx;
    }
    for (const item of [...this.pieces, ...this.blood, ...this.slashes, ...this.hazards]) item.x *= sx;
    if (this.swordCast) this.swordCast.x *= sx;
    this.stains.length = 0;
  }

  /** 任务跑完了：放清屏技，然后暂停等下一个任务。 */
  taskDone(): void {
    if (this.phase === 'clear') return;
    this.taskRngState = this.rng.snapshot();
    this.phase = 'clear';
    this.waveR = 0;
    this.flash = 0.10;
    this.shake = 2.6;
  }

  /** 一章重新布置战场；保留整轮累计战绩，不保留上一章的战斗瞬态。 */
  beginChapter(): void {
    this.resetBattle();
  }

  /** 下一个任务开始了：把上一场的尸堆冲掉，继续出怪。 */
  taskStart(): void {
    if (this.phase === 'fight') return;
    this.resetBattle();
  }

  private resetBattle(): void {
    if (this.taskRngState !== null) {
      this.rng.restore(this.taskRngState);
      this.taskRngState = null;
    }
    this.phase = 'fight';
    this.waveR = null;
    this.taskKills = 0;
    this.heat = 0;
    this.spawnT = 0.6;
    this.enemies.length = 0;
    this.pieces.length = 0;
    this.blood.length = 0;
    this.stains.length = 0;
    this.slashes.length = 0;
    this.hitstop = 0;
    this.swordCast = null;
    this.queuedArt = null;
    this.artBossHits.clear();
    this.hazards.length = 0;
    this.buffered = { ...NO_INTENT };
    this.bufferT = 0;
    this.flash = 0;
    this.shake = this.shakeX = this.shakeY = 0;
    this.combo = 0;
    this.stepComboPeak = 0;
    this.comboT = 0;
    this.respawn = 0;
    this.player = this.makePlayer();
  }

  /* ── 主步进 ────────────────────────────────────────────────────── */

  /** 固定步长推进一帧。`dt` 恒为 1/60 —— 变步长会让物理在掉帧时抽风。 */
  step(dt: number, input: Intent): void {
    this.stepComboPeak = this.combo;
    if (this.phase === 'paused') {
      if (input.slash) this.taskStart();
      return;
    }
    this.time += dt;
    this.artNoticeT = Math.max(0, this.artNoticeT - dt);
    // 顿帧/冲刺期间的脉冲留 180ms；方向仍采用当前帧，避免松手后回放走位。
    this.bufferT -= dt;
    if (this.bufferT <= 0) this.buffered = { ...NO_INTENT };
    if (input.slash || input.jump || input.dash || input.spin || input.art || input.armor) {
      this.buffered = { ...input, slash: input.slash || this.buffered.slash,
        jump: input.jump || this.buffered.jump, dash: !!(input.dash || this.buffered.dash),
        spin: !!(input.spin || this.buffered.spin), armor: !!(input.armor || this.buffered.armor), art: input.art ?? this.buffered.art,
        artFace: input.art ? input.artFace : this.buffered.artFace };
      this.bufferT = 0.18;
    }

    // 震动和闪白**不**受顿帧影响：它们是冲击的表现，不是世界的一部分。
    this.shake *= Math.exp(-dt * 11);
    if (this.shake < 0.05) this.shake = 0;
    this.shakeX = Math.round(this.rng.spread(this.shake));
    // 竖直分量按**身高**夹取。横向不夹：40 像素宽的条形场地里 3 像素的横移正是那一下
    // 冲击感，而且背景是整条 hline，横移一格在 diff 之后几乎不要钱。竖直就不一样了 ——
    // 条形模式整块画布只有 4 个像素行，1 像素的上下抖动等于把地面掀了。
    this.shakeY = Math.round(this.rng.spread(Math.min(this.shake * 0.55, this.fh * 0.12)));
    if (this.flash > 0) this.flash -= dt;

    if (this.hitstop > 0) { this.hitstop = Math.max(0, this.hitstop - dt); return; }
    if (this.player.dashT <= 0 && this.player.spinT <= 0) {
      input = { ...this.buffered, move: input.move, crouch: !!(input.crouch || this.buffered.crouch) };
      this.buffered = { ...NO_INTENT };
    } else {
      // 解控优先于冲刺/旋斩收招；顿帧期间保存的解控也只消费一次。
      input = { ...input, armor: !!(input.armor || this.buffered.armor) };
      this.buffered.armor = false;
    }
    const killsBefore = this.kills;

    if (this.phase === 'title' && (input.slash || input.move !== 0)) {
      this.phase = 'fight';
      this.spawnT = 0.35;
    }

    if (this.respawn > 0) {
      this.respawn -= dt;
      if (this.respawn <= 0) {
        this.player = this.makePlayer();
      }
    } else {
      this.stepPlayer(dt, input);
    }

    for (const e of this.enemies) this.stepGrunt(dt, e);
    const killsBeforeArt = this.kills;
    if (this.phase === 'fight') this.stepSwordArt(dt);
    const artKills = this.kills - killsBeforeArt;
    if (this.phase === 'fight') this.stepHazards(dt);
    this.stepPieces(dt);
    this.stepBlood(dt);
    this.stepSlashes(dt);

    if (this.phase === 'clear') this.stepWave(dt);
    else if (this.phase === 'fight') {
      const earned = this.kills - killsBefore;
      const previousLevel = playerGrowth(this.cultivation.insight).level;
      this.cultivation.insight += earned;
      if (earned > 0 && playerGrowth(this.cultivation.insight).level > previousLevel) {
        this.refreshPlayerGrowth();
        const growth = playerGrowth(this.cultivation.insight);
        this.artNotice = `修为${growth.level}重 · 体魄${growth.maxHp} · 技能周转提升`;
        this.artNoticeT = 2;
      }
      this.qi = Math.min(MAX_QI, this.qi + (earned - artKills) * 12);
      this.heat += dt;
      if (this.automaticSpawns) this.spawn(dt);
    }

    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }
  }

  /* ── 玩家 ──────────────────────────────────────────────────────── */

  /**
   * 玩家最高速度 = 身高 × 3（约每秒 3 个身位）。**只跟身高走**。
   *
   * 身高 ≤ 7 像素的退化条形是唯一的例外：40 像素宽的地上 3 像素高的人光靠身高项
   * 像爬，所以压一条"约 2 秒横穿一趟"的宽度下限。这个下限绝不能用在正常战场上 ——
   * 宽战场要的是更长的距离，不是更快的人；按 `w/2` 放大会让主角在宽屏上快成一道残影。
   *
   * 杂兵速度按玩家速度的比例派生，所以调速不改双方的相对追逐关系，只是整体手感。
   */
  private playerSpeed(): number {
    return this.fh < 8 ? Math.max(this.fh * 3.0, this.w / 2.0) : this.fh * 3.0;
  }
  private playerMoveSpeed(): number {
    return this.playerSpeed() * (this.fh < 8 ? 1 : PLAYER_MOVE_MULTIPLIER);
  }

  /** 增加上限时只补新增血格；存档恢复在新战场中可回满，死亡状态绝不复活。 */
  refreshPlayerGrowth(refill = false): void {
    const p = this.player, maxHp = playerGrowth(this.cultivation.insight).maxHp;
    if (p.hp > 0 && this.respawn <= 0) p.hp = refill ? maxHp : Math.min(maxHp, p.hp + Math.max(0, maxHp - (p.maxHp ?? 4)));
    p.maxHp = maxHp;
  }

  private makePlayer(): Fighter {
    const growth = playerGrowth(this.cultivation.insight);
    return {
      kind: 'player', x: this.w * 0.5, y: this.ground, vx: 0, vy: 0,
      h: this.fh, face: 1, onGround: true, hp: growth.maxHp, maxHp: growth.maxHp,
      walk: 0, anim: 0, atk: -1, atkHit: false, atkQueued: false,
      hurt: 0, land: 0, invuln: 0.6, windup: -1, cool: 0, speed: this.playerMoveSpeed(),
      dashT: 0, dashCool: 0, spinT: 0, spinCool: 0,
      pose: poseIdle(0), armed: true,
    };
  }

  private stepPlayer(dt: number, input: Intent): void {
    const p = this.player;
    p.anim += dt;
    const wasStunned = (p.stunT ?? 0) > 0;
    for (const key of ['armorT', 'armorCool', 'stunT', 'slowT', 'controlImmuneT'] as const) {
      if ((p[key] ?? 0) > 0) p[key] = Math.max(0, p[key]! - dt);
    }
    if (wasStunned && p.stunT === 0) p.controlImmuneT = 1;
    if (input.armor && this.phase === 'fight') {
      if ((p.armorCool ?? 0) <= 0) {
        const growth = playerGrowth(this.cultivation.insight);
        p.armorT = growth.armorDuration; p.armorCool = growth.armorCooldown;
        p.stunT = p.slowT = p.hurt = 0;
        p.controlImmuneT = 1;
        // 解除击退冲量；空中不瞬移、不强制落地。
        p.vx = 0;
        this.artNotice = '护体罡气 · 霸体'; this.artNoticeT = growth.armorDuration;
      } else {
        this.artNotice = `护体未就绪 ${Math.ceil(p.armorCool!)}秒`; this.artNoticeT = 0.6;
      }
    }
    if ((p.stunT ?? 0) > 0) input = { ...NO_INTENT };
    if (p.hurt > 0) p.hurt -= dt;
    if (p.invuln > 0) p.invuln -= dt;
    if (p.dashCool > 0) p.dashCool -= dt;
    if (p.spinCool > 0) p.spinCool -= dt;
    if ((p.sweepCool ?? 0) > 0) p.sweepCool = (p.sweepCool ?? 0) - dt;
    if ((p.lungeCool ?? 0) > 0) p.lungeCool = (p.lungeCool ?? 0) - dt;
    if (this.phase !== 'fight') this.queuedArt = null;
    if (input.art && this.phase === 'fight') this.castSwordArt(input.art, input.artFace ?? (input.move || p.face));
    else if ((p.stunT ?? 0) <= 0 && this.queuedArt && this.phase === 'fight' && (!this.swordCast || this.swordCast.age >= artRecovery(this.swordCast.full))) {
      const art = this.queuedArt; this.queuedArt = null; this.castSwordArt(art.art, art.face);
    }

    // 冲刺斩进行中：全程维持向前的冲量、每帧收割身上的杂兵，其它输入一律屏蔽。
    if (p.dashT > 0) {
      p.dashT -= dt;
      p.vx = p.face * this.playerSpeed() * 3.4;
      this.resolveDash(p);
      this.integrate(dt, p);
      p.pose = this.poseFor(p);
      return;
    }
    // 旋斩进行中：定身把这一圈转完（判定在起手那一下已经结算）。
    if (p.spinT > 0) {
      p.spinT -= dt;
      p.vx *= Math.exp(-dt * 12);
      this.integrate(dt, p);
      p.pose = this.poseFor(p);
      return;
    }

    // 起手只锁朝向；走位和跳跃始终响应，命中后可用冲刺/旋斩取消收招。
    const busy = p.atk >= 0 && p.atk < 0.14;
    if (busy && (input.dash || input.spin)) {
      this.buffered = { ...input, slash: false, jump: false };
      this.bufferT = 0.18;
    }

    // 技能优先于普通攻击：不在挥刀硬直里、且冷却好了才放。
    if (input.spin && !busy && p.onGround && p.spinCool <= 0) {
      this.startSpin(p);
      this.integrate(dt, p);
      p.pose = this.poseFor(p);
      return;
    }
    if (input.dash && !busy && p.dashCool <= 0) {
      this.startDash(p);
      this.resolveDash(p);
      this.integrate(dt, p);
      p.pose = this.poseFor(p);
      return;
    }

    if (input.slash) {
      if (p.atk < 0) {
        // 起手瞬间按世界状态选变招（终端无 key-up，只能读状态/缓冲窗，不是真同时按键）：
        // 空中→air 俯冲；地面蹲下→sweep 低扫；地面朝前→lunge 前冲；否则 normal。
        // sweep/lunge 是「强招」，各自扣冷却；冷却没好就退回 normal（普通刀永远能挥）。
        if (!p.onGround) p.atkKind = 'air';
        else if (input.crouch && (p.sweepCool ?? 0) <= 0) { p.atkKind = 'sweep'; p.sweepCool = SWEEP_COOL; }
        else if (input.move !== 0 && input.move === p.face && (p.lungeCool ?? 0) <= 0) {
          p.atkKind = 'lunge'; p.lungeCool = LUNGE_COOL;
          p.vx = p.face * this.playerSpeed() * 1.6;   // 起手一步前冲，随后被 busy 夹速收住 → 前倾破距感
        } else p.atkKind = 'normal';
        p.atk = 0; p.atkHit = false;
      } else p.atkQueued = true;
    }

    {
      if (input.move !== 0) {
        if (!busy) p.face = input.move > 0 ? 1 : -1;
        p.vx += (input.move * p.speed * ((p.slowT ?? 0) > 0 ? p.slowFactor ?? 0.6 : 1) - p.vx) * Math.min(1, dt * 34);
      }
      if (input.jump && p.onGround) { p.vy = -this.jumpV; p.onGround = false; }
    }
    const maxV = p.speed * ((p.slowT ?? 0) > 0 ? p.slowFactor ?? 0.6 : 1);
    p.vx = clamp(p.vx, -maxV, maxV);
    // 地面摩擦比空中大得多：地面要"停得住"，空中要保留冲量（跳劈才有距离感）。
    if (input.move === 0) p.vx *= Math.exp(-dt * (p.onGround ? 25 : 3));

    this.integrate(dt, p);

    if (p.atk >= 0) {
      p.atk += dt;
      // 判定放在挥出段的前段：视觉上刀正好扫到身前，而不是收招时才结算。
      if (!p.atkHit && p.atk >= 0.14) { p.atkHit = true; this.resolveSlash(p); }
      if (p.atk >= SLASH_RECOVERY) {
        p.atk = p.atkQueued ? 0 : -1;
        p.atkHit = false;
        p.atkQueued = false;
        // 连打接的下一刀默认普通刀：变招要重新满足条件（强招还得重新扣冷却），杜绝白嫖低扫/前冲。
        p.atkKind = 'normal';
      }
    }

    p.pose = this.poseFor(p);
  }

  /**
   * 非致命命中：多段血的 boss 掉一段血、被打断前摇、短暂无敌 + 击退。
   * 短无敌把"一次冲刺 11 帧重判"锁成一段血，否则 boss 会被一次冲刺直接连成秒杀。
   * grunt（hp=1）永远走不到这里，所以一刀一个的行为逐字节不变。
   */
  private castSwordArt(art: SwordArt, face: -1 | 1): void {
    if (this.swordCast !== null && this.swordCast.age < artRecovery(this.swordCast.full)) {
      // 只缓存收招前140ms内的一次输入；不排长队，不在早期乱按后自动连发。
      if (artRecovery(this.swordCast.full) - this.swordCast.age <= 0.14) this.queuedArt = { art, face };
      return;
    }
    this.queuedArt = null;
    const spec = SWORD_ARTS[art];
    this.artNoticeT = 1.8;
    if (this.cultivation.insight < spec.unlock) {
      this.artNotice = `${spec.short}未悟 · 阅历${this.cultivation.insight}/${spec.unlock}`;
      return;
    }
    const selection = selectSwordForm(art, this.qi, this.formProgress[art]);
    if (selection === null) {
      this.artNotice = `剑气不足 ${this.qi}/${spec.cost}`;
      return;
    }
    const level = artLevel(this.cultivation, art);
    this.qi -= selection.cost;
    this.formProgress[art][selection.tier] = (this.formProgress[art][selection.tier] + 1) % (SWORD_FORMS[art].length / 3);
    this.selectedArt = art;
    this.artBossHits.clear();
    this.cultivation.mastery[art]++;
    this.artNotice = `${isSecretArt(art) && this.cultivation.mastery[art] === 1 ? '悟得秘技！' : ''}${spec.name} · ${selection.full ? FULL_ART_NAMES[art] : SWORD_FORMS[art][selection.index]!.name}`;
    const p = this.player;
    p.face = face;
    this.swordCast = { art, x: p.x, y: p.y - this.fh * 0.5, face: p.face, age: 0, pulse: -1, level,
      formIndex: selection.index, full: selection.full };
    p.atk = -1; p.atkQueued = false;
    // 奥义只保护起手，后续仍能走位和躲避。
    p.invuln = Math.max(p.invuln, 0.35);
    if (selection.full) {
      // 奥义出手配一记顿帧 + 爆闪 + 震屏：先读出"要放大了"，演出才谈得上震撼。
      this.flash = Math.max(this.flash, 0.55);
      this.shake = Math.max(this.shake, 2.4);
      this.hitstop = Math.max(this.hitstop, 0.07);
    }
  }

  private stepSwordArt(dt: number): void {
    const cast = this.swordCast;
    if (cast === null) return;
    cast.age += dt;
    if (cast.age > artDuration(cast.art, cast.full)) { this.swordCast = null; this.artBossHits.clear(); return; }
    const form = currentSwordForm(cast);
    const pulse = cast.full ? Math.min(2, Math.floor(cast.age / 0.4))
      : Math.min(form.qi >= 60 ? 1 : 0, Math.floor(cast.age / 0.32));
    if (pulse === cast.pulse) return;
    cast.pulse = pulse;
    cast.x = this.player.x; cast.y = this.player.y - this.fh * 0.5;
    if (cast.full) {
      const discovered = pulse === 0 && isSecretArt(cast.art) && this.cultivation.mastery[cast.art] === 1;
      this.artNotice = `${discovered ? '悟得秘技！' : ''}${SWORD_ARTS[cast.art].name} · ${FULL_ART_NAMES[cast.art]}`;
      this.artNoticeT = 0.8;
    }
    const radial = form.radial;
    const reach = this.fh * (form.reach + (cast.level - 1) * 0.15);
    let kills = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      const dx = (e.x - cast.x) * cast.face;
      if (radial ? Math.abs(dx) > reach : dx < -this.fh * 0.4 || dx > reach) continue;
      if (Math.abs(e.y - e.h * 0.4 - cast.y) > this.fh * 1.5 || e.invuln > 0) continue;
      if (e.tag === 'boss') {
        const hits = this.artBossHits.get(e) ?? 0;
        if (hits >= (cast.full ? 3 : form.qi >= 60 ? 2 : 1)) continue;
        this.artBossHits.set(e, hits + 1);
      }
      const dir = e.x >= cast.x ? 1 : -1;
      if (e.hp > 1) { this.staggerEnemy(e, dir, false); continue; }
      this.dismember(e, e.y - e.h * 0.4, dir, 1.4);
      this.enemies.splice(i, 1); kills++;
    }
    if (kills > 0) {
      this.kills += kills; this.taskKills += kills; this.combo += kills;
      this.comboT = 2;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.stepComboPeak = Math.max(this.stepComboPeak, this.combo);
    }
    // 剑阵连续演出不冻结世界；震动仅第一次轻点一下。
    if (pulse === 0) this.shake = Math.max(this.shake, 0.8);
  }

  private staggerEnemy(e: Fighter, dir: number, chargeQi = true): void {
    const before = e.hp;
    e.hp -= 1;
    // 金色蓄势只抗打断，正常掉血/回气；短无敌仍阻止一次冲刺多次扣血。
    if (bossArmored(e)) {
      e.invuln = STAGGER_INVULN;
      if (chargeQi) this.qi = Math.min(MAX_QI, this.qi + BOSS_HIT_QI);
      return;
    }
    e.hurt = 0.3;
    e.invuln = STAGGER_INVULN;
    e.windup = -1;
    e.cool = Math.max(e.cool, 0.45);
    e.vx = dir * this.fh * 1.2;
    // 打断进行中的 boss 招式（挨打就收招），并在跨阶段那一下给一记闪光震屏当"暴走/困兽"节拍。
    if (e.tag === 'boss' || e.duelist) {
      // 只奖励确实扣血的普通攻击，剑招自身不能回气形成永动。
      if (chargeQi) this.qi = Math.min(MAX_QI, this.qi + BOSS_HIT_QI);
      e.dashT = 0;
      e.spinT = 0;
      delete e.followupT;
      delete e.quakeX;
      delete e.enemyCast;
      e.guard = 0;
      if (e.duelist) {
        e.pressureHits = (e.pressureHits ?? 0) + 1;
        // 连续硬吃三刀后架剑，避免按住普攻便能永久压住剑客。
        if ((e.bossRank ?? 0) >= 3 && e.pressureHits % 3 === 0) e.guard = 0.5;
      }
      this.slashes.push({ x: e.x, y: e.y - e.h * 0.45, r: e.h * 0.42,
        a0: -2.4, a1: 0.4, life: 0.18, max: 0.18, big: true });
      if (bossPhase(before, e.maxHp) !== bossPhase(e.hp, e.maxHp)) {
        // 掉到 hp4/hp2 那两刀是"暴走/困兽"变招节拍：卡一帧再爆闪震屏，不可错过。
        this.flash = Math.max(this.flash, 0.7);
        this.shake = Math.min(4, this.shake + 2.0);
        this.hitstop = Math.max(this.hitstop, 0.08);
      }
    }
  }

  /** 守势只挡一次正面普通刀；剑招、冲刺、旋斩和绕背均可破守。 */
  private swordGuard(e: Fighter, p: Fighter): boolean {
    if (!e.duelist || (e.guard ?? 0) <= 0 || (p.x - e.x) * e.face < 0 || !p.onGround) return false;
    e.guard = 0;
    e.windup = 0.55; // 拼剑后先亮预警再反击，不能瞬间偷伤。
    e.vx = -e.face * this.fh * 0.5;
    this.qi = Math.min(MAX_QI, this.qi + 4);
    this.artNotice = '铮！拼剑 · 剑招 / 绕背破守'; this.artNoticeT = 1.2;
    this.hitstop = Math.max(this.hitstop, 0.035);
    this.slashes.push({ x: (e.x + p.x) / 2, y: e.y - this.fh * 0.6, r: this.fh * 0.45,
      a0: -2.6, a1: 0.6, life: 0.16, max: 0.16, big: true });
    return true;
  }

  /** 冲刺斩起手：定住方向窜出去，给足穿过全程的无敌帧，取消手上的普通刀。 */
  private startDash(p: Fighter): void {
    p.dashT = DASH_TIME;
    p.dashCool = DASH_COOL * playerGrowth(this.cultivation.insight).skillCooldown;
    p.atk = -1; p.atkHit = false; p.atkQueued = false;
    p.vx = p.face * this.playerSpeed() * 3.4;
    p.invuln = Math.max(p.invuln, DASH_TIME + 0.08);
  }

  /** 冲刺途中把贴到身上的杂兵带碎。不给顿帧 —— 顿帧会冻住冲刺，冲刺要的是"一穿到底"。 */
  private resolveDash(p: Fighter): void {
    let hit = 0; let staggered = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      if (Math.abs(e.x - p.x) > this.fh * 0.7) continue;
      if (e.invuln > 0) continue;
      if (e.y - e.h > p.y + this.fh * 0.15 || e.y < p.y - this.fh * 1.05) continue;
      if (e.hp > 1) { if (e.invuln <= 0) { this.staggerEnemy(e, p.face); staggered++; } continue; }
      this.dismember(e, e.y - e.h * this.rng.range(0.4, 0.7), p.face, 1.2);
      this.enemies.splice(i, 1);
      hit++;
    }
    if (hit > 0) {
      this.kills += hit; this.taskKills += hit; this.combo += hit;
      this.stepComboPeak = Math.max(this.stepComboPeak, this.combo);
      this.comboT = 1.6;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.shake = Math.min(3.2, this.shake + 0.7 + hit * 0.3);
    } else if (staggered > 0) {
      this.shake = Math.min(3.2, this.shake + 0.6);
    }
  }

  /** 旋斩起手：定身、把一圈范围内的杂兵全朝外侧砍飞，留一道整圈刀光。 */
  private startSpin(p: Fighter): void {
    p.spinT = SPIN_TIME;
    p.spinCool = SPIN_COOL * playerGrowth(this.cultivation.insight).skillCooldown;
    p.atk = -1; p.atkHit = false; p.atkQueued = false;
    const reach = this.fh * 1.55;
    let hit = 0; let staggered = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      if (Math.abs(e.x - p.x) > reach) continue;
      if (e.invuln > 0) continue;
      if (e.y - e.h > p.y + this.fh * 0.2 || e.y < p.y - this.fh * 1.15) continue;
      const dir = e.x >= p.x ? 1 : -1;
      if (e.hp > 1) { if (e.invuln <= 0) { this.staggerEnemy(e, dir); staggered++; } continue; }
      this.dismember(e, e.y - e.h * this.rng.range(0.35, 0.7), dir, 1.35);
      this.enemies.splice(i, 1);
      hit++;
    }
    // 整圈刀光：a0→a1 跨满一圈，渲染层照现有的弧线画法扫一整周。
    this.slashes.push({
      x: p.x, y: p.y - this.fh * 0.55, r: reach * 0.95,
      a0: -Math.PI, a1: Math.PI, life: 0.22, max: 0.22, big: true,
    });
    if (hit > 0) {
      this.kills += hit; this.taskKills += hit; this.combo += hit;
      this.stepComboPeak = Math.max(this.stepComboPeak, this.combo);
      this.comboT = 1.6;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.hitstop = Math.min(0.033, 0.018 + hit * 0.004);
      this.shake = Math.min(3.4, this.shake + 1.0 + hit * 0.3);
    } else if (staggered > 0) {
      this.hitstop = 0.04;
      this.shake = Math.min(3.4, this.shake + 0.8);
    } else {
      this.shake = Math.min(3.4, this.shake + 0.5);
    }
  }

  /** 一刀的判定。命中的每一个杂兵都当场砍碎。变招（air/sweep/lunge）改的是够到的范围与手感。 */
  private resolveSlash(p: Fighter): void {
    const kind: AttackKind = p.atkKind ?? 'normal';
    // 蹲斩低扫够得最宽、前冲斩其次、普通/俯冲照旧。
    const reach = this.fh * (kind === 'sweep' ? 1.5 : kind === 'lunge' ? 1.35 : 1.15);
    // 俯冲斩：竖直判定带朝下大幅放宽 —— 否则跳在半空挥刀常够不到地面的人。
    const lowGate = this.fh * (kind === 'air' ? 1.7 : 0.15);
    // 蹲斩把刀光压到腿部，其余照旧从肩上扫下。
    const pivotY = p.y - this.fh * (kind === 'sweep' ? 0.32 : 0.72);
    // 蹲斩扫飞得更狠一点，一排贴身杂兵一起带走的观感。
    const power = kind === 'sweep' ? 1.3 : 1;
    let hit = 0; let staggered = 0;
    // 从后往前删，命中多个就是多个 —— 挤成一团的杂兵被一刀带走是这游戏最爽的瞬间。
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      const dx = (e.x - p.x) * p.face;
      if (dx < -this.fh * 0.35 || dx > reach) continue;
      if (e.invuln > 0) continue;
      // 竖直重叠：拿双方的身体区间比，跳劈砍不到脚下的人才合理（俯冲斩放宽了下界）。
      if (e.y - e.h > p.y + lowGate || e.y < p.y - this.fh * 1.05) continue;
      if (this.swordGuard(e, p)) continue;
      // 多段血的 boss 先掉血、被打断、短无敌；grunt 走不到这里（hp=1）。
      if (e.hp > 1) { if (e.invuln <= 0) { this.staggerEnemy(e, p.face); staggered++; } continue; }
      // 越远砍得越低 —— 刀是扫下来的，边缘够到的是腿；蹲斩本就贴地扫腿。
      const frac = clamp(dx / reach, 0, 1);
      const cutY = kind === 'sweep'
        ? e.y - e.h * clamp(0.32 - frac * 0.14, 0.12, 0.4)
        : e.y - e.h * clamp(0.78 - frac * 0.5, 0.18, 0.88);
      this.dismember(e, cutY, p.face, power);
      this.enemies.splice(i, 1);
      hit++;
    }

    // 刀光形状本身就是区分变招的第二信号（姿态之外）：
    //   normal 斜扫、sweep 贴地宽弧、air 陡直下劈粗弧、lunge 近水平窄弧 + 多留两帧当前冲残影。
    const arc = kind === 'sweep' ? { a0: -0.9, a1: 1.4 }
      : kind === 'air' ? { a0: -2.4, a1: 0.15 }
        : kind === 'lunge' ? { a0: -0.45, a1: 0.5 }
          : { a0: -1.95, a1: 0.65 };
    const rMul = kind === 'air' ? 0.98 : 0.92;
    const life = kind === 'lunge' ? 0.17 : 0.14;
    this.slashes.push({
      x: p.x + p.face * this.fh * 0.1, y: pivotY, r: reach * rMul,
      a0: p.face > 0 ? arc.a0 : Math.PI - arc.a0, a1: p.face > 0 ? arc.a1 : Math.PI - arc.a1,
      life, max: life, big: kind === 'sweep' || kind === 'air',
    });

    // 俯冲斩命中即向下砸 —— 把跳斩坐实成"从空中劈下来"。
    if (kind === 'air' && (hit > 0 || staggered > 0)) p.vy = Math.max(p.vy, this.fh * 10);

    if (hit > 0) {
      const comboBefore = this.combo;
      this.kills += hit;
      this.taskKills += hit;
      this.combo += hit;
      this.stepComboPeak = Math.max(this.stepComboPeak, this.combo);
      this.comboT = 1.6;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      // 手感按变招分档：俯冲=砸地重顿、低扫=横向大震、前刺=脆快小顿+一记刺穿闪光、平砍照旧。
      // 普通命中最多两帧，里程碑最多 40ms；输入在停顿期间照常缓存。
      const base = kind === 'air' ? 0.025 : 0.016;
      const cap = 0.033;
      let stop = Math.min(cap, base + hit * 0.003);
      // 连击里程碑（5/10/15）那一下额外顿一记，"越连越沉"——只加顿帧，不改 combo 数值、不加全屏
      // flash（flash 会把背景抬进 legibility 描边隔离禁带并顶爆字节）。里程碑的视觉靠 HUD 连击数。
      if (MILESTONES.some((m) => comboBefore < m && this.combo >= m)) stop = Math.min(0.04, stop + 0.008);
      this.hitstop = stop;
      const shakeAdd = kind === 'sweep' ? 1.1 : kind === 'air' ? 1.0 : kind === 'lunge' ? 0.6 : 0.85;
      this.shake = Math.min(2.8, this.shake + shakeAdd + hit * 0.35);
      if (kind === 'lunge') this.flash = Math.max(this.flash, 0.12);
    } else if (staggered > 0) {
      // 砍在 boss 身上没砍死也要有"咚"，否则打厚血像打棉花。
      // 用 max 而非直接赋值：跨阶段那一刀在 staggerEnemy 里已抬到 0.08，别被这里覆盖回 0.05。
      this.hitstop = Math.max(this.hitstop, 0.05);
      this.shake = Math.min(2.8, this.shake + 0.7);
    }
  }

  /* ── 杂兵 ──────────────────────────────────────────────────────── */

  /** 整队要么一起出现，要么一个都不出现；章节导演靠这个维持构图语义。 */
  spawnFormation(formation: SpawnFormation): boolean {
    const capacity = this.enemyLimit - this.enemies.length;
    const sides: SpawnSide[] = formation.kind === 'single' ? [formation.side]
      : formation.kind === 'pair' ? [formation.side, formation.side]
        : formation.kind === 'pincer' ? ['left', 'right']
          : Array.from({ length: Math.max(0, capacity) }, (_, i) => i % 2 === 0
            ? formation.side : formation.side === 'left' ? 'right' : 'left');
    if (sides.length === 0 || sides.length > capacity) return false;
    const made = sides.map((side, index) => this.makeGrunt(side, index, sides.length));
    if (formation.kind === 'pair') for (let i = 0; i < made.length; i++) {
      const sign = formation.side === 'left' ? -1 : 1;
      made[i]!.x = this.player.x + sign * this.fh * (0.4 + i * 0.63);
      made[i]!.face = sign === 1 ? -1 : 1;
    }
    this.enemies.push(...made);
    return true;
  }

  /**
   * 生成一个 boss。**独立于 spawnFormation**：测试锁死了第 1/4 章的 spawnFormation 日程，
   * boss 走单独入口就不会碰它。多段血、更大更慢，其余复用 makeGrunt（照常抽 5 个 RNG，
   * 确定性成立；boss 只由导演在第 3/6/9 章生成，不进裸 World / 字节预算测试的路径）。
   *
   * 满场返回 false，导演每帧重试并阻止提前结算；绝不能删掉存活杂兵腾位。
   * 失败不消耗 RNG，且保证总数不超过 enemyLimit。已有 boss 时不再生成。
   */
  spawnBoss(side: SpawnSide, chapter = 3, kind: BossKind = this.biome === undefined ? 'spider' : bossKindForChapter(chapter)): boolean {
    if (this.enemies.some((e) => e.tag === 'boss')) return false;
    if (this.enemies.length >= this.enemyLimit) return false;
    if (this.enemyLimit < 1) return false;
    const boss = this.makeGrunt(side);
    boss.tag = 'boss';
    boss.bossKind = kind;
    if (kind === 'spider') delete boss.species;
    else boss.species = kind;
    const difficulty = bossDifficulty(chapter);
    boss.hp = difficulty.hp;
    boss.maxHp = difficulty.hp;
    boss.bossRank = difficulty.rank;
    boss.h = bossHeight(this.fh, this.ground, kind);
    boss.speed *= 0.6 * difficulty.speed;
    boss.cool = 0.6;   // 入场先走两步，不立刻起手
    this.enemies.push(boss);
    // 登场节拍：boss 一现身就闪光震屏顿一下——"摸鱼切进来"也能在 0.5 秒内读到"来大的了"。
    // 纯 VFX 字段、零 RNG；hitstop 是 reduceMotion 下唯一幸存的反馈。
    this.flash = Math.max(this.flash, 0.6);
    this.shake = Math.min(4, this.shake + 1.6);
    this.hitstop = Math.max(this.hitstop, 0.06);
    return true;
  }

  spawnDuelist(side: SpawnSide, chapter: number, boss = false): boolean {
    if (this.enemies.length >= this.enemyLimit || this.enemies.some(e => e.duelist)) return false;
    const e = this.makeGrunt(side), rank = bossDifficulty(chapter).rank;
    e.duelist = Math.floor(chapter / (boss ? 9 : 5)) % 2 ? 'qingfeng' : 'xuanyi';
    e.tag = boss ? 'boss' : 'swordsman';
    delete e.species;
    e.armed = true; e.h = Math.round(this.fh * 1.05);
    e.hp = e.maxHp = duelistHp(chapter, boss);
    e.bossRank = rank;
    e.speed = this.playerSpeed() * (e.duelist === 'qingfeng' ? 0.55 + rank * 0.0115 : 0.45 + rank * 0.0075);
    e.cool = 0.7; e.guard = 0;
    this.enemies.push(e);
    this.artNotice = `${boss ? '剑宗临阵' : '剑客问剑'} · ${e.duelist === 'qingfeng' ? '青锋' : '玄衣'}`;
    this.artNoticeT = 2;
    return true;
  }

  private makeGrunt(side: SpawnSide, index = 0, count = 1): Fighter {
    const fromLeft = side === 'left';
    const stacked = count > 1 ? (index - (count - 1) / 2) * this.fh * 0.24 : 0;
    // 抽取顺序必须原样保留：h、walk、anim、cool、speed。任何插入/改动都会移位共享 RNG 流，
    // 打挂确定性和字节预算测试。tag 只从**已抽到的** hRatio/spdRatio 纯算术派生，零新抽取。
    const hRatio = this.rng.range(0.78, 1.0);
    const walk = this.rng.float();
    const anim = this.rng.float() * 3;
    const cool = this.rng.range(0, 0.5);
    const spdRatio = this.rng.range(0.35, 0.56);
    const tag: EnemyTag = hRatio >= 0.92 ? 'brute'
      : hRatio <= 0.85 ? 'runner'
        : 'grunt';
    const biome = this.biome;
    const habitats: readonly (readonly Species[])[] = [
      ['mantis', 'scarab'], ['crab', 'eel'], ['idol', 'mantis'], ['scorpion', 'scarab'],
      ['wolf', 'crystal'], ['bat', 'idol'], ['mantis', 'scarab'], ['eel', 'crab'], ['crystal', 'wolf'], ['idol', 'bat'],
    ];
    const species = biome === undefined ? undefined : habitats[biome % 10]?.[tag === 'runner' ? 0 : 1];
    return {
      kind: 'grunt', tag,
      ...(species === undefined ? {} : { species }),
      x: fromLeft ? -this.fh * 0.5 - stacked : this.w + this.fh * 0.5 + stacked,
      y: this.ground, vx: 0, vy: 0, h: Math.round(this.fh * hRatio),
      face: fromLeft ? 1 : -1, onGround: true, hp: 1,
      walk, anim,
      atk: -1, atkHit: false, atkQueued: false, hurt: 0, land: 0, invuln: 0,
      windup: -1, cool,
      speed: this.playerSpeed() * spdRatio * (tag === 'runner' ? 1.25 : tag === 'brute' ? 0.8 : 1),
      dashT: 0, dashCool: 0, spinT: 0, spinCool: 0,
      pose: poseIdle(0), armed: false,
    };
  }

  private spawn(dt: number): void {
    this.spawnT -= dt;
    // 上限同时受场地宽度约束：一个人占 0.45×身高 的间距，40 像素宽塞 11 个就是一堵墙。
    const maxLive = Math.min(this.enemyLimit, 11, Math.max(2, Math.round(this.w / 12)), 3 + Math.floor(this.heat / 7));
    if (this.spawnT > 0 || this.enemies.length >= maxLive) return;
    this.spawnT = clamp(1.5 - this.heat * 0.045, 0.42, 1.5) * this.rng.range(0.7, 1.3);

    const side: SpawnSide = this.rng.chance(0.5) ? 'left' : 'right';
    this.enemies.push(this.makeGrunt(side));
  }

  private stepGrunt(dt: number, e: Fighter): void {
    e.anim += dt;
    if (e.cool > 0) e.cool -= dt;
    // 被打断/砍击后的短无敌：grunt 恒为 0 → 无可观察变化、不碰 RNG；只有 boss 用得上。
    if (e.invuln > 0) e.invuln -= dt;
    if (e.hurt > 0) {
      e.hurt = Math.max(0, e.hurt - dt);
      if (e.hurt > 0.16) {
        e.vx *= Math.exp(-dt * 6);
        this.integrate(dt, e); e.pose = this.poseFor(e);
        return;
      }
    }

    // boss 走独立 AI（多阶段冲撞/横扫）；grunt 路径逐字节不变。
    if (e.duelist) { this.stepDuelist(dt, e); return; }
    if (e.tag === 'boss') { this.stepBoss(dt, e); return; }

    const p = this.player;
    const alive = this.respawn <= 0;
    const dx = p.x - e.x;
    const near = Math.abs(dx) < this.fh * 0.85;

    if (e.windup >= 0) {
      e.windup -= dt;
      e.vx *= Math.exp(-dt * 14);
      if (e.windup <= 0) {
        e.windup = -1;
        e.cool = this.rng.range(0.9, 1.5);
        if (alive && Math.abs(p.x - e.x) < this.fh * 1.05 && p.invuln <= 0) this.hurtPlayer(Math.sign(e.face));
      }
    } else if (alive && near && e.cool <= 0) {
      e.windup = GRUNT_WINDUP;
      e.face = dx >= 0 ? 1 : -1;
    } else if (alive && this.phase !== 'clear') {
      e.face = dx >= 0 ? 1 : -1;
      e.vx += e.face * e.speed * 9 * dt;
      e.vx = clamp(e.vx, -e.speed, e.speed);
      // 互相推开一点，不然一群人会完全重叠成一个人。
      for (const o of this.enemies) {
        if (o === e) continue;
        const d = o.x - e.x;
        if (Math.abs(d) < this.fh * 0.45) e.vx -= Math.sign(d || 1) * this.fh * 1.5 * dt;
      }
    } else {
      e.vx *= Math.exp(-dt * 8);
    }

    this.integrate(dt, e);
    e.pose = this.poseFor(e);
  }

  /** 剑客共享玩家剑谱和骨架，但有独立伤害判定、可打断前摇与有限守势。 */
  private stepDuelist(dt: number, e: Fighter): void {
    const p = this.player, alive = this.respawn <= 0 && this.phase === 'fight';
    const dx = p.x - e.x;
    if (!alive) {
      delete e.enemyCast; e.windup = -1; e.guard = 0; e.vx *= Math.exp(-dt * 10);
      this.integrate(dt, e); e.pose = poseIdle(e.anim); return;
    }
    if (e.enemyCast) {
      const cast = e.enemyCast;
      cast.age += dt;
      const form = currentSwordForm(cast);
      if (cast.pulse < 0 && cast.age >= (form.shape === 'rain' ? 0.3 : 0.16)) {
        cast.pulse = 0;
        const reach = this.fh * form.reach, front = (p.x - cast.x) * cast.face;
        const inRange = form.radial ? Math.abs(front) <= reach : front >= 0 && front <= reach;
        const high = form.shape === 'rain' ? p.y >= this.ground - this.fh * 0.3
          : Math.abs(p.y - p.h * 0.5 - cast.y) < this.fh * 0.4;
        if (inRange && high) {
          const parry = Math.abs(dx) < this.fh * 1.6 && (e.x - p.x) * p.face >= 0
            && ((p.atk >= 0.08 && p.atk <= 0.23) || p.spinT > 0);
          if (parry) {
            this.qi = Math.min(MAX_QI, this.qi + 6);
            e.hurt = 0.22; e.cool = 0.8;
            this.artNotice = '铮！截剑成功 +6气'; this.artNoticeT = 1;
            this.hitstop = Math.max(this.hitstop, 0.04);
            this.slashes.push({ x: (p.x + e.x) / 2, y: cast.y, r: this.fh * 0.5,
              a0: -2.4, a1: 0.5, life: 0.18, max: 0.18, big: true });
          } else if (p.invuln <= 0) this.hurtPlayer(p.x >= e.x ? 1 : -1);
        }
      }
      // 青锋突刺前踏，玄衣落剑定身；出招不追踪瞬移。
      e.vx = e.duelist === 'qingfeng' && cast.age < 0.24 ? e.face * e.speed * 1.25 : e.vx * Math.exp(-dt * 16);
      if (cast.age >= 0.65) {
        delete e.enemyCast;
        e.cool = Math.max(0.85, 1.3 - (e.bossRank ?? 0) * 0.0225);
        e.guard = (e.bossRank ?? 0) < 3 ? 0 : e.duelist === 'xuanyi' ? 0.42 : 0.25;
      }
      e.pose = poseSlash(clamp(cast.age / 0.65, 0, 1));
    } else if (e.windup >= 0) {
      e.windup -= dt; e.vx *= Math.exp(-dt * 14);
      e.pose = poseWindup(clamp(1 - e.windup / duelistWindup(e), 0, 1));
      if (e.windup <= 0) {
        const seq = e.atkSeq ?? 0;
        e.enemyCast = { ...duelistFormFor(e),
          x: e.x, y: e.y - this.fh * 0.5, face: e.face, age: 0, pulse: -1, level: 1 };
        e.atkSeq = seq + 1; e.windup = -1; e.guard = 0;
      }
    } else {
      e.guard = Math.max(0, (e.guard ?? 0) - dt);
      e.face = dx >= 0 ? 1 : -1;
      const distance = Math.abs(dx), preferred = this.fh * (e.duelist === 'qingfeng' ? 1.1 : 2.1);
      if (e.cool <= 0 && distance < this.fh * (e.duelist === 'qingfeng' ? 2.6 : 3.8)) {
        e.windup = duelistWindup(e); e.guard = 0;
      }
      const direction = distance > preferred ? e.face : distance < this.fh * 0.65 && e.cool > 0.3 ? -e.face : 0;
      e.vx += (direction * e.speed - e.vx) * Math.min(1, dt * 14);
      e.walk += Math.abs(e.vx) * dt / this.fh;
      e.pose = (e.guard ?? 0) > 0 ? poseWindup(0.4) : Math.abs(e.vx) > 1 ? poseWalk(e.walk) : poseIdle(e.anim);
    }
    this.integrate(dt, e);
  }

  /**
   * Boss AI：按剩余血量分三阶段，招式**确定性轮换**（用 `atkSeq` 计数，零新 RNG；
   * 收招沿用 grunt 那处 `rng.range(0.9,1.5)`，每次出招恰好一抽，与 grunt 一致）。
   * - Phase 1 重压（hp 5-4）：只有 `BOSS_WINDUP` 长前摇重击近战（守住满血=近战的回归测试）。
   * - Phase 2 暴走（hp 3-2）：近战与**冲撞**交替；冲撞窜出、途中撞到玩家就伤。
   * - Phase 3 困兽（hp 1）：再加**范围横扫**；一圈刀光，扫到玩家就伤。
   * boss 借用 `dashT/spinT` 只作自身计时 + 让 poseFor 免费出姿态；玩家专属的 resolveDash/
   * startSpin 以 this.player 扫 this.enemies，永不被敌人的 dashT/spinT 触发，隔离干净。
   */
  private stepBoss(dt: number, e: Fighter): void {
    if (e.bossKind && e.bossKind !== 'spider') { this.stepVariantBoss(dt, e); return; }
    const p = this.player;
    const alive = this.respawn <= 0;

    // 冲撞进行中：维持朝玩家的高速冲量，每帧判定撞到玩家没有。
    if ((e.dashT ?? 0) > 0) {
      e.dashT -= dt;
      e.vx = e.face * e.speed * 6.5;
      if (alive) this.resolveBossCharge(e);
      this.integrate(dt, e);
      e.pose = this.poseFor(e);
      return;
    }
    // 横扫进行中：定身把这一圈转完（判定在起手那一下已结算）。
    if ((e.spinT ?? 0) > 0) {
      e.spinT -= dt;
      e.vx *= Math.exp(-dt * 12);
      this.integrate(dt, e);
      e.pose = this.poseFor(e);
      return;
    }

    const dx = p.x - e.x;
    const phase = bossPhase(e.hp, e.maxHp);
    // 每四招一次锁定脚下；与三招轮换错开，不覆盖掉困兽阶段的全部冲撞。
    const quake = (e.atkSeq ?? 0) % 4 === 1;
    // 冲撞够得远（跨半场），近战/横扫要贴身；起手门按「本次要出的招」放宽。
    const move = bossMoveFor(phase, e.atkSeq ?? 0);
    const engageReach = quake ? this.w : move === 'charge' ? this.fh * 5 : this.fh * 1.15;
    const near = Math.abs(dx) < engageReach;

    if (e.windup >= 0) {
      e.windup -= dt;
      e.vx *= Math.exp(-dt * 14);
      if (e.windup <= 0) {
        e.windup = -1;
        e.cool = this.rng.range(0.9, 1.5) * Math.max(0.65, 1 - (e.bossRank ?? 0) * 0.0175);
        e.atkSeq = (e.atkSeq ?? 0) + 1;
        if (e.quakeX !== undefined) {
          const center = e.quakeX;
          for (const offset of bossQuakeOffsets(e)) this.hazards.push({
            x: clamp(center + offset * this.fh * 1.5, 0, this.w), radius: this.fh * 0.48,
            timer: 0.38 + Math.abs(offset) * 0.14, life: 0.42, hit: false,
          });
          delete e.quakeX;
          e.vx = 0;
          this.shake = Math.max(this.shake, 1.2);
        } else this.launchBossMove(e, move);
      }
    } else if (alive && near && e.cool <= 0) {
      e.windup = Math.max(0.65, BOSS_WINDUP - (e.bossRank ?? 0) * 0.01);
      e.face = dx >= 0 ? 1 : -1;
      if (quake) e.quakeX = p.x;
    } else if (alive && this.phase !== 'clear') {
      e.face = dx >= 0 ? 1 : -1;
      // 暴走/困兽提速：越残血逼得越紧。
      const chase = phase === 1 ? 9 : 12;
      e.vx += e.face * e.speed * chase * dt;
      e.vx = clamp(e.vx, -e.speed * (phase === 1 ? 1 : 1.4), e.speed * (phase === 1 ? 1 : 1.4));
    } else {
      e.vx *= Math.exp(-dt * 8);
    }

    this.integrate(dt, e);
    e.pose = this.poseFor(e);
  }

  /** 三种大型妖物：锁定方向/落点的预警 → 招牌动作 → 可追击的收招。 */
  private stepVariantBoss(dt: number, e: Fighter): void {
    const p = this.player, alive = this.respawn <= 0 && this.phase === 'fight';
    const abilities = bossAbilities(e);
    const margin = Math.min(e.h * 0.65, this.w * 0.2);
    if (alive && e.windup < 0 && e.dashT <= 0 && (e.followupT ?? 0) <= 0
      && (e.x < margin || e.x > this.w - margin)) {
      // 出场和被击退到边界后先回到场内；远程头目不能隔着屏幕外永久施法。
      e.face = e.x < margin ? 1 : -1;
      e.vx = e.face * e.speed;
      this.integrate(dt, e); e.pose = this.poseFor(e); return;
    }
    if (e.dashT > 0) {
      e.dashT = Math.max(0, e.dashT - dt);
      e.vx = e.face * e.speed * 6.5;
      if (alive && p.invuln <= 0 && Math.abs(p.x - e.x) < variantBossReach(e)
        && p.y > e.y - e.h * 0.72) this.hurtPlayer(e.face, abilities.push ? 'push' : undefined);
      this.integrate(dt, e); e.pose = this.poseFor(e);
      if (e.dashT <= 0) { e.vx = 0; e.cool = abilities.recovery; }
      return;
    }
    if ((e.followupT ?? 0) > 0) {
      e.followupT = Math.max(0, e.followupT! - dt);
      if (e.followupT <= 0) {
        if (alive) this.mantisStrike(e, true);
        e.cool = abilities.recovery;
      }
      e.vx = 0; e.pose = this.poseFor(e); return;
    }
    if (e.windup >= 0) {
      e.windup -= dt;
      e.vx = 0;
      if (e.windup <= 0) {
        e.windup = -1;
        e.atkSeq = (e.atkSeq ?? 0) + 1;
        e.cool = abilities.recovery;
        if (alive) {
          if (e.bossKind === 'mantis') {
            this.mantisStrike(e, false);
            if (abilities.doubleStrike) e.followupT = 0.26;
          } else if (e.bossKind === 'scarab') e.dashT = abilities.chargeTime;
          else {
            for (const offset of abilities.frostOffsets) this.hazards.push({
              x: clamp((e.quakeX ?? p.x) + offset * this.fh * 1.5, 0, this.w),
              radius: this.fh * 0.48, timer: 0.18 + Math.abs(offset) * 0.16,
              life: 0.9, hit: false, frost: true, owner: e, ...(abilities.slow ? { slow: abilities.slow } : {}),
            });
          }
        }
        delete e.quakeX;
      }
    } else if (alive && e.cool <= 0) {
      const dx = p.x - e.x;
      e.face = dx >= 0 ? 1 : -1;
      const engage = e.bossKind === 'crystal' ? this.w : e.bossKind === 'scarab' ? this.fh * 5 : variantBossReach(e);
      if (Math.abs(dx) <= engage) {
        // 高关卡也保留完整识别窗口，不随难度压缩控制招前摇。
        e.windup = abilities.windup;
        e.vx = 0;
        if (e.bossKind === 'crystal') e.quakeX = p.x;
      } else e.vx = e.face * e.speed;
    } else e.vx *= Math.exp(-dt * 14);
    this.integrate(dt, e); e.pose = this.poseFor(e);
  }

  private mantisStrike(e: Fighter, second: boolean): void {
    const reach = variantBossReach(e), p = this.player;
    const a0 = second ? -0.8 : -2.4, a1 = second ? 2.4 : 0.8;
    this.slashes.push({ x: e.x + e.face * reach * 0.4, y: e.y - e.h * 0.45,
      r: reach * 0.6, a0: e.face > 0 ? a0 : Math.PI - a1, a1: e.face > 0 ? a1 : Math.PI - a0,
      life: 0.2, max: 0.2, big: true });
    this.shake = Math.max(this.shake, 0.7);
    const forward = (p.x - e.x) * e.face;
    if (p.invuln <= 0 && forward >= -this.fh * 0.12 && forward <= reach
      && p.y > e.y - e.h * 0.72) this.hurtPlayer(e.face, second && bossAbilities(e).stun ? 'stun' : undefined);
  }

  /** 执行 boss 招式：近战瞬时判定、冲撞设 dashT+冲量、横扫设 spinT+整圈刀光。 */
  private launchBossMove(e: Fighter, move: BossMove): void {
    const p = this.player;
    const alive = this.respawn <= 0;
    if (move === 'charge') {
      e.face = p.x >= e.x ? 1 : -1;
      e.dashT = BOSS_CHARGE_TIME;
      this.shake = Math.min(3.4, this.shake + 0.6);
      this.hitstop = Math.max(this.hitstop, 0.05);   // 起手顿一下让突进更爆
      if (alive) this.resolveBossCharge(e);
      return;
    }
    if (move === 'sweep') {
      e.spinT = BOSS_SWEEP_TIME;
      this.slashes.push({
        x: e.x, y: e.y - this.fh * 0.6, r: this.fh * BOSS_SWEEP_REACH_FH * 0.95,
        a0: -Math.PI, a1: Math.PI, life: 0.24, max: 0.24, big: true,
      });
      // 再叠一道更大半径、更短寿命的地面冲击环当"冲击波"——横扫看得见范围。
      this.slashes.push({
        x: e.x, y: e.y - this.fh * 0.2, r: this.fh * BOSS_SWEEP_REACH_FH * 1.25,
        a0: -Math.PI, a1: Math.PI, life: 0.14, max: 0.14, big: true,
      });
      this.hitstop = Math.max(this.hitstop, 0.04);
      this.shake = Math.min(3.6, this.shake + 1.0);
      if (alive && Math.abs(p.x - e.x) < this.fh * BOSS_SWEEP_REACH_FH && p.invuln <= 0) {
        this.hurtPlayer(p.x >= e.x ? 1 : -1);
      }
      return;
    }
    // 近战重击：贴身瞬时判定（沿用 grunt 的做法，boss 够得更远）。追加落点顿帧 + 一道刀尖下劈刀光，
    // 让 Phase 1 的重击也有"头目招式"的分量（之前只有 hurtPlayer，画面上啥都没有）。
    this.slashes.push({
      x: e.x + e.face * this.fh * 0.6, y: e.y - this.fh * 0.9, r: this.fh * 1.1,
      a0: e.face > 0 ? -2.2 : Math.PI + 2.2, a1: e.face > 0 ? 0.3 : Math.PI - 0.3,
      life: 0.16, max: 0.16, big: true,
    });
    this.shake = Math.min(3.6, this.shake + 0.9);
    this.hitstop = Math.max(this.hitstop, 0.06);
    if (alive && Math.abs(p.x - e.x) < this.fh * 1.4 && p.invuln <= 0) this.hurtPlayer(Math.sign(e.face));
  }

  private stepHazards(dt: number): void {
    // 头目倒下即解除残留地裂，结算屏不会把危险预警冻结成永久地刺。
    if (!this.enemies.some(e => e.tag === 'boss')) { this.hazards.length = 0; return; }
    for (const h of this.hazards) {
      if (h.owner && !this.enemies.includes(h.owner)) { h.life = 0; continue; }
      if (h.timer > 0) { h.timer -= dt; continue; }
      h.life -= dt;
      const p = this.player;
      if (!h.hit && this.respawn <= 0 && p.invuln <= 0
        && Math.abs(p.x - h.x) < h.radius + this.fh * 0.12 && p.y > this.ground - this.fh * 0.28) {
        h.hit = true; this.hurtPlayer(p.x >= h.x ? 1 : -1, h.slow ? 'slow' : undefined, h.slow);
      }
    }
    this.hazards = this.hazards.filter(h => h.life > 0);
  }

  /** 冲撞途中撞到玩家：一次冲撞只伤一下（玩家受击后 0.85s 无敌天然拦住重复）。 */
  private resolveBossCharge(e: Fighter): void {
    const p = this.player;
    if (p.invuln > 0) return;
    if (Math.abs(p.x - e.x) > this.fh * 1.05) return;
    if (p.y - p.h > e.y + this.fh * 0.15 || p.y < e.y - this.fh * 1.15) return;   // 跳起可躲
    this.hurtPlayer(p.x >= e.x ? 1 : -1);
  }

  private hurtPlayer(dir: number, control?: 'stun' | 'slow' | 'push', slow?: { duration: number; multiplier: number }): void {
    const p = this.player;
    p.hp -= 1;
    p.invuln = 0.85;
    if ((p.armorT ?? 0) <= 0) {
      p.hurt = 0.35;
      p.vx = dir * this.fh * (control === 'push' ? 3.4 : 2.2);
      p.vy = -Math.min(this.fh * 1.6, this.jumpV);
      p.onGround = false;
      p.atk = -1;
      if (control === 'slow' && slow) {
        p.slowFactor = (p.slowT ?? 0) > 0 ? Math.min(p.slowFactor ?? 1, slow.multiplier) : slow.multiplier;
        p.slowT = Math.max(p.slowT ?? 0, slow.duration);
      }
      if (control === 'stun' && (p.controlImmuneT ?? 0) <= 0) {
        p.stunT = 0.3;
        p.dashT = p.spinT = 0; p.atkQueued = false;
        this.swordCast = null; this.queuedArt = null; this.artBossHits.clear();
        this.buffered = { ...NO_INTENT };
      }
    }
    this.hitstop = 0.09;
    this.shake = Math.min(3, this.shake + 1.4);
    this.combo = 0;
    if (p.hp <= 0) {
      p.armorT = p.stunT = p.slowT = p.controlImmuneT = 0;
      this.swordCast = null; this.queuedArt = null; this.artBossHits.clear();
      // 玩家也是火柴人，也照样砍碎 —— 死法和杂兵一样才公平，而且好笑。
      this.dismember(p, p.y - p.h * 0.6, dir, 1.15);
      this.respawn = 1.1;
      this.deaths++;
      this.shake = 3.2;
    }
  }

  /* ── 砍碎 ──────────────────────────────────────────────────────── */

  /**
   * 把一个火柴人拆成断肢。
   *
   * 拆法：取死亡瞬间的姿态线段，按 `cutY` 分成上下两半，**跨过切线的那条线段被切成两段**。
   * 上半身获得更大的初速（被刀带飞），下半身基本是瘫下去。这条"上下不同速"是整个动画
   * 看起来像"被砍"而不是"炸开"的原因。
   */
  private dismember(f: Fighter, cutY: number, dir: number, power: number): void {
    const body: Body = { x: f.x, y: f.y, h: f.h, face: f.face, pose: f.pose, armed: false };
    const s = this.fx;
    const mine = f.kind === 'player';
    for (const seg of f.kind === 'player' ? segments(body) : fighterSegments(f)) {
      if (seg.part === 'head') {
        this.pushPiece(seg.x0, seg.y0, seg.r, true, seg.y0 < cutY, dir, power, mine, 0);
        continue;
      }
      const above0 = seg.y0 < cutY;
      const above1 = seg.y1 < cutY;
      if (above0 !== above1) {
        // 跨切线：在交点处断开，两段各自飞。断口就是刀口。
        const t = (cutY - seg.y0) / (seg.y1 - seg.y0);
        const mx = seg.x0 + (seg.x1 - seg.x0) * t;
        this.addSeg(seg.x0, seg.y0, mx, cutY, above0, dir, power, mine);
        this.addSeg(mx, cutY, seg.x1, seg.y1, above1, dir, power, mine);
      } else {
        this.addSeg(seg.x0, seg.y0, seg.x1, seg.y1, above0, dir, power, mine);
      }
    }
    this.spillBlood(f.x, cutY, dir, s, power);
  }

  private addSeg(x0: number, y0: number, x1: number, y1: number, above: boolean, dir: number, power: number, mine: boolean): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.4) return;
    this.pushPiece((x0 + x1) / 2, (y0 + y1) / 2, len / 2, false, above, dir, power, mine, Math.atan2(dy, dx));
  }

  private pushPiece(x: number, y: number, half: number, head: boolean, above: boolean, dir: number, power: number, mine: boolean, ang: number): void {
    const s = this.fx;
    const lift = above ? 1 : 0.35;
    this.pieces.push({
      x, y, half, head, ang, mine, rest: false,
      vx: dir * this.rng.range(0.8, 3.4) * s * power * lift + this.rng.spread(s * 0.5),
      vy: -this.rng.range(0.9, 3.0) * s * power * lift,
      av: this.rng.spread(15) * (above ? 1 : 0.5),
    });
    // 尸堆有上限：地上的碎块虽然静止（diff 免费），但太多就糊成一片看不出是尸体了。
    if (this.pieces.length > 150) this.pieces.splice(0, this.pieces.length - 150);
  }

  private spillBlood(x: number, y: number, dir: number, s: number, power: number): void {
    const n = Math.round(this.rng.range(10, 18) * power);
    for (let i = 0; i < n; i++) {
      this.blood.push({
        x: x + this.rng.spread(s * 0.2), y: y + this.rng.spread(s * 0.15),
        vx: dir * this.rng.range(0.3, 4.2) * s + this.rng.spread(s * 0.8),
        vy: -this.rng.range(0.2, 2.6) * s,
        life: this.rng.range(0.5, 1.4),
      });
    }
  }

  /* ── 物理 ──────────────────────────────────────────────────────── */

  /**
   * 断肢 / 血的初速标定。身高在条形模式里太小（3 像素），按它算出来的碎块只能挪一两个
   * 像素，看起来是"原地散开"而不是"被砍飞"。所以取身高和场地宽度的较大者 ——
   * 全屏尺寸下身高更大，这条不生效。
   */
  private get fx(): number {
    return Math.max(this.fh, this.w * 0.12);
  }

  private integrate(dt: number, f: Fighter): void {
    const g = this.fh * 26;
    f.vy += g * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.land > 0) f.land -= dt;
    if (f.y >= this.ground) {
      // 落地压扁只给**真的砸下来**的那一下。站在地上每帧都会走到这里，
      // 不看"上一帧还在空中 + 下落够快"的话，走路会一直抖。
      if (!f.onGround && f.vy > this.fh * 5) f.land = LAND_TIME;
      f.y = this.ground; f.vy = 0; f.onGround = true;
    } else f.onGround = false;
    // 玩家撞墙，杂兵不撞（它们从墙外走进来）。
    if (f.kind === 'player') f.x = clamp(f.x, 1, this.w - 2);
    if (f.onGround && Math.abs(f.vx) > this.fh * 0.25) f.walk = (f.walk + dt * (0.9 + Math.abs(f.vx) / (f.speed * 0.6))) % 1;
  }

  private poseFor(f: Fighter): Pose {
    if (f.kind === 'player' && this.swordCast !== null && f.atk < 0 && f.dashT <= 0 && f.spinT <= 0
      && f.hurt <= 0 && this.swordCast.age < artRecovery(this.swordCast.full)) {
      const cast = this.swordCast, form = currentSwordForm(cast), u = cast.age / artRecovery(cast.full);
      const kind = cast.art === 'liumai' || form.shape === 'thrust' ? 'lunge' : form.shape === 'rain' ? 'air' : 'sweep';
      return poseSlash(u < 0.12 ? 0.18 : u < 0.65 ? 0.38 : 0.85, kind);
    }
    // Boss 走专属姿态：冲撞/横扫/前摇各有夸张剪影，让玩家能从起手预判招式。
    // 放在玩家/杂兵的通用分支之前——玩家/grunt 不带 boss tag，永不命中，裸 World 逐字节不变。
    if (f.tag === 'boss') {
      if (f.dashT > 0) return poseBossCharge(clamp(1 - f.dashT / (f.bossKind === 'scarab' ? bossAbilities(f).chargeTime : BOSS_CHARGE_TIME), 0, 1));
      if (f.spinT > 0) return poseBossSweep(clamp(1 - f.spinT / BOSS_SWEEP_TIME, 0, 1));
      if (f.windup >= 0) {
        const move = bossMoveFor(bossPhase(f.hp, f.maxHp), f.atkSeq ?? 0);
        const windup = f.bossKind && f.bossKind !== 'spider' ? bossAbilities(f).windup : Math.max(0.65, BOSS_WINDUP - (f.bossRank ?? 0) * 0.01);
        const k = clamp(1 - f.windup / windup, 0, 1);
        // Phase 1 的重击走"举刀过顶下劈"观感（poseBossSlam 的前摇即其抬刀段）。
        return move === 'melee' ? poseBossSlam(k * 0.5) : poseBossWindup(move, k);
      }
    }
    // 冲刺是前倾的突进，旋斩是快速扫刀 —— 都借用挥刀姿态，省一套骨架美术。
    if (f.dashT > 0) return poseSlash(0.45);
    if (f.spinT > 0) return poseSlash(clamp(1 - f.spinT / SPIN_TIME, 0, 1));
    if (f.atk >= 0) return poseSlash(f.atk < 0.1 ? (f.h < 8 ? 0.05 : 0.18) : f.atk < 0.19 ? 0.38 : 0.85, f.atkKind ?? 'normal');
    if (f.windup >= 0) return poseWindup(clamp(1 - f.windup / (f.tag === 'boss' ? BOSS_WINDUP : GRUNT_WINDUP), 0, 1));
    if (f.hurt > 0) return poseHurt(clamp(f.hurt / 0.35, 0, 1));
    if (!f.onGround) return poseAir(f.vy < 0);
    // 压扁让位给攻击和受击（上面两条已经 return 了）—— 落地立刻出刀时，
    // 该看见的是刀而不是屈膝。
    if (f.land > 0) return poseLand(clamp(f.land / LAND_TIME, 0, 1));
    if (Math.abs(f.vx) > this.fh * 0.25) return poseWalk(f.walk);
    return poseIdle(f.anim);
  }

  private stepPieces(dt: number): void {
    const g = this.fh * 26;
    for (const p of this.pieces) {
      if (p.rest) continue;
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ang += p.av * dt;
      const floor = this.ground - 0.3;
      if (p.y >= floor) {
        p.y = floor;
        // 弹一下再躺平。直接停会像贴在地上，弹一下才有重量。
        if (Math.abs(p.vy) > this.fh * 0.9) { p.vy = -Math.abs(p.vy) * 0.34; p.vx *= 0.55; p.av *= 0.45; }
        else {
          p.vy = 0;
          p.vx *= Math.exp(-dt * 9);
          p.av *= Math.exp(-dt * 9);
          if (Math.abs(p.vx) < this.fh * 0.12 && Math.abs(p.av) < 0.6) {
            p.rest = true;
            // 躺平：转到最近的水平方向。躺着的断肢是横的，不是斜插在地上的。
            p.ang = Math.round(p.ang / Math.PI) * Math.PI;
            this.stain(p.x, p.y + 0.6, p.head ? 3 : 2);
          }
        }
      }
    }
  }

  private stepBlood(dt: number): void {
    const g = this.fh * 24;
    for (let i = this.blood.length - 1; i >= 0; i--) {
      const b = this.blood[i]!;
      b.vy += g * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      const hitFloor = b.y >= this.ground - 0.2;
      if (hitFloor || b.life <= 0) {
        if (hitFloor) this.stain(b.x, this.ground - 0.2 + this.rng.range(0, 1.2), 1);
        this.blood.splice(i, 1);
      }
    }
  }

  /** 在地上留一滴血。整数打包 + 去重，静止的像素在 diff 之后是零成本的。 */
  private stain(x: number, y: number, size: number): void {
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let i = 0; i < size; i++) {
      const sx = cx + (i === 0 ? 0 : Math.round(this.rng.spread(1.6)));
      const sy = cy + (i === 0 ? 0 : Math.round(this.rng.spread(0.8)));
      if (sx < 0 || sx >= this.w || sy < 0 || sy >= this.h) continue;
      const key = sy * 4096 + sx;
      if (!this.stains.includes(key)) this.stains.push(key);
    }
    if (this.stains.length > 1400) this.stains.splice(0, this.stains.length - 1400);
  }

  private stepSlashes(dt: number): void {
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      const s = this.slashes[i]!;
      s.life -= dt;
      if (s.life <= 0) this.slashes.splice(i, 1);
    }
  }

  /**
   * 清屏技：以玩家为中心的冲击波向两边推，波锋扫到谁就当场砍碎。
   *
   * 为什么是"扫过去"而不是"全场同时死"：同时死只有一帧的信息量，扫过去有 0.5 秒的
   * 连续反馈，而且断肢会按波锋方向分左右两拨飞 —— 这是任务跑完时那一下的仪式感。
   */
  private stepWave(dt: number): void {
    if (this.waveR === null) { this.phase = 'paused'; return; }
    this.waveR += (this.w / 0.55) * dt;
    const r = this.waveR;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      if (Math.abs(e.x - this.player.x) > r) continue;
      this.dismember(e, e.y - e.h * this.rng.range(0.35, 0.85), e.x >= this.player.x ? 1 : -1, 1.5);
      this.enemies.splice(i, 1);
      this.kills++;
      this.taskKills++;
      this.shake = Math.min(3.4, this.shake + 0.5);
    }
    if (r > this.w) {
      this.waveR = null;
      this.phase = 'paused';
      this.enemies.length = 0;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 给渲染层用：把一个 Fighter 变成骨架需要的最小信息。 */
export function bodyOf(f: Fighter): Body {
  return { x: f.x, y: f.y, h: f.h, face: f.face, pose: f.pose, armed: f.armed };
}

export type { Seg };
