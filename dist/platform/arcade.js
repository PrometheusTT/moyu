import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { SignalTail } from "../bridge/signal.js";
import { Rng } from "../core/rng.js";
import { World } from "../core/world.js";
import { CHAPTER_COUNT, ChapterDirector, parseChapterCheckpoint } from "../core/chapter.js";
import { segments } from "../core/stick.js";
import { paintWorld } from "../render/scene.js";
import { stripPainter } from "../render/painter.js";
import { LogicalCanvas } from "./canvas.js";
import { drawMicroFighter } from "./micro-sprites.js";
import { NativePixelCanvas } from "./pixel-canvas.js";
import { paintPixelWorld, snapshotFighters } from "../render/pixel-scene.js";
const EMPTY_INPUT = { left: false, right: false, up: false, down: false, jump: false, primary: false, secondary: false, special: false };
const BG = 0x090a0e, GRID = 0x151722, INK = 0xecf0f8, ACCENT = 0xe43834, AMBER = 0xa67c00;
// 展开 braille 的战斗残留配色：暗红血迹、瘫地断肢的灰、杂兵碎块的棕。
const STAIN = 0x68121a, DEAD = 0x5c5f6c, FOE = 0xb37b58;
// 敌人变种本色：快刀手偏亮、重甲偏暗、boss 深红；其余走 FOE。
const FOE_RUNNER = 0xd8b48a, FOE_BRUTE = 0x7a5236, FOE_BOSS = 0xc0473a;
/** 字符档下按变种取本色（图形/braille 档在各自渲染器里用调色板混色）。导出供渲染回归测试锁定区分度。 */
export function foeColor(tag) {
    return tag === 'boss' ? FOE_BOSS : tag === 'brute' ? FOE_BRUTE : tag === 'runner' ? FOE_RUNNER : FOE;
}
const HOST_POLL_MS = 100;
const FIRST_DIRECTION_MS = 340;
const REPEAT_DIRECTION_MS = 150;
class InputLatch {
    leftUntil = 0;
    rightUntil = 0;
    downUntil = 0;
    lastHorizontal = 1;
    up = false;
    jump = false;
    primary = false;
    secondary = false;
    special = false;
    hold(until, now) {
        return now + (now < until ? REPEAT_DIRECTION_MS : FIRST_DIRECTION_MS);
    }
    feed(bytes, now) {
        let played = false;
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b === 0x71)
                return 'leave';
            if (b === 0x09)
                return 'next';
            if (b === 0x3f)
                return 'help';
            if (b === 0x65 || b === 0x45)
                return 'view';
            if (b === 0x1b && (bytes[i + 1] === 0x5b || bytes[i + 1] === 0x4f)) {
                let j = i + 2;
                while (j < bytes.length && !(bytes[j] >= 0x40 && bytes[j] <= 0x7e))
                    j++;
                const f = bytes[j];
                if (f !== undefined && f >= 0x41 && f <= 0x44)
                    played = true;
                if (f === 0x41)
                    this.up = true;
                else if (f === 0x42)
                    this.downUntil = this.hold(this.downUntil, now);
                else if (f === 0x43) {
                    this.rightUntil = this.hold(this.rightUntil, now);
                    this.lastHorizontal = 1;
                }
                else if (f === 0x44) {
                    this.leftUntil = this.hold(this.leftUntil, now);
                    this.lastHorizontal = -1;
                }
                i = j;
                continue;
            }
            if (b === 0x61 || b === 0x68) {
                this.leftUntil = this.hold(this.leftUntil, now);
                this.lastHorizontal = -1;
            }
            else if (b === 0x64 || b === 0x6c) {
                this.rightUntil = this.hold(this.rightUntil, now);
                this.lastHorizontal = 1;
            }
            else if (b === 0x73)
                this.downUntil = this.hold(this.downUntil, now);
            else if (b === 0x77 || b === 0x6b)
                this.up = true;
            else if (b === 0x20)
                this.jump = true;
            else if (b === 0x6a || b === 0x66 || b === 0x3b)
                this.primary = true;
            else if (b === 0x75)
                this.secondary = true;
            else if (b === 0x69)
                this.special = true;
            if ('ahdlswkjf;ui '.includes(String.fromCharCode(b)))
                played = true;
        }
        return played ? 'play' : null;
    }
    take(now) {
        let left = now < this.leftUntil;
        let right = now < this.rightUntil;
        if (left && right) {
            left = this.lastHorizontal === -1;
            right = this.lastHorizontal === 1;
        }
        const out = { left, right, up: this.up,
            down: now < this.downUntil, jump: this.jump, primary: this.primary, secondary: this.secondary, special: this.special };
        this.up = this.jump = this.primary = this.secondary = this.special = false;
        return out;
    }
    clear() {
        this.leftUntil = this.rightUntil = this.downUntil = 0;
        this.up = this.jump = this.primary = this.secondary = this.special = false;
    }
}
class StickGame {
    world;
    director;
    previous = new Map();
    scratch = new Map();
    constructor(seed) {
        this.world = new World(seed, { automaticSpawns: false });
        this.world.resize(180, 44);
        this.world.enemyLimit = 3;
        this.director = new ChapterDirector(seed);
        this.director.start(this.world);
    }
    update(dt, input) {
        const previous = this.previous;
        this.previous = snapshotFighters(this.world, this.scratch);
        this.scratch = previous;
        const intent = { move: input.left === input.right ? 0 : input.left ? -1 : 1,
            jump: input.jump || input.up, slash: input.primary,
            dash: input.secondary === true, spin: input.special === true };
        if (this.director.result !== null && input.primary
            && this.director.nextChapter(this.world)) {
            this.reduceMotion();
            return;
        }
        this.director.step(this.world, dt, intent);
        this.reduceMotion();
    }
    reduceMotion() {
        if (process.env.MOYU_REDUCE_MOTION === '1') {
            this.world.shake = 0;
            this.world.shakeX = 0;
            this.world.shakeY = 0;
            this.world.flash = 0;
        }
    }
    render(canvas) {
        if (!(canvas instanceof LogicalCanvas))
            return;
        paintWorld(stripPainter(canvas), this.world);
    }
    renderPixels(canvas, context) {
        paintPixelWorld(canvas, this.world, context, this.previous, this.director.result !== null);
    }
    renderMicro(c) {
        c.clear(BG);
        // 64/180 maps the 29.9-world-unit attack reach to the sprite's 11-pixel blade tip.
        const px = (x) => 8 + (x / this.world.w) * (c.width - 16);
        const enemies = this.world.enemies;
        for (const f of enemies) {
            const x = px(f.x);
            drawMicroFighter(c, f, x, foeColor(f.tag), AMBER);
        }
        const playerX = px(this.world.player.x);
        if (this.world.respawn <= 0)
            drawMicroFighter(c, this.world.player, playerX, INK, AMBER, Math.min(1, (this.world.ground - this.world.player.y) / 10));
        else {
            c.line(playerX - 3, 7, playerX + 3, 7, ACCENT);
        }
        // 命中停顿本来就是手感最重的一帧；在微型画面里给刀尖三粒红色火花，
        // 比把血和断肢全部缩进来更清楚，也不会让待机画面变成噪点。
        if (this.world.hitstop > 0) {
            const x = Math.round(px(this.world.player.x) + this.world.player.face * 11);
            c.pixel(x, 1, ACCENT);
            c.pixel(x + this.world.player.face, 2, ACCENT);
            c.pixel(x, 3, ACCENT);
        }
    }
    onHostEvent(event) {
        if (event === 'task-start' && this.world.phase !== 'fight')
            this.world.taskStart();
        else if (event === 'task-done')
            this.world.taskDone();
        this.previous.clear();
        this.scratch.clear();
    }
    renderExpanded(c) {
        const w = this.world;
        c.clear(BG);
        const scale = c.width / w.w;
        const ground = c.height - 3;
        const verticalScale = Math.min(scale, ground / w.ground);
        // 屏幕震动整场一起抖 —— 命中的"咚"一半靠它。竖直分量本就被 world 夹得很小。
        const dx = w.shakeX;
        const dy = w.shakeY;
        const px = (x) => (x + dx) * scale;
        const py = (y) => ground - (w.ground - (y + dy)) * verticalScale;
        // 地上的血迹垫最底。
        for (const key of w.stains)
            c.pixel(Math.round(px(key % 4096)), Math.round(py(Math.floor(key / 4096))), STAIN);
        // 断肢：先躺平的（垫底），再飞着的。这是"砍碎"的回报，之前展开档整块丢了。
        const drawPiece = (p) => {
            const color = p.rest ? DEAD : p.mine ? INK : FOE;
            if (p.head) {
                c.rect(Math.round(px(p.x) - 1), Math.round(py(p.y) - 1), 2, 2, color);
                return;
            }
            const vx = Math.cos(p.ang) * p.half;
            const vy = Math.sin(p.ang) * p.half;
            c.line(px(p.x - vx), py(p.y - vy), px(p.x + vx), py(p.y + vy), color);
        };
        for (const p of w.pieces)
            if (p.rest)
                drawPiece(p);
        for (const p of w.pieces)
            if (!p.rest)
                drawPiece(p);
        for (const f of [...w.enemies, ...(w.respawn > 0 ? [] : [w.player])]) {
            const color = f === w.player ? (f.hurt > 0 ? ACCENT : INK) : f.windup >= 0 ? ACCENT : foeColor(f.tag);
            const flash = w.hitstop > 0 && f.armed; // 命中那几帧刀刃闪白
            const body = { ...f, x: px(f.x), y: py(f.y), h: f.h * verticalScale };
            for (const s of segments(body)) {
                if (s.part === 'head')
                    c.rect(Math.round(s.x0 - 1), Math.round(s.y0 - 1), 2, 2, color);
                else
                    c.line(s.x0, s.y0, s.x1, s.y1, s.part === 'blade' ? (flash ? INK : AMBER) : color);
            }
        }
        if (w.respawn > 0)
            c.line(px(w.player.x) - 3, py(w.ground), px(w.player.x) + 3, py(w.ground), ACCENT);
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
                ax = bx;
                ay = by;
            }
        }
        // 血花盖在最上，和 paintWorld 一样的层序（血是盖在刀光和身体之上的）。
        for (const b of w.blood)
            c.pixel(Math.round(px(b.x)), Math.round(py(b.y)), ACCENT);
    }
    serialize() {
        return { version: 1, kills: this.world.kills, bestCombo: this.world.bestCombo,
            checkpoint: this.director.checkpoint() };
    }
    restore(state) {
        if (typeof state !== 'object' || state === null || Array.isArray(state))
            return;
        const s = state;
        const kills = savedCount(s.kills);
        const bestCombo = savedCount(s.bestCombo);
        if (s.version === 1) {
            if (kills === null || bestCombo === null)
                return;
            if (s.checkpoint === null) {
                if (bestCombo > kills)
                    return;
                this.world.rng.reset(this.director.runSeed);
                this.world.kills = kills;
                this.world.bestCombo = bestCombo;
                this.director.start(this.world);
                return;
            }
            const checkpoint = parseChapterCheckpoint(s.checkpoint);
            if (checkpoint === null || kills < checkpoint.kills || bestCombo < checkpoint.bestCombo
                || bestCombo > kills)
                return;
            if (!this.director.restore(this.world, checkpoint))
                return;
            this.world.kills = kills;
            this.world.bestCombo = bestCombo;
            return;
        }
        if (s.version !== undefined)
            return;
        // 旧版只保存累计战绩；继续接受它，坏字段则整份忽略。
        if (kills === null || bestCombo === null || bestCombo > kills)
            return;
        this.world.rng.reset(this.director.runSeed);
        this.world.kills = kills;
        this.world.bestCombo = bestCombo;
        this.director.start(this.world);
    }
    hud() {
        const result = this.director.result;
        if (result !== null) {
            const checkpoint = this.director.checkpoint();
            if (result.chapter >= CHAPTER_COUNT && this.world.phase === 'fight' && checkpoint !== null) {
                return `五分钟完成 · ${checkpoint.score}分 · ${checkpoint.kills}击破 · 连击${checkpoint.bestCombo}`;
            }
            // 章节完成屏是天然的剧情节拍（按 J 进下一章前）：亮出刚打完这章的标题。
            // 保留"第N章完成"连续子串，HUD 正则（arcade.test）照旧匹配；标题追加在后面。
            const title = this.director.chapterTitle();
            return this.world.phase === 'fight'
                ? `第${result.chapter}章完成 · 『${title}』 · ${result.score}分 · J 下一章`
                : `第${result.chapter}章完成 · 『${title}』 · ${result.score}分 · 等待下个任务`;
        }
        return `火柴快斩 ${this.director.chapter}/${CHAPTER_COUNT} · ${this.world.kills}击破 · ${this.world.respawn > 0 ? '重生中' : `血${this.world.player.hp}/4`}`;
    }
}
function savedCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
class SnakeGame {
    // 微型屏上直接玩的 24×8 棋盘。旧版内部是 24×16 再压到 7 行，转弯时相邻
    // 两节经常量化到同一格，看起来像蛇突然断掉；8 行让操作与画面一一对应。
    body = [[8, 4], [7, 4], [6, 4], [5, 4], [4, 4]];
    food = [17, 4];
    dir = [1, 0];
    pendingDir = null;
    acc = 0;
    score = 0;
    best = 0;
    seed = 7;
    rand() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 0x100000000; }
    update(dt, input) {
        if (this.pendingDir === null) {
            if ((input.up || input.jump) && this.dir[0] !== 0)
                this.pendingDir = [0, -1];
            else if (input.down && this.dir[0] !== 0)
                this.pendingDir = [0, 1];
            else if (input.left && this.dir[1] !== 0)
                this.pendingDir = [-1, 0];
            else if (input.right && this.dir[1] !== 0)
                this.pendingDir = [1, 0];
        }
        this.acc += dt;
        if (this.acc < Math.max(0.06, 0.14 - this.score * 0.002))
            return;
        this.acc = 0;
        if (this.pendingDir !== null) {
            this.dir = this.pendingDir;
            this.pendingDir = null;
        }
        const head = this.body[0];
        const next = [(head[0] + this.dir[0] + 24) % 24, (head[1] + this.dir[1] + 8) % 8];
        if (this.body.some(([x, y]) => x === next[0] && y === next[1])) {
            this.reset();
            return;
        }
        this.body.unshift(next);
        if (next[0] === this.food[0] && next[1] === this.food[1]) {
            this.score++;
            this.best = Math.max(this.best, this.score);
            this.placeFood();
        }
        else
            this.body.pop();
    }
    reset() {
        this.body = [[8, 4], [7, 4], [6, 4], [5, 4], [4, 4]];
        this.dir = [1, 0];
        this.pendingDir = null;
        this.score = 0;
    }
    placeFood() {
        for (let n = 0; n < 100; n++) {
            const p = [Math.floor(this.rand() * 24), Math.floor(this.rand() * 8)];
            if (!this.body.some(([x, y]) => x === p[0] && y === p[1])) {
                this.food = p;
                return;
            }
        }
    }
    render(c) {
        c.clear(BG);
        c.rect(7, 3, 50, 34, GRID);
        c.rect(8 + this.food[0] * 2, 4 + this.food[1] * 4, 2, 4, ACCENT);
        for (let i = this.body.length - 1; i >= 0; i--) {
            const [x, y] = this.body[i];
            c.rect(8 + x * 2, 4 + y * 4, 2, 4, i === 0 ? AMBER : INK);
        }
    }
    renderMicro(c) {
        c.clear(BG);
        c.rect(15 + this.food[0] * 2, this.food[1], 2, 2, ACCENT);
        for (let i = this.body.length - 1; i >= 0; i--) {
            const [x, y] = this.body[i];
            c.rect(15 + x * 2, y, 2, 2, i === 0 ? AMBER : INK);
        }
    }
    renderExpanded(c) {
        c.clear(BG);
        c.line(14, 3, 65, 3, 0x687080);
        c.line(14, 20, 65, 20, 0x687080);
        c.line(14, 3, 14, 20, 0x687080);
        c.line(65, 3, 65, 20, 0x687080);
        c.rect(16 + this.food[0] * 2, 4 + this.food[1] * 2, 2, 2, ACCENT);
        for (let n = this.body.length - 1; n >= 0; n--) {
            const [x, y] = this.body[n];
            c.rect(16 + x * 2, 4 + y * 2, 2, 2, n === 0 ? AMBER : INK);
        }
    }
    serialize() { return { best: this.best }; }
    restore(v) { if (typeof v?.best === 'number')
        this.best = v.best; }
    hud() { return `贪吃蛇 · ${this.score} · 最高 ${this.best} · Tab 换游戏`; }
}
const SHAPES = [
    [[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[1, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[2, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
];
class BlocksGame {
    board = new Uint8Array(10 * 18);
    shape = 0;
    rot = 0;
    x = 3;
    y = 0;
    acc = 0;
    score = 0;
    best = 0;
    seq = 1;
    moveDirection = 0;
    moveWait = 0;
    cells(shape = this.shape, rot = this.rot, px = this.x, py = this.y) {
        return SHAPES[shape].map(([ax, ay]) => {
            let x = ax, y = ay;
            if (shape !== 1)
                for (let r = 0; r < rot; r++)
                    [x, y] = [(shape === 0 ? 3 : 2) - y, x];
            return [px + x, py + y];
        });
    }
    blocked(x, y, rot = this.rot) {
        return this.cells(this.shape, rot, x, y).some(([cx, cy]) => cx < 0 || cx >= 10 || cy >= 18 || (cy >= 0 && this.board[cy * 10 + cx] !== 0));
    }
    update(dt, i) {
        const direction = i.left === i.right ? 0 : i.left ? -1 : 1;
        this.moveWait -= dt;
        if (direction !== 0 && (direction !== this.moveDirection || this.moveWait <= 0)) {
            if (!this.blocked(this.x + direction, this.y))
                this.x += direction;
            this.moveWait = direction !== this.moveDirection ? 0.18 : 0.09;
        }
        this.moveDirection = direction;
        if ((i.up || i.primary) && !this.blocked(this.x, this.y, (this.rot + 1) % 4))
            this.rot = (this.rot + 1) % 4;
        this.acc += dt * (i.down ? 8 : 1);
        if (i.jump)
            while (!this.blocked(this.x, this.y + 1))
                this.y++;
        if (this.acc < Math.max(0.12, 0.65 - this.score * 0.008) && !i.jump)
            return;
        this.acc = 0;
        if (!this.blocked(this.x, this.y + 1)) {
            this.y++;
            return;
        }
        for (const [x, y] of this.cells())
            if (y >= 0)
                this.board[y * 10 + x] = this.shape + 1;
        this.clearLines();
        this.spawn();
    }
    clearLines() {
        for (let y = 17; y >= 0; y--)
            if (this.board.subarray(y * 10, y * 10 + 10).every((v) => v !== 0)) {
                this.board.copyWithin(10, 0, y * 10);
                this.board.fill(0, 0, 10);
                this.score += 10;
                this.best = Math.max(this.best, this.score);
                y++;
            }
    }
    spawn() {
        this.shape = this.seq++ % SHAPES.length;
        this.rot = 0;
        this.x = 3;
        this.y = 0;
        if (this.blocked(this.x, this.y)) {
            this.board.fill(0);
            this.score = 0;
        }
    }
    render(c) {
        c.clear(BG);
        c.rect(20, 1, 22, 38, GRID);
        const colors = [INK, 0x59c3c3, AMBER, ACCENT, INK, AMBER, 0x59c3c3];
        for (let y = 0; y < 18; y++)
            for (let x = 0; x < 10; x++) {
                const v = this.board[y * 10 + x] ?? 0;
                if (v !== 0)
                    c.rect(21 + x * 2, 2 + y * 2, 2, 2, colors[(v - 1) % colors.length]);
            }
        for (const [x, y] of this.cells())
            if (y >= 0)
                c.rect(21 + x * 2, 2 + y * 2, 2, 2, colors[this.shape]);
    }
    renderMicro(c) {
        c.clear(BG);
        const ox = Math.floor((c.width - 22) / 2);
        c.line(ox, 0, ox, 7, GRID);
        c.line(ox + 21, 0, ox + 21, 7, GRID);
        const colors = [INK, 0x59c3c3, AMBER, ACCENT, INK, AMBER, 0x59c3c3];
        // 跟随活动方块的 8 行窗口。完整 18 行直接压缩会让方块只有半个点高，
        // 而局部窗口让移动、旋转、接触都保持一行一个台阶。
        const top = Math.max(0, Math.min(10, this.y - 5));
        for (let y = top; y < top + 8; y++)
            for (let x = 0; x < 10; x++) {
                const v = this.board[y * 10 + x] ?? 0;
                if (v !== 0)
                    c.rect(ox + 1 + x * 2, y - top, 2, 1, colors[(v - 1) % colors.length]);
            }
        for (const [x, y] of this.cells())
            if (y >= 0) {
                if (y >= top && y < top + 8)
                    c.rect(ox + 1 + x * 2, y - top, 2, 1, colors[this.shape]);
            }
        // 相机跟随时活动方块会保持在画面中段；右框上的金色刻度显示它在完整 18 行里的深度。
        c.pixel(ox + 21, Math.min(7, Math.round(this.y * 7 / 17)), AMBER);
    }
    serialize() { return { best: this.best }; }
    restore(v) { if (typeof v?.best === 'number')
        this.best = v.best; }
    hud() { return `落块 · ${this.score} · 最高 ${this.best} · Tab 换游戏`; }
    renderExpanded(c) {
        c.clear(BG);
        const ox = 28, oy = 2;
        c.line(ox, oy - 1, ox, oy + 18, 0x687080);
        c.line(ox + 22, oy - 1, ox + 22, oy + 18, 0x687080);
        c.line(ox, oy + 18, ox + 22, oy + 18, 0x687080);
        let landing = this.y;
        while (!this.blocked(this.x, landing + 1))
            landing++;
        for (const [x, y] of this.cells(this.shape, this.rot, this.x, landing))
            if (y >= 0)
                c.rect(ox + 2 + x * 2, oy + y, 2, 1, 0x687080);
        for (let y = 0; y < 18; y++)
            for (let x = 0; x < 10; x++)
                if (this.board[y * 10 + x])
                    c.rect(ox + 2 + x * 2, oy + y, 2, 1, INK);
        for (const [x, y] of this.cells())
            if (y >= 0)
                c.rect(ox + 2 + x * 2, oy + y, 2, 1, AMBER);
    }
}
function manifest(id, name, description, viewport) {
    return { id, name, description, viewport, microViewport: { width: 80, height: 8 }, version: '1.0.0', apiVersion: 1, author: 'Moyu', entry: 'builtin',
        display: { micro: id === 'stick-slash', minRows: id === 'stick-slash' ? 4 : 6, glyphs: id === 'stick-slash' ? 'dots' : 'blocks' },
        palette: ['#090a0e', '#ecf0f8', '#e43834', '#a67c00'],
        controls: id === 'stick-slash'
            ? [{ action: 'move', label: '移动', keys: ['A/D', '方向键'] }, { action: 'primary', label: '砍', keys: ['J'] }, { action: 'jump', label: '跳', keys: ['空格'] }, { action: 'secondary', label: '冲刺斩', keys: ['U'] }, { action: 'special', label: '旋斩', keys: ['I'] }]
            : id === 'snake' ? [{ action: 'move', label: '方向', keys: ['WASD', '方向键'] }]
                : [{ action: 'move', label: '移动', keys: ['A/D'] }, { action: 'primary', label: '旋转', keys: ['J'] }, { action: 'down', label: '下落', keys: ['S'] }, { action: 'jump', label: '直落', keys: ['空格'] }] };
}
export const BUILTIN_GAMES = [
    { manifest: manifest('stick-slash', '火柴快斩', '连续动作与打击反馈', { width: 180, height: 44 }), create: context => new StickGame(context.seed) },
    { manifest: manifest('snake', '贪吃蛇', '格子移动与成长', { width: 64, height: 40 }), create: () => new SnakeGame() },
    { manifest: manifest('blocks', '落块', '旋转、下落与消行', { width: 64, height: 40 }), create: () => new BlocksGame() },
];
const OPTIONAL_GAME_HOOKS = [
    'renderMicro', 'renderExpanded', 'renderPixels', 'onHostEvent', 'serialize', 'restore', 'hud',
];
function gameInstance(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        throw new Error('create 必须返回游戏实例');
    }
    if (value instanceof Promise) {
        void value.catch(() => { });
        throw new Error('create 不能返回 Promise 或 thenable');
    }
    const candidate = value;
    const then = candidate.then;
    if (typeof then === 'function')
        throw new Error('create 不能返回 Promise 或 thenable');
    const required = (name) => {
        const method = candidate[name];
        if (typeof method !== 'function')
            throw new Error(`游戏实例缺少 ${name}()`);
        return method.bind(value);
    };
    const normalized = {
        update: required('update'),
        render: required('render'),
    };
    const hooks = normalized;
    for (const name of OPTIONAL_GAME_HOOKS) {
        const method = candidate[name];
        if (method === undefined)
            continue;
        if (typeof method !== 'function')
            throw new Error(`游戏实例的 ${name} 必须是函数`);
        hooks[name] = method.bind(value);
    }
    return normalized;
}
function failureMessage(value) {
    try {
        const detail = value instanceof Error ? value.message || value.name : value;
        return String(detail) || '未知错误';
    }
    catch {
        return '未知错误';
    }
}
export class Arcade {
    keys = { clear: () => { this.input.clear(); } };
    input = new InputLatch();
    tail;
    slots = [];
    failures = new Map();
    active = 0;
    lastMs = 0;
    acc = 0;
    lastHostPoll = Number.NEGATIVE_INFINITY;
    stepped = false;
    paused = false;
    instructions = true;
    viewToggle = false;
    displayRows = 24;
    displayTier = 'braille';
    statusValue = 'idle';
    pendingAction = null;
    constructor(eventsFile, modules = BUILTIN_GAMES, startId, contextSeed = Date.now() & 0x7fffffff) {
        for (const module of modules)
            try {
                const source = new Rng(contextSeed);
                const context = Object.freeze({ seed: contextSeed >>> 0, random: () => source.float() });
                const instance = gameInstance(module.create(context));
                const micro = module.manifest.microViewport ?? { width: 80, height: 8 };
                this.slots.push({
                    module,
                    instance,
                    canvas: new LogicalCanvas(module.manifest.viewport.width, module.manifest.viewport.height),
                    microCanvas: new LogicalCanvas(micro.width, micro.height),
                    expandedCanvas: new LogicalCanvas(80, 24),
                });
            }
            catch (error) {
                this.failures.set(module.manifest.id, failureMessage(error));
            }
        const selected = startId === undefined ? -1 : this.slots.findIndex((slot) => slot.module.manifest.id === startId);
        if (selected >= 0)
            this.active = selected;
        this.tail = new SignalTail(eventsFile);
        this.loadAll();
    }
    failureFor(id) { return this.failures.get(id); }
    get available() { return this.slots.length; }
    resize(_w, _h) { }
    feed(bytes, now = Date.now()) {
        const command = this.input.feed(bytes, now);
        if (command === 'leave')
            return true;
        if (command === 'next' && this.slots.length > 0) {
            try {
                this.slots[this.active].instance.onHostEvent?.('pause');
            }
            catch { /* isolate cartridges */ }
            this.save(this.active);
            this.active = (this.active + 1) % this.slots.length;
            this.resetClock();
            this.instructions = true;
        }
        if (command === 'help') {
            this.instructions = !this.instructions;
            this.resetClock();
        }
        if (command === 'view') {
            this.viewToggle = true;
            this.input.clear();
        }
        if (command === 'play' && this.playable())
            this.instructions = false;
        return false;
    }
    enter() {
        this.statusValue = 'idle';
        this.pendingAction = null;
        // 进游戏即活：世界立刻推进并渲染，不再拦一张"按键才开始"的空白说明页。
        // 控制提示留在侧栏（? 帮助 / Esc 返回），? 仍随时叫出完整说明。太小放不下时
        // playable() 为假，showingInstructions 自然回到 true，让出/返回逻辑照旧接管。
        // Tab 换游戏仍先亮一次新游戏的操作（next 里置 instructions=true），因为那是没见过的新键位。
        if (this.playable()) {
            this.instructions = false;
            this.resetClock();
        }
    }
    get status() { return this.statusValue; }
    takeAction() {
        const action = this.pendingAction;
        this.pendingAction = null;
        return action;
    }
    pollHostEvents(now = Date.now()) {
        if (now < this.lastHostPoll)
            this.lastHostPoll = now - HOST_POLL_MS;
        if (now - this.lastHostPoll < HOST_POLL_MS)
            return;
        this.lastHostPoll = now;
        const events = this.tail.poll();
        if (events.length === 0)
            return;
        let sawStart = false;
        let sawDone = false;
        let sawNotify = false;
        for (const event of events) {
            const e = event === 'start' ? 'task-start' : event === 'notify' ? 'task-notify' : 'task-done';
            for (const slot of this.slots)
                try {
                    slot.instance.onHostEvent?.(e);
                }
                catch { /* isolate cartridges */ }
            if (e === 'task-start')
                sawStart = true;
            else if (e === 'task-done')
                sawDone = true;
            else
                sawNotify = true;
        }
        if (this.statusValue !== 'task-done') {
            if (sawDone)
                this.statusValue = 'task-done';
            else if (sawNotify)
                this.statusValue = 'needs-input';
            else if (sawStart && this.statusValue === 'needs-input')
                this.statusValue = 'idle';
        }
        if (!sawDone && !sawNotify)
            return;
        this.pendingAction = 'return-to-cli';
        this.input.clear();
        if (this.paused)
            this.save(this.active);
        else
            this.pause();
    }
    takeViewToggle() { const value = this.viewToggle; this.viewToggle = false; return value; }
    setDisplay(rows, tier) {
        if (rows !== this.displayRows || tier !== this.displayTier)
            this.resetClock();
        this.displayRows = rows;
        this.displayTier = tier;
    }
    playable() {
        const slot = this.slots[this.active];
        if (slot === undefined)
            return false;
        const m = slot.module.manifest;
        const game = slot.instance;
        return this.displayRows <= 2
            ? m.display?.micro === true && this.displayTier !== 'half'
                && (game.renderMicro !== undefined || (this.displayTier === 'graphics' && game.renderPixels !== undefined))
            : this.displayRows >= this.minimumRows();
    }
    minimumRows() {
        const rows = this.slots[this.active]?.module.manifest.display?.minRows ?? 6;
        return this.displayTier === 'half' ? rows * 2 : rows;
    }
    panel() {
        const slot = this.slots[this.active];
        if (slot === undefined)
            return ['没有可用游戏', '请检查已安装 Cartridge · Esc 返回'];
        const m = slot.module.manifest;
        if (!this.playable())
            return [m.name, this.displayRows <= 2
                    ? `E 展开 · 需${this.minimumRows()}行 · Esc 返回`
                    : `需${this.minimumRows()}行，请放大终端或使用 moyu play · Esc 返回`];
        const controls = m.controls.map((c) => `${c.keys[0] ?? ''} ${c.label}`).join(' · ');
        // 进游戏即活后不再有整页说明，操作提示就得常驻第二行 —— 不然玩家根本不知道有
        // 冲刺斩/旋斩这些键。侧栏窄（≈18 个汉字宽），所以用紧排（键紧贴标签、无 · 分隔），
        // 把返回键让给外壳的 Ctrl+] / Esc（待机条已说明）。窄档 surface 仍会回退成 '?帮助 Esc退'。
        if (!this.instructions) {
            const compact = m.controls.map((c) => `${c.keys[0] ?? ''}${c.label}`).join(' ');
            return [slot.instance.hud?.() ?? m.name, compact];
        }
        return [`${m.name} · ${controls}`, 'E 大小 · Tab 换 · Esc 返回'];
    }
    get showingInstructions() { return this.instructions || !this.playable(); }
    resetClock() { this.lastMs = 0; this.acc = 0; this.stepped = false; this.input.clear(); }
    advance(now) {
        const elapsed = this.lastMs === 0 ? 0 : Math.max(0, Math.min(0.25, (now - this.lastMs) / 1000));
        this.lastMs = now;
        if (this.paused || this.instructions || !this.playable()) {
            this.acc = 0;
            return;
        }
        this.acc += elapsed;
        // 不足一个模拟步时保留脉冲。持续方向在每个子步生效，跳/攻击只消费一次。
        if (this.acc < 1 / 60)
            return;
        let first = this.input.take(now);
        const held = { ...EMPTY_INPUT, left: first.left, right: first.right, down: first.down };
        while (this.acc >= 1 / 60) {
            this.slots[this.active].instance.update(1 / 60, first);
            this.stepped = true;
            first = held;
            this.acc -= 1 / 60;
        }
    }
    render(target, profile = 'standard') {
        const slot = this.slots[this.active];
        if (slot === undefined) {
            target.fill(BG);
            return;
        }
        const game = slot.instance;
        target.setGlyphStyle?.(slot.module.manifest.display?.glyphs ?? 'blocks');
        if (profile === 'micro' && !this.playable()) {
            target.fill(BG);
            return;
        }
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
            if (slot.expandedCanvas.height !== height)
                slot.expandedCanvas = new LogicalCanvas(80, height);
            const canvas = slot.expandedCanvas;
            game.renderExpanded(canvas);
            canvas.blit(target);
            return;
        }
        const micro = profile === 'micro' && target.tier !== 'graphics' && game.renderMicro !== undefined;
        const canvas = micro ? slot.microCanvas : slot.canvas;
        if (micro)
            game.renderMicro(canvas);
        else
            game.render(canvas);
        canvas.blit(target);
    }
    hud() {
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
    stateFile(index) { return path.join(process.env.MOYU_HOME ?? path.join(homedir(), '.moyu'), 'state', `${this.slots[index].module.manifest.id}.json`); }
    pause() {
        if (this.paused)
            return;
        this.paused = true;
        this.resetClock();
        const game = this.slots[this.active]?.instance;
        if (game !== undefined) {
            try {
                game.onHostEvent?.('pause');
            }
            catch { /* isolate cartridges */ }
            this.save(this.active);
        }
    }
    resume() {
        if (!this.paused)
            return;
        this.paused = false;
        this.resetClock();
        try {
            this.slots[this.active]?.instance.onHostEvent?.('resume');
        }
        catch { /* isolate cartridges */ }
    }
    loadAll() {
        for (let i = 0; i < this.slots.length; i++)
            try {
                const value = JSON.parse(fs.readFileSync(this.stateFile(i), 'utf8'));
                this.slots[i].instance.restore?.(value);
            }
            catch { /* first run or damaged save: start clean */ }
    }
    save(index) {
        const slot = this.slots[index];
        if (slot === undefined)
            return;
        try {
            const value = slot.instance.serialize?.();
            if (value === undefined)
                return;
            const file = this.stateFile(index);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        }
        catch { /* play must not depend on persistence */ }
    }
}
