import { heroHat } from "../core/stick.js";
import { bossPhase } from "../core/world.js";
import { fighterSegments } from "../core/creature.js";
import { paintLandmark, paintSwordArt, paintBossPressure } from "./wuxia.js";
export const PIXEL_PALETTES = {
    dark: {
        bg: 0x101218, floor: 0x303641, key: 0x08090c,
        hero: 0xeff2f6, foe: 0xb6a393, blade: 0xebc875, hit: 0xffffff,
        pieceAir: 0xc6cad6, pieceDead: 0x5c5f6c, trail: 0xc4e2ff,
        blood: 0xd6222e, stain: 0x68121a, wave: 0xfff4c8, accent: 0xf17869,
    },
    light: {
        bg: 0xf3f4f6, floor: 0xb9bec7, key: 0x11151b,
        hero: 0x242a33, foe: 0x755746, blade: 0x805b00, hit: 0x101218,
        pieceAir: 0x565e69, pieceDead: 0x8b929c, trail: 0x496b8a,
        blood: 0xa9322b, stain: 0x77221f, wave: 0x8a6800, accent: 0xa9322b,
    },
};
export function snapshotFighters(world, target = new Map()) {
    for (const fighter of target.keys()) {
        if (fighter !== world.player && !world.enemies.includes(fighter))
            target.delete(fighter);
    }
    for (const fighter of [world.player, ...world.enemies]) {
        const copy = target.get(fighter);
        if (copy === undefined)
            target.set(fighter, { ...fighter, pose: { ...fighter.pose } });
        else {
            const pose = copy.pose;
            Object.assign(copy, fighter);
            copy.pose = pose;
            Object.assign(pose, fighter.pose);
        }
    }
    return target;
}
/** Continuous motion may interpolate; attacks, facing and impacts always use current semantics. */
export function interpolateFighter(current, previous, alpha) {
    if (previous === undefined || Math.hypot(current.x - previous.x, current.y - previous.y) > current.h * 2)
        return current;
    const t = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    const mix = (a, b) => a + (b - a) * t;
    let pose = current.pose;
    const ordinary = (f) => f.atk < 0 && f.hurt <= 0 && f.windup < 0 && f.land <= 0;
    if (ordinary(current) && ordinary(previous) && current.face === previous.face && current.onGround === previous.onGround) {
        pose = { ...pose };
        for (const key of Object.keys(pose))
            pose[key] = mix(previous.pose[key], pose[key]);
    }
    return { ...current, x: mix(previous.x, current.x), y: mix(previous.y, current.y), pose };
}
export function pixelCamera(width, height, world, playerX = world.player.x) {
    // The nominal 44-unit scene gets four units of headroom for the skeleton's head/weapon extents.
    // Height, never world width, controls detail. A narrow expanded view follows the player.
    const scale = height / (world.h + 4);
    const visible = width / scale;
    const center = visible >= world.w ? world.w / 2 : Math.max(visible / 2, Math.min(world.w - visible / 2, playerX));
    return { scale, x: x => (x - center) * scale + width / 2, y: y => (y + 4) * scale };
}
/** A quiet, native-resolution combat scene; rendering never changes simulation or collision. */
export function paintPixelWorld(c, world, context, previous, result = false, scene) {
    const palette = PIXEL_PALETTES[context.theme];
    const reduced = process.env.MOYU_REDUCE_MOTION === '1';
    const dim = world.phase === 'paused' || result ? 0.5 : 1;
    const flash = reduced ? 0 : Math.min(1, Math.max(0, world.flash * 6));
    const dx = reduced ? 0 : world.shakeX;
    const dy = reduced ? 0 : world.shakeY;
    const player = interpolateFighter(world.player, previous?.get(world.player), context.interpolation);
    const camera = pixelCamera(c.width, c.height, world, player.x);
    const { scale } = camera;
    const x = (value) => camera.x(value + dx);
    const y = (value) => camera.y(value + dy);
    const ink = (color) => tint(color, dim);
    // 每章往天空/地面掺一点色相；掺量克制，天空仍比描边亮、玩家仍是全场最亮（见 theme.ts）。
    const skyBase = scene === undefined ? palette.bg : mix(palette.bg, scene.skyTint, scene.skyMix);
    const floorBase = scene === undefined ? palette.floor : mix(palette.floor, scene.groundTint, scene.groundMix);
    const bg = ink(mix(skyBase, palette.wave, flash * 0.25));
    c.clear(bg);
    const pen = {
        line: (x0, y0, x1, y1, color) => c.stroke(x(x0), y(y0), x(x1), y(y1), Math.max(0.5, scale * 0.28), ink(color)),
        rect: (a, b, w, h, color) => c.rect(x(a), y(b), w * scale, h * scale, ink(color)),
        circle: (a, b, r, color) => c.circle(x(a), y(b), r * scale, ink(color)),
    };
    if (scene !== undefined) {
        if (scene.landmark)
            paintLandmark(pen, world.w, world.ground, scene);
        else
            paintPixelProps(c, world, scene, x, y, scale, ink, palette.key, skyBase);
    }
    const floorY = Math.floor(y(world.ground));
    c.rect(0, floorY, c.width, Math.max(1, Math.round(scale * 0.65)), ink(mix(floorBase, palette.wave, flash * 0.45)));
    const speck = (worldX, worldY, color) => {
        c.circle(x(worldX), y(worldY), Math.max(1, scale * 0.65), ink(color));
    };
    for (const key of world.stains)
        speck(key % 4096, Math.floor(key / 4096), palette.stain);
    for (const piece of world.pieces)
        if (piece.rest)
            drawPiece(c, world, piece, x, y, scale, ink(palette.key), ink(palette.pieceDead));
    for (const piece of world.pieces)
        if (!piece.rest)
            drawPiece(c, world, piece, x, y, scale, ink(palette.key), ink(piece.mine ? palette.hero : palette.pieceAir));
    // Boss 按阶段变色：重压深红 / 暴走偏橙提亮 / 困兽去饱和灰红。
    const bossColor = (hp, maxHp = 5) => {
        const phase = bossPhase(hp, maxHp);
        return phase === 1 ? mix(palette.accent, palette.key, 0.32)
            : phase === 2 ? mix(palette.accent, palette.wave, 0.30)
                : mix(mix(palette.accent, palette.key, 0.32), palette.foe, 0.4);
    };
    const drawBody = (body, hero, base) => {
        const raw = fighterSegments(body);
        // 主角追加斗笠（段标 armB，白捡四肢笔宽与描边）。
        const segs = hero ? [...raw, ...heroHat(raw.find(seg => seg.part === 'head') ?? raw[0], body.h)] : raw;
        const hit = world.hitstop > 0 && body.armed;
        const radius = (seg) => seg.part === 'head' ? seg.r * scale
            : Math.max(0.55, body.h * scale / (seg.part === 'torso' ? 15 : seg.part === 'blade' ? 26 : 22)
                * (seg.part === 'blade' && hit ? 1.9 : hero ? 1 : 0.6));
        if (body.h * scale / 22 >= 1.1) {
            for (const seg of segs)
                drawSegment(c, seg, x, y, radius(seg) + 1, ink(palette.key));
        }
        for (const seg of segs) {
            const color = seg.part === 'blade' ? ink(hit ? palette.hit : palette.blade) : ink(base);
            drawSegment(c, seg, x, y, radius(seg), color);
            if (hero && seg.part === 'torso') {
                c.stroke(x(seg.x1), y(seg.y1), x(seg.x1 - body.face * body.h * 0.26), y(seg.y1 + body.h * 0.1), Math.max(0.55, body.h * scale / 25), ink(palette.accent));
            }
        }
    };
    const draw = (fighter, hero) => {
        const body = interpolateFighter(fighter, previous?.get(fighter), context.interpolation);
        const blink = body.invuln > 0 && Math.floor(body.invuln * 18) % 2 === 0;
        // 变种本色：快刀手偏亮、重甲偏暗、boss 按阶段变色；其余走 foe。
        let foeBase = body.tag === 'boss' ? bossColor(body.hp, body.maxHp)
            : body.tag === 'brute' ? mix(palette.foe, palette.key, 0.4)
                : body.tag === 'runner' ? mix(palette.foe, palette.hero, 0.3)
                    : palette.foe;
        // 每章给杂兵掺一点章节色相（boss 保持阶段警示色，不掺）。
        if (scene !== undefined && body.tag !== 'boss')
            foeBase = mix(foeBase, scene.foeTint, scene.foeMix);
        const base = body.hurt > 0.16 ? palette.hit
            : body.windup >= 0
                ? mix(foeBase, palette.accent, 0.55 + 0.45 * Math.sin(body.windup * 40))
                : hero ? (blink ? palette.foe : palette.hero) : foeBase;
        // 冲撞中的 boss 在身后拖两层更暗的残影剪影——"看得见速度"。
        if (body.tag === 'boss' && body.dashT > 0) {
            for (const back of [0.45, 0.9])
                drawBody({ ...body, x: body.x - body.face * world.fh * back }, false, mix(base, palette.key, 0.55));
        }
        drawBody(body, hero, base);
        // Boss 头顶小尖冠：强化"这是头目"的剪影辨识。
        if (body.tag === 'boss') {
            const s = world.fh * 0.18;
            const topY = body.y - body.h * 0.74;
            const baseW = Math.max(2, Math.round(s * 2 * scale));
            const baseH = Math.max(1, Math.round(s * 0.6 * scale));
            c.rect(Math.round(x(body.x - s)), Math.round(y(topY)) - baseH, baseW, baseH, ink(base));
            for (const ox of [-s, 0, s])
                c.circle(x(body.x + ox), y(topY - s), Math.max(0.6, s * 0.42 * scale), ink(base));
        }
    };
    for (const enemy of world.enemies)
        draw(enemy, false);
    if (world.respawn <= 0)
        draw(world.player, true);
    else
        c.stroke(x(player.x - 4), y(world.ground - 1), x(player.x + 4), y(world.ground - 1), Math.max(0.6, scale), ink(palette.accent));
    for (const slash of world.slashes) {
        const life = Math.max(0, slash.life / slash.max);
        const wide = Math.max(0.7, world.fh * scale / 26 * (slash.big ? 2.2 : 1.5));
        const layers = context.view === 'micro'
            ? [[1, 1, life > 0.55 ? 0.85 : 0.7]]
            : [[1, 1, life > 0.55 ? 1 : 0.85], [0.82, 0.58, 0.45]];
        for (const [rf, wf, bright] of layers) {
            if (bright * life <= 0.12)
                continue;
            const a0 = slash.a0 + (slash.a1 - slash.a0) * (1 - rf * 0.9 + (1 - life) * 0.75);
            drawArc(c, x(slash.x), y(slash.y), slash.r * scale * rf, a0, slash.a1, wide * wf, ink(mix(palette.trail, palette.hit, bright * (life > 0.55 ? 1 : 0.6))));
        }
    }
    paintSwordArt(pen, world.swordCast, world.fh);
    paintBossPressure(pen, world);
    for (const blood of world.blood)
        speck(Math.round(blood.x), Math.round(blood.y), palette.blood);
    if (world.waveR !== null)
        for (const side of [-1, 1]) {
            const waveX = Math.round(world.player.x + side * world.waveR);
            c.rect(x(waveX) - 1, 0, 2, c.height, ink(palette.wave));
            c.rect(x(waveX + side) - 1, 0, 2, c.height, ink(palette.trail));
        }
}
/**
 * 每章的静态剪影布景，画在人身后、天空之上。混向描边 key（暗于人），退到背景里，
 * 不抢"最暗"名额也进不了主体的四邻。逐帧不变 → 像素档 deflate 几乎免费。
 */
function paintPixelProps(c, world, scene, x, y, scale, ink, key, skyBase) {
    const g = world.ground;
    for (const prop of scene.props) {
        const color = ink(mix(key, skyBase, 0.25 + prop.shade));
        const cx = x(prop.cx * world.w);
        const halfW = Math.max(1, prop.w * world.w * 0.5 * scale);
        const topY = y(g - prop.top * g);
        const floorY = y(g);
        c.rect(Math.round(cx - halfW), Math.round(topY), Math.round(halfW * 2), Math.max(1, Math.round(floorY - topY)), color);
        if (prop.dome)
            c.circle(cx, topY, halfW, color);
    }
}
function drawSegment(c, seg, x, y, radius, color) {
    if (seg.part === 'head')
        c.circle(x(seg.x0), y(seg.y0), radius, color);
    else
        c.stroke(x(seg.x0), y(seg.y0), x(seg.x1), y(seg.y1), radius, color);
}
function drawPiece(c, world, piece, x, y, scale, key, color) {
    const radius = piece.head ? piece.half * scale : Math.max(0.55, world.fh * scale / 22);
    const outlined = radius >= 1.1;
    if (piece.head) {
        if (outlined)
            c.circle(x(piece.x), y(piece.y), radius + 1, key);
        c.circle(x(piece.x), y(piece.y), radius, color);
        return;
    }
    const vx = Math.cos(piece.ang) * piece.half;
    const vy = Math.sin(piece.ang) * piece.half;
    if (outlined)
        c.stroke(x(piece.x - vx), y(piece.y - vy), x(piece.x + vx), y(piece.y + vy), radius + 1, key);
    c.stroke(x(piece.x - vx), y(piece.y - vy), x(piece.x + vx), y(piece.y + vy), radius, color);
}
function drawArc(c, cx, cy, radius, a0, a1, width, color) {
    const span = Math.abs(a1 - a0);
    const steps = Math.max(4, Math.ceil(span * radius / Math.max(1.5, width * 1.25)));
    let px = cx + Math.cos(a0) * radius;
    let py = cy + Math.sin(a0) * radius;
    for (let i = 1; i <= steps; i++) {
        const a = a0 + (a1 - a0) * i / steps;
        const nx = cx + Math.cos(a) * radius;
        const ny = cy + Math.sin(a) * radius;
        c.stroke(px, py, nx, ny, Math.max(0.55, width / 2), color);
        px = nx;
        py = ny;
    }
}
function tint(color, amount) {
    if (amount >= 1)
        return color;
    return ((Math.round(((color >>> 16) & 255) * amount) & 255) << 16)
        | ((Math.round(((color >>> 8) & 255) * amount) & 255) << 8)
        | (Math.round((color & 255) * amount) & 255);
}
function mix(a, b, amount) {
    if (amount <= 0)
        return a;
    if (amount >= 1)
        return b;
    const r = Math.round(((a >>> 16) & 255) * (1 - amount) + ((b >>> 16) & 255) * amount);
    const g = Math.round(((a >>> 8) & 255) * (1 - amount) + ((b >>> 8) & 255) * amount);
    const blue = Math.round((a & 255) * (1 - amount) + (b & 255) * amount);
    return (r << 16) | (g << 8) | blue;
}
