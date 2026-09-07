/**
 * 战斗模拟。**零 I/O、零终端知识** —— 只有数字和向量，所以它能无头单测。
 *
 * ## 这个 demo 的设计意图（一句话：手感 > 系统）
 *
 * "酣畅淋漓地砍火柴人"要的是**每一刀都有回报**，所以：
 *
 *   - 杂兵**一刀一个**。没有血条、没有硬直抵抗 —— 挥空才是唯一的惩罚。
 *   - 每次命中给三样东西：**顿帧**（`hitstop`，全世界冻结 45~75ms）、**屏幕震动**、
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
import { Rng } from "./rng.js";
import { poseAir, poseHurt, poseIdle, poseLand, poseSlash, poseWalk, poseWindup, segments } from "./stick.js";
export const NO_INTENT = { move: 0, jump: false, slash: false };
const PLAYER_HP = 4;
/** 落地压扁的持续时间。30fps 下约 3 帧 —— 少于这个数就一闪而过看不见（见 `poseLand`）。 */
const LAND_TIME = 0.1;
export class World {
    w = 80;
    h = 24;
    /** 地面所在的像素行（脚底贴在这一行上）。 */
    ground = 20;
    /** 火柴人身高（像素）。整套物理都按它缩放，所以任何画布尺寸下手感一致。 */
    fh = 12;
    /** 起跳初速。按"头顶不撞出画布"配出来的 —— 矮条形区域里自动变成小跳。 */
    jumpV = 12 * 5.4;
    rng;
    phase = 'title';
    player;
    enemies = [];
    pieces = [];
    blood = [];
    /** 地上的血迹，打包成 `y * 4096 + x`。静止 → diff 之后每帧零成本。 */
    stains = [];
    slashes = [];
    /** 震动幅度（像素），指数衰减。 */
    shake = 0;
    shakeX = 0;
    shakeY = 0;
    /** 全世界冻结剩余（秒）。 */
    hitstop = 0;
    /** 清屏技的冲击波半径；null = 没在放。 */
    waveR = null;
    /** 全屏闪白剩余（秒）。只有清屏技用 —— 全画布变色是一次全量重绘，不能常用。 */
    flash = 0;
    kills = 0;
    /** 本次任务砍了多少 —— 横幅上报的就是这个数。 */
    taskKills = 0;
    combo = 0;
    bestCombo = 0;
    comboT = 0;
    /** 玩家死了，重生倒计时。 */
    respawn = 0;
    deaths = 0;
    /** 打了多久（秒），出怪节奏按它加压。 */
    heat = 0;
    /** 宿主可限制实际参与战斗的敌人数，避免仅在渲染层隐藏敌人。 */
    enemyLimit = 11;
    spawnT = 1.2;
    time = 0;
    constructor(seed = 0x5eed1234) {
        this.rng = new Rng(seed);
        this.player = this.makePlayer();
    }
    /* ── 尺寸 ──────────────────────────────────────────────────────── */
    /**
     * 画布尺寸变了（终端 resize / 焦点联动分屏）。
     *
     * 位置按比例缩放而不是清场：正在打的一场不该因为拖了一下窗口就重来。
     */
    resize(w, h) {
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
            f.h = f.kind === 'player' ? this.fh : Math.round(this.fh * 0.9);
            f.speed = f.kind === 'player' ? this.playerSpeed() : f.speed * ratio;
        }
        for (const p of this.pieces) {
            p.x *= sx;
            p.y *= sy;
        }
        for (const b of this.blood) {
            b.x *= sx;
            b.y *= sy;
        }
        // 血迹坐标是打包的整数，缩放会算出重复格子，直接丢掉重来 —— 它只是装饰。
        this.stains.length = 0;
        this.slashes.length = 0;
    }
    /* ── 外部信号 ──────────────────────────────────────────────────── */
    /** 任务跑完了：放清屏技，然后暂停等下一个任务。 */
    taskDone() {
        if (this.phase === 'clear')
            return;
        this.phase = 'clear';
        this.waveR = 0;
        this.flash = 0.10;
        this.shake = 2.6;
    }
    /** 下一个任务开始了：把上一场的尸堆冲掉，继续出怪。 */
    taskStart() {
        if (this.phase === 'fight')
            return;
        this.phase = 'fight';
        this.waveR = null;
        this.taskKills = 0;
        this.heat = 0;
        this.spawnT = 0.6;
        this.pieces.length = 0;
        this.blood.length = 0;
        this.stains.length = 0;
        this.enemies.length = 0;
        this.player.hp = PLAYER_HP;
    }
    /* ── 主步进 ────────────────────────────────────────────────────── */
    /** 固定步长推进一帧。`dt` 恒为 1/60 —— 变步长会让物理在掉帧时抽风。 */
    step(dt, input) {
        this.time += dt;
        // 震动和闪白**不**受顿帧影响：它们是冲击的表现，不是世界的一部分。
        this.shake *= Math.exp(-dt * 11);
        if (this.shake < 0.05)
            this.shake = 0;
        this.shakeX = Math.round(this.rng.spread(this.shake));
        // 竖直分量按**身高**夹取。横向不夹：40 像素宽的条形场地里 3 像素的横移正是那一下
        // 冲击感，而且背景是整条 hline，横移一格在 diff 之后几乎不要钱。竖直就不一样了 ——
        // 条形模式整块画布只有 4 个像素行，1 像素的上下抖动等于把地面掀了。
        this.shakeY = Math.round(this.rng.spread(Math.min(this.shake * 0.55, this.fh * 0.12)));
        if (this.flash > 0)
            this.flash -= dt;
        if (this.hitstop > 0) {
            this.hitstop -= dt;
            return;
        }
        if (this.phase === 'paused') {
            // 暂停时只留呼吸，好让画面不像死图。玩家想接着打就按砍键（不必等下一个任务）。
            this.player.anim += dt;
            this.player.pose = poseIdle(this.player.anim);
            if (input.slash)
                this.taskStart();
            return;
        }
        if (this.phase === 'title' && (input.slash || input.move !== 0)) {
            this.phase = 'fight';
            this.spawnT = 0.35;
        }
        if (this.respawn > 0) {
            this.respawn -= dt;
            if (this.respawn <= 0) {
                this.player = this.makePlayer();
            }
        }
        else {
            this.stepPlayer(dt, input);
        }
        for (const e of this.enemies)
            this.stepGrunt(dt, e);
        this.stepPieces(dt);
        this.stepBlood(dt);
        this.stepSlashes(dt);
        if (this.phase === 'clear')
            this.stepWave(dt);
        else if (this.phase === 'fight') {
            this.heat += dt;
            this.spawn(dt);
        }
        if (this.comboT > 0) {
            this.comboT -= dt;
            if (this.comboT <= 0)
                this.combo = 0;
        }
    }
    /* ── 玩家 ──────────────────────────────────────────────────────── */
    /**
     * 玩家最高速度。**下限跟场地宽度挂钩**，不只跟身高挂钩。
     *
     * 条形模式里身高只有 3 像素、场地却有 40 像素宽：`fh × 2.4 = 7.2 像素/秒`
     * 意味着横穿场地要五秒半，走起来像在爬。所以再压一条"约 2.6 秒能横穿一趟"的下限。
     * 半屏 / 全屏尺寸下 `fh × 2.4` 本来就更大，这条不生效（160 宽 × 身高 26 → 62.4 对 61.5）。
     */
    playerSpeed() {
        return Math.max(this.fh * 2.4, this.w / 2.6);
    }
    makePlayer() {
        return {
            kind: 'player', x: this.w * 0.5, y: this.ground, vx: 0, vy: 0,
            h: this.fh, face: 1, onGround: true, hp: PLAYER_HP,
            walk: 0, anim: 0, atk: -1, atkHit: false, atkQueued: false,
            hurt: 0, land: 0, invuln: 0.6, windup: -1, cool: 0, speed: this.playerSpeed(),
            pose: poseIdle(0), armed: true,
        };
    }
    stepPlayer(dt, input) {
        const p = this.player;
        p.anim += dt;
        if (p.hurt > 0)
            p.hurt -= dt;
        if (p.invuln > 0)
            p.invuln -= dt;
        // 攻击中不能改朝向、不能主动移动 —— 挥刀是一次承诺，能中途转向的话
        // 就变成了"无脑乱挥都能中"，挥空的惩罚也就没了。
        const busy = p.atk >= 0 && p.atk < 0.46;
        if (input.slash) {
            if (p.atk < 0) {
                p.atk = 0;
                p.atkHit = false;
            }
            else if (p.atk > 0.46)
                p.atkQueued = true; // 收招段按下 → 接下一刀
        }
        if (!busy) {
            if (input.move !== 0) {
                p.face = input.move > 0 ? 1 : -1;
                p.vx += input.move * p.speed * 6.7 * dt;
            }
            if (input.jump && p.onGround) {
                p.vy = -this.jumpV;
                p.onGround = false;
            }
        }
        const maxV = p.speed * (busy ? 0.25 : 1);
        p.vx = clamp(p.vx, -maxV, maxV);
        // 地面摩擦比空中大得多：地面要"停得住"，空中要保留冲量（跳劈才有距离感）。
        p.vx *= Math.exp(-dt * (p.onGround ? 11 : 2.5));
        this.integrate(dt, p);
        if (p.atk >= 0) {
            p.atk += dt;
            // 判定放在挥出段的前段：视觉上刀正好扫到身前，而不是收招时才结算。
            if (!p.atkHit && p.atk >= 0.30) {
                p.atkHit = true;
                this.resolveSlash(p);
            }
            if (p.atk >= 0.62) {
                p.atk = p.atkQueued ? 0 : -1;
                p.atkHit = false;
                p.atkQueued = false;
            }
        }
        p.pose = this.poseFor(p);
    }
    /** 一刀的判定。命中的每一个杂兵都当场砍碎。 */
    resolveSlash(p) {
        const reach = this.fh * 1.15;
        const pivotY = p.y - this.fh * 0.72;
        let hit = 0;
        // 从后往前删，命中多个就是多个 —— 挤成一团的杂兵被一刀带走是这游戏最爽的瞬间。
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            const dx = (e.x - p.x) * p.face;
            if (dx < -this.fh * 0.35 || dx > reach)
                continue;
            // 竖直重叠：拿双方的身体区间比，跳劈砍不到脚下的人才合理。
            if (e.y - e.h > p.y + this.fh * 0.15 || e.y < p.y - this.fh * 1.05)
                continue;
            // 越远砍得越低 —— 刀是扫下来的，边缘够到的是腿。
            const frac = clamp(dx / reach, 0, 1);
            const cutY = e.y - e.h * clamp(0.78 - frac * 0.5, 0.18, 0.88);
            this.dismember(e, cutY, p.face, 1);
            this.enemies.splice(i, 1);
            hit++;
        }
        const a0 = -1.95;
        const a1 = 0.65;
        this.slashes.push({
            x: p.x + p.face * this.fh * 0.1, y: pivotY, r: reach * 0.92,
            a0: p.face > 0 ? a0 : Math.PI - a0, a1: p.face > 0 ? a1 : Math.PI - a1,
            life: 0.14, max: 0.14, big: false,
        });
        if (hit > 0) {
            this.kills += hit;
            this.taskKills += hit;
            this.combo += hit;
            this.comboT = 1.6;
            if (this.combo > this.bestCombo)
                this.bestCombo = this.combo;
            // 顿帧随连击轻微加长，但有上限 —— 太长会从"有力"变成"卡"。
            this.hitstop = Math.min(0.075, 0.045 + hit * 0.012 + this.combo * 0.002);
            this.shake = Math.min(2.8, this.shake + 0.85 + hit * 0.35);
        }
    }
    /* ── 杂兵 ──────────────────────────────────────────────────────── */
    spawn(dt) {
        this.spawnT -= dt;
        // 上限同时受场地宽度约束：一个人占 0.45×身高 的间距，40 像素宽塞 11 个就是一堵墙。
        const maxLive = Math.min(this.enemyLimit, 11, Math.max(2, Math.round(this.w / 12)), 3 + Math.floor(this.heat / 7));
        if (this.spawnT > 0 || this.enemies.length >= maxLive)
            return;
        this.spawnT = clamp(1.5 - this.heat * 0.045, 0.42, 1.5) * this.rng.range(0.7, 1.3);
        const fromLeft = this.rng.chance(0.5);
        const h = Math.round(this.fh * this.rng.range(0.78, 1.0));
        this.enemies.push({
            kind: 'grunt',
            x: fromLeft ? -this.fh * 0.5 : this.w + this.fh * 0.5,
            y: this.ground, vx: 0, vy: 0, h,
            face: fromLeft ? 1 : -1, onGround: true, hp: 1,
            walk: this.rng.float(), anim: this.rng.float() * 3,
            atk: -1, atkHit: false, atkQueued: false, hurt: 0, land: 0, invuln: 0,
            windup: -1, cool: this.rng.range(0, 0.5),
            speed: this.playerSpeed() * this.rng.range(0.35, 0.56),
            pose: poseIdle(0), armed: false,
        });
    }
    stepGrunt(dt, e) {
        e.anim += dt;
        if (e.cool > 0)
            e.cool -= dt;
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
                if (alive && Math.abs(p.x - e.x) < this.fh * 1.05 && p.invuln <= 0)
                    this.hurtPlayer(Math.sign(e.face));
            }
        }
        else if (alive && near && e.cool <= 0) {
            e.windup = 0.42;
            e.face = dx >= 0 ? 1 : -1;
        }
        else if (alive && this.phase !== 'clear') {
            e.face = dx >= 0 ? 1 : -1;
            e.vx += e.face * e.speed * 9 * dt;
            e.vx = clamp(e.vx, -e.speed, e.speed);
            // 互相推开一点，不然一群人会完全重叠成一个人。
            for (const o of this.enemies) {
                if (o === e)
                    continue;
                const d = o.x - e.x;
                if (Math.abs(d) < this.fh * 0.45)
                    e.vx -= Math.sign(d || 1) * this.fh * 1.5 * dt;
            }
        }
        else {
            e.vx *= Math.exp(-dt * 8);
        }
        this.integrate(dt, e);
        e.pose = this.poseFor(e);
    }
    hurtPlayer(dir) {
        const p = this.player;
        p.hp -= 1;
        p.hurt = 0.35;
        p.invuln = 0.85;
        p.vx = dir * this.fh * 2.2;
        p.vy = -this.fh * 1.6;
        p.onGround = false;
        p.atk = -1;
        this.hitstop = 0.09;
        this.shake = Math.min(3, this.shake + 1.4);
        this.combo = 0;
        if (p.hp <= 0) {
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
    dismember(f, cutY, dir, power) {
        const body = { x: f.x, y: f.y, h: f.h, face: f.face, pose: f.pose, armed: false };
        const s = this.fx;
        const mine = f.kind === 'player';
        for (const seg of segments(body)) {
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
            }
            else {
                this.addSeg(seg.x0, seg.y0, seg.x1, seg.y1, above0, dir, power, mine);
            }
        }
        this.spillBlood(f.x, cutY, dir, s, power);
    }
    addSeg(x0, y0, x1, y1, above, dir, power, mine) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 0.4)
            return;
        this.pushPiece((x0 + x1) / 2, (y0 + y1) / 2, len / 2, false, above, dir, power, mine, Math.atan2(dy, dx));
    }
    pushPiece(x, y, half, head, above, dir, power, mine, ang) {
        const s = this.fx;
        const lift = above ? 1 : 0.35;
        this.pieces.push({
            x, y, half, head, ang, mine, rest: false,
            vx: dir * this.rng.range(0.8, 3.4) * s * power * lift + this.rng.spread(s * 0.5),
            vy: -this.rng.range(0.9, 3.0) * s * power * lift,
            av: this.rng.spread(15) * (above ? 1 : 0.5),
        });
        // 尸堆有上限：地上的碎块虽然静止（diff 免费），但太多就糊成一片看不出是尸体了。
        if (this.pieces.length > 150)
            this.pieces.splice(0, this.pieces.length - 150);
    }
    spillBlood(x, y, dir, s, power) {
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
    get fx() {
        return Math.max(this.fh, this.w * 0.12);
    }
    integrate(dt, f) {
        const g = this.fh * 26;
        f.vy += g * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.land > 0)
            f.land -= dt;
        if (f.y >= this.ground) {
            // 落地压扁只给**真的砸下来**的那一下。站在地上每帧都会走到这里，
            // 不看"上一帧还在空中 + 下落够快"的话，走路会一直抖。
            if (!f.onGround && f.vy > this.fh * 5)
                f.land = LAND_TIME;
            f.y = this.ground;
            f.vy = 0;
            f.onGround = true;
        }
        else
            f.onGround = false;
        // 玩家撞墙，杂兵不撞（它们从墙外走进来）。
        if (f.kind === 'player')
            f.x = clamp(f.x, 1, this.w - 2);
        if (f.onGround && Math.abs(f.vx) > this.fh * 0.25)
            f.walk = (f.walk + dt * (0.9 + Math.abs(f.vx) / (f.speed * 0.6))) % 1;
    }
    poseFor(f) {
        if (f.atk >= 0)
            return poseSlash(clamp(f.atk / 0.62, 0, 1));
        if (f.windup >= 0)
            return poseWindup(clamp(1 - f.windup / 0.42, 0, 1));
        if (f.hurt > 0)
            return poseHurt(clamp(f.hurt / 0.35, 0, 1));
        if (!f.onGround)
            return poseAir(f.vy < 0);
        // 压扁让位给攻击和受击（上面两条已经 return 了）—— 落地立刻出刀时，
        // 该看见的是刀而不是屈膝。
        if (f.land > 0)
            return poseLand(clamp(f.land / LAND_TIME, 0, 1));
        if (Math.abs(f.vx) > this.fh * 0.25)
            return poseWalk(f.walk);
        return poseIdle(f.anim);
    }
    stepPieces(dt) {
        const g = this.fh * 26;
        for (const p of this.pieces) {
            if (p.rest)
                continue;
            p.vy += g * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.ang += p.av * dt;
            const floor = this.ground - 0.3;
            if (p.y >= floor) {
                p.y = floor;
                // 弹一下再躺平。直接停会像贴在地上，弹一下才有重量。
                if (Math.abs(p.vy) > this.fh * 0.9) {
                    p.vy = -Math.abs(p.vy) * 0.34;
                    p.vx *= 0.55;
                    p.av *= 0.45;
                }
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
    stepBlood(dt) {
        const g = this.fh * 24;
        for (let i = this.blood.length - 1; i >= 0; i--) {
            const b = this.blood[i];
            b.vy += g * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.life -= dt;
            const hitFloor = b.y >= this.ground - 0.2;
            if (hitFloor || b.life <= 0) {
                if (hitFloor)
                    this.stain(b.x, this.ground - 0.2 + this.rng.range(0, 1.2), 1);
                this.blood.splice(i, 1);
            }
        }
    }
    /** 在地上留一滴血。整数打包 + 去重，静止的像素在 diff 之后是零成本的。 */
    stain(x, y, size) {
        const cx = Math.round(x);
        const cy = Math.round(y);
        for (let i = 0; i < size; i++) {
            const sx = cx + (i === 0 ? 0 : Math.round(this.rng.spread(1.6)));
            const sy = cy + (i === 0 ? 0 : Math.round(this.rng.spread(0.8)));
            if (sx < 0 || sx >= this.w || sy < 0 || sy >= this.h)
                continue;
            const key = sy * 4096 + sx;
            if (!this.stains.includes(key))
                this.stains.push(key);
        }
        if (this.stains.length > 1400)
            this.stains.splice(0, this.stains.length - 1400);
    }
    stepSlashes(dt) {
        for (let i = this.slashes.length - 1; i >= 0; i--) {
            const s = this.slashes[i];
            s.life -= dt;
            if (s.life <= 0)
                this.slashes.splice(i, 1);
        }
    }
    /**
     * 清屏技：以玩家为中心的冲击波向两边推，波锋扫到谁就当场砍碎。
     *
     * 为什么是"扫过去"而不是"全场同时死"：同时死只有一帧的信息量，扫过去有 0.5 秒的
     * 连续反馈，而且断肢会按波锋方向分左右两拨飞 —— 这是任务跑完时那一下的仪式感。
     */
    stepWave(dt) {
        if (this.waveR === null) {
            this.phase = 'paused';
            return;
        }
        this.waveR += (this.w / 0.55) * dt;
        const r = this.waveR;
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            if (Math.abs(e.x - this.player.x) > r)
                continue;
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
function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
/** 给渲染层用：把一个 Fighter 变成骨架需要的最小信息。 */
export function bodyOf(f) {
    return { x: f.x, y: f.y, h: f.h, face: f.face, pose: f.pose, armed: f.armed };
}
