/**
 * 火柴人骨架：姿态（一组关节角）→ 世界坐标的线段列表。
 *
 * ## 角度约定（记在这里，散在各处会立刻乱）
 *
 * 所有关节角的 **0 = 竖直**，正方向 = 角色**朝向**那一侧。于是同一份姿态数据
 * 左右翻转只需要改 `face`，不需要给每个角取反 —— 走路动画写一遍就够。
 *
 *   往下长的肢体（四肢、刀）：`(x + sin(a)·len·face, y + cos(a)·len)`
 *   往上长的部分（躯干、脖子）：`(x + sin(a)·len·face, y − cos(a)·len)`
 *
 * ## 为什么姿态要**存在实体上**而不是画的时候临时算
 *
 * 砍碎动画要把肢体当刚体扔出去，它需要**死亡那一瞬间**每条肢体在世界里的确切位置。
 * 如果姿态是渲染时才算的，模拟层就拿不到它，断肢只能从一个假的标准姿态生成 ——
 * 那样断口和刀的位置对不上，一眼假。所以 `Fighter.pose` 是模拟状态的一部分。
 */
/** 各部件占身高的比例。改这里就是改体型。 */
const P = {
    hip: 0.46,
    torso: 0.34,
    neck: 0.08,
    headR: 0.115,
    upperArm: 0.19,
    foreArm: 0.17,
    thigh: 0.25,
    shin: 0.23,
    blade: 0.62,
};
/**
 * 小尺寸的横向补偿。**这是"看得出是个人"的一半。**
 *
 * 半块画布的一个像素就是一个格子，没有子像素。身高 10 像素时大腿只有 2.5 像素，
 * 髋角 0.3 弧度算出来的横向偏移是 0.74 像素 —— 四舍五入后两条腿落在同一列，
 * 于是整个人退化成一条竖线加一个点。角度没错，是**量化**把它吃掉了。
 *
 * 解法是只放大**横向**分量（纵向不动，所以身高、地面接触都不变）：18 像素以上
 * 不补偿（那时候一个像素已经够细了），越矮补得越多，到 8 像素时 1.5 倍。
 * 代价是矮的时候四肢比例偏"外八"—— 在这个尺寸上，认得出人远比比例准重要。
 */
function spreadOf(h) {
    return h >= 18 ? 1 : 1 + (18 - h) * 0.05;
}
function dn(x, y, a, len, face) {
    return [x + Math.sin(a) * len * face, y + Math.cos(a) * len];
}
function up(x, y, a, len, face) {
    return [x + Math.sin(a) * len * face, y - Math.cos(a) * len];
}
/**
 * 姿态 → 线段。顺序就是绘制顺序（后画的盖在前面）：先腿、再躯干、再头、再手臂、最后刀。
 *
 * 刀放最后是因为它是画面里唯一的亮色 —— 被身体盖住的刀看起来像断了。
 */
export function segments(b) {
    const h = b.h * (1 - b.pose.crouch * 0.22);
    // 横向补偿直接乘进 face：dn/up 里 face 只作用在 sin 项上，所以纵向一点没变。
    const f = b.face * spreadOf(h);
    const p = b.pose;
    const hx = b.x;
    const hy = b.y - h * P.hip;
    const [nx, ny] = up(hx, hy, p.lean, h * P.torso, f);
    const [hcx, hcy] = up(nx, ny, p.lean, h * (P.neck + P.headR), f);
    // 肩在躯干靠上 8 分处 —— 直接用脖子会让手臂长在下巴上。
    const sx = hx + (nx - hx) * 0.88;
    const sy = hy + (ny - hy) * 0.88;
    const [eax, eay] = dn(sx, sy, p.armA, h * P.upperArm, f);
    const [hax, hay] = dn(eax, eay, p.armA + p.elbowA, h * P.foreArm, f);
    const [ebx, eby] = dn(sx, sy, p.armB, h * P.upperArm, f);
    const [hbx, hby] = dn(ebx, eby, p.armB + p.elbowB, h * P.foreArm, f);
    const [kax, kay] = dn(hx, hy, p.hipA, h * P.thigh, f);
    const [fax, fay] = dn(kax, kay, p.hipA + p.kneeA, h * P.shin, f);
    const [kbx, kby] = dn(hx, hy, p.hipB, h * P.thigh, f);
    const [fbx, fby] = dn(kbx, kby, p.hipB + p.kneeB, h * P.shin, f);
    const [btx, bty] = dn(hax, hay, p.blade, h * P.blade, f);
    const segs = [
        { part: 'legB', x0: hx, y0: hy, x1: kbx, y1: kby, r: 0 },
        { part: 'legB', x0: kbx, y0: kby, x1: fbx, y1: fby, r: 0 },
        { part: 'legA', x0: hx, y0: hy, x1: kax, y1: kay, r: 0 },
        { part: 'legA', x0: kax, y0: kay, x1: fax, y1: fay, r: 0 },
        { part: 'armB', x0: sx, y0: sy, x1: ebx, y1: eby, r: 0 },
        { part: 'armB', x0: ebx, y0: eby, x1: hbx, y1: hby, r: 0 },
        { part: 'torso', x0: hx, y0: hy, x1: nx, y1: ny, r: 0 },
        { part: 'head', x0: hcx, y0: hcy, x1: hcx, y1: hcy, r: h * P.headR },
        { part: 'armA', x0: sx, y0: sy, x1: eax, y1: eay, r: 0 },
        { part: 'armA', x0: eax, y0: eay, x1: hax, y1: hay, r: 0 },
    ];
    if (b.armed)
        segs.push({ part: 'blade', x0: hax, y0: hay, x1: btx, y1: bty, r: 0 });
    return segs;
}
/** 刀尖在世界里的位置。刀光轨迹要用它。 */
export function bladeTip(b) {
    const segs = segments(b);
    const s = segs[segs.length - 1];
    return [s.x1, s.y1];
}
/**
 * 主角的斗笠：一条宽帽檐 + 两根收顶的坡线，锚在头段上，随姿态走、随朝向翻（帽檐对称，不用翻）。
 * 刻意不进 `segments()`：断肢拆分、跳跃顶点的画布余量（strip.test）都按裸骨架算，帽子只是
 * 渲染层的身份标识。段标成 `armB` 是为了白捡各渲染器里"四肢"的笔宽与描边逻辑。
 */
export function heroHat(head, h) {
    const brimY = head.y0 - head.r * 0.55;
    const half = h * 0.19;
    const apexY = head.y0 - head.r * 1.55;
    return [
        { part: 'armB', x0: head.x0 - half, y0: brimY, x1: head.x0 + half, y1: brimY, r: 0 },
        { part: 'armB', x0: head.x0 - half * 0.55, y0: brimY, x1: head.x0, y1: apexY, r: 0 },
        { part: 'armB', x0: head.x0 + half * 0.55, y0: brimY, x1: head.x0, y1: apexY, r: 0 },
    ];
}
/* ────────────────────────────── 姿态库 ────────────────────────────── */
const TAU = Math.PI * 2;
/**
 * 站着：极小幅度的呼吸起伏。完全静止的火柴人看起来像贴图，动一点点就"活"了。
 *
 * 站姿是**唯一需要为可读性专门放宽的姿态** —— 别的姿态本身就有大幅度的开合，
 * 只有站着的时候四肢最接近竖直，也就最容易在量化后叠成一条线。所以髋角
 * 从 0.18/−0.16 放到 0.30/−0.28、肩角从 0.30/−0.22 放到 0.42/−0.42：
 * 站着不动时也要一眼看出两条腿、两条胳膊。抬高后脚底仍然落在地面上
 * （cos 项算下来差 0.01×身高，不到半个像素）。
 */
export function poseIdle(t) {
    const b = Math.sin(t * 1.9);
    return {
        lean: 0.03 + b * 0.02,
        armA: 0.42 + b * 0.04, elbowA: 0.34,
        // `elbowB` 是**负的**：肘角是叠加在肩角上的，而 armB 往后、elbowB 往前的话
        // 两者相消 —— 原来的 −0.22 + 0.30 净得 +0.08，前臂几乎垂直，整条空手臂就贴在
        // 躯干那一列上看不见了。负号让前臂接着往后甩，站着不动也看得出有第二条胳膊。
        armB: -0.42 - b * 0.04, elbowB: -0.16,
        hipA: 0.30, kneeA: 0.12,
        hipB: -0.28, kneeB: 0.16,
        blade: 0.95 + b * 0.05,
        crouch: 0.02 + b * 0.02,
    };
}
/** 走：两腿反相摆动，后腿屈膝，手臂反向摆。`phase` 是 0..1 的循环相位。 */
export function poseWalk(phase) {
    const s = Math.sin(phase * TAU);
    return {
        lean: 0.10,
        armA: 0.30 - s * 0.40, elbowA: 0.30,
        armB: -0.20 + s * 0.45, elbowB: 0.35,
        hipA: 0.10 + s * 0.62, kneeA: 0.10 + Math.max(0, -s) * 0.55,
        hipB: 0.10 - s * 0.62, kneeB: 0.10 + Math.max(0, s) * 0.55,
        blade: 0.85 - s * 0.10,
        // 迈步时重心起伏。一个周期两次（每只脚各一次），所以是 2×相位。
        crouch: 0.05 + Math.abs(Math.sin(phase * TAU)) * 0.05,
    };
}
/** 腾空：收腿。`rise` > 0 是上升段。 */
export function poseAir(rise) {
    return {
        lean: rise ? -0.12 : 0.14,
        armA: rise ? -0.85 : 0.55, elbowA: 0.45,
        armB: rise ? -1.15 : 0.20, elbowB: 0.50,
        hipA: 0.55, kneeA: 0.85,
        hipB: -0.35, kneeB: 0.65,
        blade: rise ? -0.6 : 1.35,
        crouch: 0.10,
    };
}
const SLASH_SWING = {
    normal: { lean: 0.32, armA: 1.62, elbowA: 0.12, armB: -0.24, elbowB: 0.30, hipA: 0.42, kneeA: 0.18, hipB: -0.34, kneeB: 0.30, blade: 1.95, crouch: 0.06 },
    air: { lean: 0.42, armA: 1.90, elbowA: 0.18, armB: -0.50, elbowB: 0.40, hipA: 0.60, kneeA: 0.90, hipB: -0.40, kneeB: 0.70, blade: 2.35, crouch: 0.12 },
    sweep: { lean: 0.20, armA: 1.72, elbowA: 0.10, armB: -0.20, elbowB: 0.30, hipA: 0.56, kneeA: 0.48, hipB: -0.56, kneeB: 0.48, blade: 2.55, crouch: 0.48 },
    lunge: { lean: 0.50, armA: 1.35, elbowA: 0.06, armB: -0.52, elbowB: 0.22, hipA: 0.72, kneeA: 0.52, hipB: -0.55, kneeB: 0.08, blade: 1.50, crouch: 0.06 },
};
export function poseSlash(p, kind = 'normal') {
    const stance = { hipA: 0.42, kneeA: 0.18, hipB: -0.34, kneeB: 0.30 };
    if (p < 0.28) {
        const k = holdK(p / 0.28, 2); // 抬刀：抬起 → 拉到头顶后方
        return {
            lean: -0.05 - k * 0.20,
            armA: 0.30 - k * 2.45, elbowA: 0.25 + k * 0.55,
            armB: -0.20 - k * 0.55, elbowB: 0.30,
            ...stance,
            blade: 0.95 - k * 3.55,
            crouch: 0.04 + k * 0.06,
        };
    }
    if (p < 0.46) {
        // 挥出：**一个**姿势撑满整段。这是"砍到了"那一下的定格，中间过程由刀光的圆弧和残影交代。
        // 四种变招各有专属定格（见 SLASH_SWING）；返回副本，避免任何调用方就地改到共享对象。
        return { ...SLASH_SWING[kind] };
    }
    const k = holdK((p - 0.46) / 0.54, 3);
    return {
        lean: 0.30 - k * 0.27,
        armA: 1.50 - k * 1.20, elbowA: 0.15 + k * 0.10,
        armB: -0.20, elbowB: 0.30,
        hipA: stance.hipA - k * 0.24, kneeA: 0.18 - k * 0.12,
        hipB: stance.hipB + k * 0.18, kneeB: 0.30 - k * 0.20,
        blade: 1.75 - k * 0.80,
        crouch: 0.06 - k * 0.04,
    };
}
/**
 * 落地压扁。`k` 从 1 衰减到 0，只在真的从空中砸下来那一下给（见 `world.ts` 的 `land`）。
 *
 * 这是三件套（起跳压扁 / 上升拉长 / 落地压扁）里**唯一保留**的一件：拉长要用负的
 * `crouch`，而负 crouch 会把身体拉高到条外 —— `test/game/strip.test.ts` 钉着
 * "跳到最高点头也不出画布"，60×16 那个尺寸只剩 0.15 像素余量，4% 的拉长就破了。
 * 压扁是正的 crouch，永远只会让身体更矮，任何尺寸下都安全。
 */
export function poseLand(k) {
    return {
        lean: 0.08 + k * 0.10,
        armA: 0.30 - k * 0.75, elbowA: 0.30 + k * 0.35,
        armB: -0.25 - k * 0.70, elbowB: 0.25 + k * 0.35,
        // 屈膝是"压扁"读得出来的那一半 —— 只把身高按 crouch 缩 22% 眼睛看不见。
        hipA: 0.34 + k * 0.34, kneeA: 0.14 + k * 0.62,
        hipB: -0.30 - k * 0.30, kneeB: 0.18 + k * 0.58,
        blade: 0.95 - k * 0.25,
        crouch: 0.05 + k * 0.30,
    };
}
/** 段内把进度量化成 `n` 个"保持住"的关键值：每个值占 1/n 段时长。 */
function holdK(t, n) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
    return (i + 1) / n;
}
/** 挨打：后仰 + 手臂乱挥。`k` 从 1 衰减到 0。 */
export function poseHurt(k) {
    return {
        lean: -0.55 * k,
        armA: 0.30 - k * 1.10, elbowA: 0.25 + k * 0.40,
        armB: -0.20 - k * 1.30, elbowB: 0.30,
        hipA: 0.30 + k * 0.20, kneeA: 0.20,
        hipB: -0.25 - k * 0.15, kneeB: 0.15,
        blade: 0.95 - k * 0.60,
        crouch: 0.05 + k * 0.15,
    };
}
/** 杂兵的攻击前摇：双手抬起。`k` 从 0 涨到 1，涨满就打出去。 */
export function poseWindup(k) {
    return {
        lean: -0.10 - k * 0.18,
        armA: 0.30 - k * 2.10, elbowA: 0.25 + k * 0.50,
        armB: -0.20 - k * 1.90, elbowB: 0.25 + k * 0.50,
        hipA: 0.28, kneeA: 0.16,
        hipB: -0.24, kneeB: 0.22,
        blade: 0.95,
        crouch: 0.04 + k * 0.10,
    };
}
/* ── Boss 专属姿态 ──────────────────────────────────────────────────
 * boss 借用同一副骨架，但把角度做得比杂兵/玩家更夸张 —— 让每种招式在起手(windup)那一刻
 * 就有一眼可辨的剪影，玩家能"预判它要冲/要扫/要劈"。只经 boss 渲染路径，不进裸 World 测试。
 * 由 world.ts 的 poseFor 按 boss 的计时状态(dashT/spinT/windup)与"即将出的招"路由。 */
/** Boss 前摇：按即将出的招各自蓄力。charge=大幅后仰蓄势、sweep=下沉屈膝回旋、melee/slam=举刀过顶。 */
export function poseBossWindup(move, k) {
    if (move === 'charge') {
        // 极端后仰、双手收于身侧压低重心，像蓄力要窜出去。
        return {
            lean: -0.30 - k * 0.35,
            armA: 0.30 - k * 0.55, elbowA: 0.55,
            armB: -0.25 - k * 0.30, elbowB: 0.45,
            hipA: 0.55 + k * 0.20, kneeA: 0.40 + k * 0.30,
            hipB: -0.50 - k * 0.20, kneeB: 0.10,
            blade: 0.70 + k * 0.20,
            crouch: 0.10 + k * 0.22,
        };
    }
    if (move === 'sweep') {
        // 下沉、屈膝、刀横拉到身后一侧，蓄一整圈横扫。
        return {
            lean: 0.05 - k * 0.10,
            armA: 0.30 + k * 0.90, elbowA: 0.30,
            armB: -0.20 - k * 0.40, elbowB: 0.30,
            hipA: 0.50 + k * 0.25, kneeA: 0.45 + k * 0.35,
            hipB: -0.50 - k * 0.25, kneeB: 0.45 + k * 0.35,
            blade: 0.95 + k * 1.30,
            crouch: 0.20 + k * 0.30,
        };
    }
    // melee/slam：举刀过顶后仰，蓄一记重劈（比玩家 poseSlash 的抬刀更大更慢）。
    return {
        lean: -0.15 - k * 0.30,
        armA: 0.30 - k * 2.75, elbowA: 0.25 + k * 0.60,
        armB: -0.20 - k * 0.60, elbowB: 0.30,
        hipA: 0.34, kneeA: 0.18,
        hipB: -0.30, kneeB: 0.22,
        blade: 0.95 - k * 4.10,
        crouch: 0.04 + k * 0.08,
    };
}
/** Boss 冲撞：极端前倾冲刺姿、刀平举在前。`p` 0..1 越冲越前压。 */
export function poseBossCharge(p) {
    const k = holdK(p, 2);
    return {
        lean: 0.55 + k * 0.20,
        armA: 1.30, elbowA: 0.05,
        armB: -0.60, elbowB: 0.20,
        hipA: 0.80, kneeA: 0.30,
        hipB: -0.70, kneeB: 0.10,
        blade: 1.45,
        crouch: 0.14,
    };
}
/** Boss 横扫：躯干大幅回旋，刀从一侧扫到另一侧。`p` 0..1 驱动刀角走整圈。 */
export function poseBossSweep(p) {
    return {
        lean: 0.10,
        armA: 1.70, elbowA: 0.10,
        armB: -0.30, elbowB: 0.30,
        hipA: 0.55, kneeA: 0.40,
        hipB: -0.55, kneeB: 0.40,
        // 刀从身后一路扫到身前下方（近整圈的横扫）。
        blade: 0.6 + p * 2.4,
        crouch: 0.30,
    };
}
/** Boss 重劈落点：举刀过顶 → 下劈的定格（幅度比玩家更大更慢）。`p` 0..1。 */
export function poseBossSlam(p) {
    const k = holdK(p, 2);
    return {
        lean: 0.20 + k * 0.30,
        armA: 0.30 + k * 1.70, elbowA: 0.10,
        armB: -0.24, elbowB: 0.30,
        hipA: 0.46, kneeA: 0.22,
        hipB: -0.38, kneeB: 0.30,
        blade: 0.5 + k * 1.85,
        crouch: 0.06 + k * 0.06,
    };
}
