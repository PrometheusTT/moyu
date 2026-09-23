import { SWORD_ARTS, SWORD_FORMS, currentSwordForm, artDuration } from "../core/martial.js";
import { bossPhase, bossQuakeOffsets, bossArmored, bossAbilities, variantBossReach, duelistFormFor } from "../core/world.js";
import { fighterSegments } from "../core/creature.js";
export function paintLandmark(p, width, ground, scene) {
    if (!scene.landmark)
        return;
    // 按固定纵横比续接景物，不把同一座山门/竹林拉成整幅超宽背景。
    const tile = ground * 4.5;
    if (tile <= 0 || !Number.isFinite(width))
        return;
    for (let offset = 0; offset < width; offset += tile) {
        const pen = {
            line: (a, b, c, d, ink) => p.line(a + offset, b, c + offset, d, ink),
            rect: (a, b, w, h, ink) => p.rect(a + offset, b, w, h, ink),
            circle: (a, b, r, ink) => p.circle(a + offset, b, r, ink),
        };
        paintLandmarkTile(pen, tile, ground, scene);
    }
    p.circle(width * 0.72, ground * 0.2, ground * 0.1, scene.foeTint);
}
function paintLandmarkTile(p, width, ground, scene) {
    const far = scene.skyTint, near = scene.groundTint, light = scene.foeTint;
    const line = (a, b, c, d, color = near) => p.line(a * width, b * ground, c * width, d * ground, color);
    // 两层山脊构成连续景深，地标保持静态以保住终端帧差预算。
    for (let i = 0; i < 4; i++) {
        const a = i / 3 - 0.08, peak = a + 0.12;
        line(a, 0.76, peak, 0.32 + (i % 3) * 0.08, far);
        line(peak, 0.32 + (i % 3) * 0.08, a + 0.28, 0.76, far);
    }
    switch (scene.landmark) {
        case 'bamboo':
            for (const x of [0.08, 0.24, 0.88]) {
                line(x, 1, x + 0.015, 0.06);
                for (let i = 0; i < 3; i++) {
                    const y = 0.2 + i * 0.25;
                    line(x - 0.008, y, x + 0.018, y, far);
                    line(x + 0.008, y, x + (i % 2 ? -0.065 : 0.065), y - 0.12);
                    line(x + 0.008, y, x + (i % 2 ? -0.045 : 0.045), y + 0.04);
                }
            }
            break;
        case 'bridge':
            for (let i = 0; i < 16; i++) {
                const a = 0.14 + i * 0.045, b = a + 0.045;
                const y = (x) => 0.58 + (x - 0.5) ** 2 * 2;
                line(a, y(a), b, y(b));
                line(a, y(a) + 0.09, b, y(b) + 0.09);
                if (i % 2 === 0)
                    line(a, y(a), a, y(a) - 0.16, far);
            }
            for (const x of [0.18, 0.82]) {
                line(x, 0.7, x, 0.26);
                p.rect(width * (x - 0.018), ground * 0.27, width * 0.036, ground * 0.12, light);
            }
            break;
        case 'gate':
        case 'pagoda': {
            const tiers = scene.landmark === 'gate' ? 2 : 4;
            for (let i = 0; i < tiers; i++) {
                const y = 0.25 + i * 0.16, half = 0.09 + i * 0.035;
                line(0.5 - half, y + 0.06, 0.5, y - 0.09, far);
                line(0.5, y - 0.09, 0.5 + half, y + 0.06, far);
                line(0.5 - half - 0.025, y, 0.5 - half, y + 0.06);
                line(0.5 + half + 0.025, y, 0.5 + half, y + 0.06);
                line(0.5 - half, y + 0.06, 0.5 + half, y + 0.06);
                for (const sign of [-1, 1])
                    line(0.5 + sign * half * 0.65, y + 0.06, 0.5 + sign * half * 0.65, 0.94);
            }
            break;
        }
        case 'desert':
            for (let i = 0; i < 18; i++) {
                const a = i / 18, b = (i + 1) / 18;
                line(a, 0.72 + Math.sin(a * 7) * 0.12, b, 0.72 + Math.sin(b * 7) * 0.12);
            }
            line(0.2, 0.92, 0.23, 0.28);
            line(0.23, 0.32, 0.35, 0.42, light);
            line(0.35, 0.42, 0.225, 0.46, light);
            break;
        case 'snow':
            for (const a of [0.1, 0.42, 0.8]) {
                line(a - 0.15, 0.8, a, 0.09, far);
                line(a, 0.09, a + 0.17, 0.8, far);
                line(a - 0.04, 0.28, a, 0.09, light);
                line(a, 0.09, a + 0.045, 0.28, light);
            }
            break;
    }
    line(0, 0.98, 1, 0.98, far);
}
/** 实心收尖剑光，而非等宽线框；所有几何仍在世界坐标内。 */
export function paintSwordArt(p, cast, h) {
    if (!cast || cast.age < 0 || cast.age >= artDuration(cast.art, cast.full))
        return;
    const { x, y, face, art, level } = cast, form = currentSwordForm(cast);
    const t = cast.age / artDuration(art, cast.full);
    const power = form.qi >= 100 ? 2 : form.qi >= 60 ? 1 : 0;
    const reach = h * (form.reach + (level - 1) * 0.15);
    const color = SWORD_ARTS[art].color, white = 0xfff7df;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const fade = 1 - clamp((t - 0.62) / 0.38);
    const shade = (ink, brightness) => {
        const bg = 0x171c23;
        const mix = (shift) => Math.round(((bg >> shift) & 255) * (1 - brightness)
            + ((ink >> shift) & 255) * brightness);
        return (mix(16) << 16) | (mix(8) << 8) | mix(0);
    };
    const line = (a, b, ink) => p.line(x + face * a[0], y + a[1], x + face * b[0], y + b[1], ink);
    const fill = (points, ink) => {
        const lo = Math.min(...points.map(v => v[1])), hi = Math.max(...points.map(v => v[1]));
        const step = h / 80;
        for (let yy = lo + step / 2; yy < hi; yy += step) {
            const cuts = [];
            for (let i = 0; i < points.length; i++) {
                const a = points[i], b = points[(i + 1) % points.length];
                if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy))
                    cuts.push(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
            }
            cuts.sort((a, b) => a - b);
            for (let i = 0; i + 1 < cuts.length; i += 2)
                line([cuts[i], yy], [cuts[i + 1], yy], ink);
        }
    };
    const blade = (a, b, width, ink, core = white) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < h * 0.04 || width < h * 0.008)
            return;
        const nx = -dy / len, ny = dx / len;
        const shape = (w) => [a,
            [a[0] + dx * 0.35 + nx * w, a[1] + dy * 0.35 + ny * w], b,
            [a[0] + dx * 0.25 - nx * w * 0.45, a[1] + dy * 0.25 - ny * w * 0.45]];
        fill(shape(width * 1.7), shade(ink, 0.25 * fade));
        fill(shape(width), shade(ink, 0.8 * fade));
        line([a[0] + dx * 0.3, a[1] + dy * 0.3], b, shade(core, fade));
    };
    const crescent = (cx, rx, ry, start, span, thickness, ink) => {
        const outer = [], inner = [];
        for (let i = 0; i <= 24; i++) {
            const u = i / 24, a = start + span * u, taper = Math.sin(Math.PI * u);
            outer.push([cx + Math.cos(a) * rx, Math.sin(a) * ry]);
            inner.unshift([cx + Math.cos(a) * (rx - thickness * taper),
                Math.sin(a) * (ry - thickness * 0.45 * taper)]);
        }
        fill([...outer, ...inner], shade(ink, fade));
        for (let i = 9; i < 19; i++)
            line(outer[i], outer[i + 1], shade(white, fade * 0.8));
    };
    const index = cast.formIndex ?? (cast.full ? SWORD_FORMS[art].length - 1 : 0);
    // 弯曲的带状笔触，和实体飞剑、月牙轮廓分别建模；不能再共用一个大三角。
    const ribbon = (points, width, ink) => {
        const left = [], right = [];
        for (let i = 0; i < points.length; i++) {
            const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)], c = points[i];
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            const w = width * Math.pow(Math.sin(Math.PI * i / (points.length - 1)), 0.7);
            const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
            left.push([c[0] + nx * w, c[1] + ny * w]);
            right.unshift([c[0] - nx * w * 0.45, c[1] - ny * w * 0.45]);
        }
        fill([...left, ...right], shade(ink, fade));
        for (let i = 6; i < points.length - 3; i++)
            line(points[i], points[i + 1], shade(ink === 0x526875 ? 0x819398 : white, fade * 0.7));
    };
    const curve = (fn, width, ink) => ribbon(Array.from({ length: 33 }, (_, i) => fn(i / 32)), width, ink);
    const seal = (cx, cy, r, ink) => {
        const pts = Array.from({ length: 13 }, (_, i) => [cx + Math.cos(i * Math.PI / 6) * r, cy + Math.sin(i * Math.PI / 6) * r]);
        fill(pts, shade(ink, fade));
    };
    // 剑身带护手；指劲则使用连续光波。两者不能只是换色的三角形。
    const sword = (cx, cy, angle, length) => {
        const dx = Math.cos(angle), dy = Math.sin(angle);
        blade([cx - dx * length, cy - dy * length], [cx, cy], h * 0.045, color);
        const gx = cx - dx * length * 0.8, gy = cy - dy * length * 0.8;
        line([gx - dy * h * 0.09, gy + dx * h * 0.09], [gx + dy * h * 0.09, gy - dx * h * 0.09], shade(color, fade));
    };
    const motif = () => {
        switch (form.shape) {
            case 'thrust': {
                const tip = reach * (0.2 + clamp(t * 3) * 0.8);
                if (index === 1) {
                    // 破剑：贴身斜截，再反向挑开；两道干净剑痕，不挂一柄巨型短剑。
                    const turn = clamp(t * 2.5);
                    curve(u => [h * 0.2 + u * tip * 0.8, h * (-0.42 + u * 0.7 - Math.sin(u * Math.PI) * 0.12)], h * 0.035, color);
                    curve(u => [h * 0.3 + u * tip, h * (0.34 - u * 0.58) * turn], h * 0.055, 0xffebbc);
                    const cx = tip * 0.48;
                    for (const s of [-1, 1])
                        line([cx, 0], [cx + s * h * 0.12, -h * 0.17], shade(color, fade * 0.75));
                }
                else {
                    // 破枪：沿枪杆一线穿入，末端挑开，尾迹是窄线而非长菱形。
                    const tail = h * 0.18 + reach * clamp((t - 0.45) * 1.2);
                    curve(u => [tail + (tip - tail) * u, h * (0.04 - u * 0.09)], h * 0.023, 0xffebbc);
                    line([tip * 0.12, h * 0.1], [tip * 0.65, h * 0.07], shade(color, fade * 0.5));
                    line([tip * 0.35, -h * 0.1], [tip * 0.86, -h * 0.1], shade(color, fade * 0.45));
                    // 一点星芒示意破入，避免尖端弯钩/鱼形轮廓。
                    line([tip - h * 0.09, -h * 0.05], [tip + h * 0.09, -h * 0.05], shade(white, fade));
                    line([tip, -h * 0.14], [tip, h * 0.04], shade(color, fade));
                }
                break;
            }
            case 'fan': {
                const closing = index % 2 === 1;
                for (let i = -1; i <= 1; i++) {
                    const tip = reach * (0.25 + t * 0.7), spread = h * (closing ? 0.65 - t * 0.4 : 0.1 + t * 0.6);
                    const cy = i * spread;
                    sword(tip - Math.abs(i) * h * 0.25, cy, i * (closing ? -0.12 : 0.2), h * 0.7);
                    line([tip * 0.25, i * h * 0.05], [tip - h * 0.75, cy], shade(color, fade * 0.4));
                }
                break;
            }
            case 'sweep':
                crescent(form.radial ? 0 : reach * 0.35, reach * (form.radial ? 1 : 0.65), h * 0.35, -Math.PI + t * Math.PI * (index % 2 ? -1 : 1), Math.PI * 1.25, h * 0.14, color);
                break;
            case 'ring':
                for (let side = 0; side < 2; side++) {
                    const a = t * Math.PI * (index % 2 ? -2 : 2) + side * Math.PI;
                    const r = reach * (0.85 - t * 0.25);
                    crescent(0, r, h * 0.5, a, Math.PI * 0.65, h * 0.07, side ? shade(color, 0.6) : color);
                    sword(Math.cos(a) * r, Math.sin(a) * h * 0.5, a + Math.PI / 2, h * 0.6);
                }
                break;
            case 'rain':
                for (let i = 0; i < 5; i++) {
                    const u = clamp((t - (i % 3) * 0.06) * 1.7), cx = (form.radial ? i / 4 * 1.8 - 0.9 : i / 4) * reach;
                    const tip = -h * 0.65 + u * h * 1.15;
                    sword(cx, tip, Math.PI / 2, h * 0.56);
                    line([cx - h * 0.16, h * 0.5], [cx + h * 0.16, h * 0.5], shade(color, fade * (u > 0.8 ? 0.8 : 0.25)));
                }
                break;
            case 'crescent':
                crescent(reach * (0.15 + t * 0.7), h * 0.48, h * 0.66, -1.5, 3, h * 0.18, color);
                break;
        }
    };
    // 独孤收势归于一线；其他门派保持自己的笔触，不再全部套同一记白色突刺。
    if (art === 'dugu' && cast.full && t > 0.72) {
        blade([h * 0.15, h * 0.06], [reach, 0], h * 0.1 * Math.sin(Math.PI * (t - 0.72) / 0.28), color);
        return;
    }
    if (art === 'dugu') {
        motif();
    }
    else if (art === 'liumai') {
        if (index === 0 || index === 2) {
            // 少商是直贯光波，中冲以窄芯穿透；光波连接手指，不是飞剑。
            const tip = reach * clamp(t * 4), width = h * (index === 0 ? 0.09 : 0.045) * Math.sin(Math.PI * t);
            fill([[h * 0.2, -width], [tip, -width * 0.5], [tip + h * 0.14, 0], [tip, width * 0.5], [h * 0.2, width]], shade(color, fade));
            line([h * 0.2, 0], [tip, 0], shade(0xe6ffff, fade));
            if (index === 2)
                for (const s of [-1, 1])
                    line([tip * 0.35, s * h * 0.13], [tip, s * h * 0.04], shade(color, fade * 0.5));
        }
        else if (index === 1) {
            // 商阳点射：两个短促脉冲前后追逐。
            for (let i = 0; i < 2; i++) {
                const u = clamp((t - i * 0.15) * 1.4), tip = reach * (0.15 + u * 0.8);
                blade([tip - h * 0.5, -i * h * 0.07], [tip, -i * h * 0.07], h * 0.035, color, 0xe6ffff);
            }
        }
        else if (index === 3) {
            for (let i = -1; i <= 1; i++) {
                const tip = reach * (0.2 + t * 0.75);
                blade([h * 0.2, 0], [tip, i * h * (0.15 + t * 0.55)], h * 0.04, color, 0xe6ffff);
            }
        }
        else if (index === 4) {
            // 少冲：指劲绕行，只有脉冲节点，没有飞剑护手。
            for (let i = 0; i < 4; i++) {
                const a = t * 5 + i * Math.PI / 2, cx = Math.cos(a) * reach * 0.8, cy = Math.sin(a) * h * 0.42;
                curve(u => [Math.cos(a - u * 0.65) * reach * 0.8, Math.sin(a - u * 0.65) * h * 0.42], h * 0.018, color);
                seal(cx, cy, h * 0.035, 0xc9ffff);
            }
        }
        else {
            // 少泽：细长光剑依次落下，保留落阵辨识，区别于万剑的实体剑身。
            for (let i = 0; i < 5; i++) {
                const u = clamp((t - (i % 3) * 0.075) * 1.8), cx = (i / 4 * 1.8 - 0.9) * reach;
                const tip = -h * 0.6 + u * h * 1.1;
                blade([cx, tip - h * 0.65], [cx, tip], h * 0.026, color, 0xdfffff);
                if (u > 0.65)
                    curve(v => [cx + (v - 0.5) * h * 0.65, h * (0.46 - Math.sin(v * Math.PI) * 0.07)], h * 0.016, color);
            }
        }
    }
    else if (art === 'taiji') {
        const yin = 0x526875, yang = 0xe3e8d9, motion = t * Math.PI;
        // 九式分别是引流、展翼、托月、回雪、游龙、合璧、云瀑、两仪、归元。
        // 水墨柔带贯穿整套，但不复用飞剑/扇射/剑雨模板。
        switch (index) {
            case 0:
                curve(u => [(u - 0.5) * reach * 1.7, h * (0.2 + Math.sin(u * Math.PI * 2 + motion) * 0.18)], h * 0.085, yin);
                curve(u => [(u - 0.5) * reach * 1.5, h * (-0.06 + Math.sin(u * Math.PI * 2 + motion) * 0.16)], h * 0.035, yang);
                break;
            case 1:
                for (const s of [-1, 1])
                    curve(u => [reach * u * 0.95, s * h * (Math.sin(u * Math.PI * 0.8) * (0.45 + t * 0.18))], h * 0.07, s > 0 ? yin : yang);
                break;
            case 2:
                curve(u => [(u - 0.5) * reach * 1.8, h * (0.38 - Math.pow(u * 2 - 1, 2) * 0.64)], h * 0.09, yang);
                seal(reach * (t - 0.5), -h * 0.12, h * 0.11, yin);
                break;
            case 3:
                for (const s of [-1, 1])
                    curve(u => [s * reach * 0.42 + Math.cos(u * Math.PI * 2 + s * motion) * reach * 0.38 * (1 - u * 0.8),
                        Math.sin(u * Math.PI * 2 + s * motion) * h * 0.42 * (1 - u * 0.65)], h * 0.065, s > 0 ? yang : yin);
                break;
            case 4:
                curve(u => [u * reach, h * Math.sin(u * Math.PI * 2 - motion) * (0.32 - u * 0.18)], h * 0.095, yang);
                curve(u => [u * reach * 0.9, h * (Math.sin(u * Math.PI * 2 - motion) * 0.26 + 0.12)], h * 0.045, yin);
                break;
            case 5:
                for (const s of [-1, 1])
                    curve(u => [s * reach * (0.85 - clamp(t * 1.1) * 0.5) * Math.sin(u * Math.PI),
                        h * (u - 0.5) * 1.1], h * 0.11, s > 0 ? yang : yin);
                break;
            case 6:
                for (let i = 0; i < 3; i++)
                    curve(u => [(i - 1) * reach * 0.65 + Math.sin(u * Math.PI * 1.4 + motion) * reach * 0.18,
                        h * (-0.8 + u * 1.25)], h * 0.07, i === 1 ? yang : yin);
                break;
            case 7:
                curve(u => [Math.sin(u * Math.PI * 2 + motion) * reach * 0.85,
                    Math.sin(u * Math.PI * 4 + motion * 2) * h * 0.38], h * 0.075, yang);
                curve(u => [Math.sin(u * Math.PI * 2 - motion) * reach * 0.6,
                    Math.sin(u * Math.PI * 4 - motion * 2) * h * 0.25], h * 0.05, yin);
                break;
            default: {
                const r = h * (0.68 - t * 0.28), cx = reach * (0.15 + t * 0.3);
                for (const s of [-1, 1]) {
                    curve(u => [cx + Math.cos(u * Math.PI + motion + (s < 0 ? Math.PI : 0)) * r,
                        Math.sin(u * Math.PI + motion + (s < 0 ? Math.PI : 0)) * r], h * 0.1, s > 0 ? yang : yin);
                    seal(cx + s * Math.cos(motion) * r * 0.4, s * Math.sin(motion) * r * 0.4, h * 0.07, s > 0 ? yin : yang);
                }
                curve(u => [(u - 0.5) * reach * 1.7, h * (0.48 - Math.sin(u * Math.PI) * 0.1)], h * 0.025, yin);
            }
        }
    }
    else if (art === 'feixian') {
        // 飞仙是轻薄羽锋与凌空斜落，绝不画成万剑的横向整排实体剑。
        const falling = [4, 6, 8].includes(index), reverse = index === 2 || index === 5;
        const tip = reach * (0.4 + clamp(t * 2.2) * 0.6);
        const path = (u) => [reverse ? Math.sin(u * Math.PI) * tip : u * tip,
            h * (index === 1 ? -0.18 + Math.sin(u * Math.PI) * 0.16
                : index === 3 ? 0.36 - u * 1.12
                    : index === 5 ? -0.65 + u * 0.9
                        : falling ? -0.85 + u * 1.2 : 0.28 - Math.sin(u * Math.PI * 0.7) * 1.05)];
        curve(path, h * (index === 8 ? 0.065 : 0.04), 0xe4f4ff);
        const feathers = 3 + index % 3;
        for (let i = 0; i < feathers; i++) {
            const u = 0.2 + i * 0.13, a = path(u), b = path(Math.min(1, u + 0.2));
            curve(v => [a[0] + (b[0] - a[0]) * v - Math.sin(v * Math.PI) * h * 0.25,
                a[1] + (b[1] - a[1]) * v - Math.sin(v * Math.PI) * h * (0.18 + (index % 3) * 0.06)], h * 0.025, 0x8faec9);
        }
        if (index === 7)
            curve(u => [reach * (0.2 + u * 0.7), -h * 0.65 + Math.sin(u * Math.PI) * h * 0.5], h * 0.025, white);
    }
    else if (art === 'wanjian') {
        // 万剑独占有护手的实体剑阵：列阵、护身、三才、汇流、回鞘、落阵、星斗、穿云、朝宗。
        const count = index === 2 ? 3 : 5;
        for (let i = 0; i < count; i++) {
            const lane = i / (count - 1) - 0.5, a = i * Math.PI * 2 / count + t * 2;
            let cx, cy, angle;
            if (index === 0 || index === 6) {
                cx = lane * reach * 1.6;
                cy = -h * (0.12 + Math.cos(lane * Math.PI) * (index === 6 ? 0.55 : 0.3));
                angle = -Math.PI / 2;
            }
            else if (index === 1 || index === 4) {
                cx = Math.cos(a) * reach * (index === 4 ? 0.9 - t * 0.55 : 0.72);
                cy = Math.sin(a) * h * 0.4;
                angle = a + Math.PI / 2;
            }
            else if (index === 5 || index === 8) {
                const fall = clamp((t - (i % 3) * 0.08) * 1.8);
                cx = lane * reach * 1.6;
                cy = -h * 0.55 + fall * h;
                angle = Math.PI / 2;
                if (index === 8)
                    cx *= 1 - t * 0.35;
            }
            else {
                cx = reach * (0.15 + t * 0.75) - Math.abs(lane) * h;
                cy = lane * h * (index === 3 ? 1.2 - t : index === 7 ? 0.45 : 1.1);
                angle = index === 3 ? -lane * 0.4 : lane * 0.15;
            }
            sword(cx, cy, angle, h * (index === 7 ? 0.85 : 0.62));
            if (index === 0 || index === 6)
                seal(cx, h * 0.48, h * 0.025, color);
        }
    }
    else if (art === 'getsuga') {
        // 月牙只有厚重月刃与深蓝内核；横月、回月、裂空、双弦、落月改变切面。
        const cx = index === 2 ? reach * (0.8 - t * 0.65) : reach * (0.1 + t * 0.75);
        const horizontal = [1, 4, 8].includes(index), falling = index === 7;
        const rx = h * (horizontal ? 1.1 : 0.4 + power * 0.06), ry = h * (horizontal ? 0.25 : 0.55 + power * 0.04);
        const start = index === 8 ? -Math.PI + t * 1.4 : index === 6 ? -2.2 + t * 0.7
            : horizontal ? -Math.PI : falling ? -2.5 : -1.5, span = horizontal ? Math.PI : 3;
        crescent(cx, rx, ry, start, span, h * 0.22, 0x74a4ff);
        crescent(cx - h * 0.055, rx * 0.9, ry * 0.9, start, span, h * 0.14, 0x25395e);
        if (index === 5)
            crescent(cx - h * 0.55, rx * 0.7, ry * 0.7, -1.8, 3, h * 0.16, color);
        if (index === 3 || index === 6)
            for (const s of [-1, 1])
                curve(u => [cx - h * (0.8 - u * 0.6), s * h * (0.1 + u * 0.28)], h * 0.045, 0x4963a2);
    }
    else {
        // 日轮：橙红火舌、金色火芯、离散余烬，不借用月牙或普通剑阵。
        const path = (u) => {
            if (index === 5)
                return [u * reach, Math.sin(u * Math.PI * 2 - t * 4) * h * 0.1];
            if (index === 7)
                return [u * reach, h * (-0.65 + u * 1.05)];
            if (index === 1)
                return [reach * (0.2 + u * 0.65), h * (0.36 - Math.sin(u * Math.PI * 0.8) * 1.05)];
            if (index === 6)
                return [reach * (0.3 + Math.cos(u * Math.PI * 1.8 + t) * 0.4), h * Math.sin(u * Math.PI * 1.8 + t) * 0.6];
            const a = -Math.PI + u * Math.PI * (index === 4 ? 1.1 : 1.7) + t * (index === 3 ? -3 : 2);
            return [Math.cos(a) * reach * (index === 2 ? 0.6 : 0.8), Math.sin(a) * h * (0.38 + index * 0.014)];
        };
        curve(path, h * 0.11, 0xe85536);
        curve(path, h * 0.038, 0xffcb75);
        for (let i = 0; i < 6; i++) {
            const a = path((i + 1) / 8), b = path((i + 1.65) / 8);
            curve(u => [a[0] + (b[0] - a[0]) * u - Math.sin(u * Math.PI) * h * 0.16,
                a[1] + (b[1] - a[1]) * u - Math.sin(u * Math.PI) * h * (0.15 + (i % 2) * 0.08)], h * 0.035, i % 2 ? 0xffb35d : 0xf16c3e);
            if (i % 2 === 0)
                seal(a[0] - h * t * 0.2, a[1] - h * (0.18 + t * 0.12), h * 0.022, 0xffd281);
        }
    }
}
/** 红线预告落点，白红地刺爆发；生命刻度与受击裂光三档共用。 */
export function paintBossPressure(p, w, armorOutline = true) {
    const h = w.fh;
    // 各终端渲染档共用金色轮廓，不依赖文字能否放进两行 HUD。
    for (const f of armorOutline ? [w.player, ...w.enemies] : []) {
        if (f === w.player ? w.respawn > 0 || (f.armorT ?? 0) <= 0 : !bossArmored(f))
            continue;
        for (const s of fighterSegments(f)) {
            if (s.part === 'head')
                p.circle(s.x0, s.y0, s.r, 0xffd66b);
            else
                p.line(s.x0, s.y0, s.x1, s.y1, 0xffd66b);
        }
    }
    for (const e of w.enemies)
        if (e.tag === 'boss' || e.duelist) {
            if (e.enemyCast)
                paintSwordArt({ ...p, line: (x0, y0, x1, y1, ink) => {
                        const light = Math.max((ink >> 16) & 255, (ink >> 8) & 255, ink & 255) / 255;
                        const tint = light > 0.93 ? 0xffd4c6 : (Math.round(240 * light) << 16) | (Math.round(128 * light) << 8) | Math.round(121 * light);
                        p.line(x0, y0, x1, y1, tint);
                    } }, e.enemyCast, h);
            if ((e.guard ?? 0) > 0) {
                const cx = e.x + e.face * h * 0.4;
                p.line(cx, e.y - h * 0.9, cx + e.face * h * 0.12, e.y - h * 0.35, 0x8fd7de);
            }
            const cells = Math.min(10, e.maxHp ?? 5), filled = Math.ceil(e.hp / (e.maxHp ?? 5) * cells), unit = h * 1.5 / cells;
            for (let i = 0; i < cells; i++)
                p.line(e.x - h * 0.7 + i * unit, e.y - e.h * 1.14, e.x - h * 0.7 + (i + 0.7) * unit, e.y - e.h * 1.14, i < filled ? 0xff785c : 0x453b45);
            if (e.hurt > 0.16)
                for (let i = 0; i < 6; i++) {
                    const a = i / 6 * Math.PI * 2, r = h * (0.55 + (0.3 - e.hurt) * 3);
                    p.line(e.x + Math.cos(a) * r, e.y - h * 0.5 + Math.sin(a) * r * 0.6, e.x + Math.cos(a) * (r + h * 0.3), e.y - h * 0.5 + Math.sin(a) * (r + h * 0.3) * 0.6, 0xfff0c7);
                }
            if (e.windup >= 0 || (e.followupT ?? 0) > 0) {
                if (e.duelist) {
                    const next = duelistFormFor(e), form = SWORD_FORMS[next.art][next.formIndex], reach = form.reach * h;
                    const start = e.x - (form.radial ? reach : 0), end = e.x + (form.radial ? reach : e.face * reach);
                    p.line(start, w.ground - 0.6, end, w.ground - 0.6, 0xff674b);
                    if (form.shape === 'rain')
                        for (let i = 0; i < 5; i++) {
                            const cx = e.x + (i / 4 * 1.8 - 0.9) * reach;
                            p.line(cx, w.ground - h * 0.12, cx, w.ground - 0.6, 0xffc38b);
                        }
                    else
                        p.line(e.x, e.y - h * 0.55, e.x + e.face * h * 0.8, e.y - h * 0.55, 0xffc38b);
                }
                else if (e.quakeX !== undefined)
                    for (const offset of bossQuakeOffsets(e)) {
                        const cx = Math.max(0, Math.min(w.w, e.quakeX + offset * h * 1.5));
                        p.line(cx - h * 0.48, w.ground - 0.6, cx + h * 0.48, w.ground - 0.6, e.bossKind === 'crystal' ? 0x8cddff : 0xff674b);
                    }
                else if (e.bossKind === 'mantis' || e.bossKind === 'scarab') {
                    const reach = variantBossReach(e), color = bossArmored(e) ? 0xffd66b : 0xff674b;
                    const start = e.bossKind === 'scarab' ? e.x - e.face * reach : e.x - e.face * h * 0.12;
                    const end = e.x + e.face * (e.bossKind === 'scarab' ? e.speed * 6.5 * bossAbilities(e).chargeTime + reach : reach);
                    p.line(Math.max(0, Math.min(w.w, start)), w.ground - 0.6, Math.max(0, Math.min(w.w, end)), w.ground - 0.6, color);
                    if (e.bossKind === 'mantis' && bossAbilities(e).doubleStrike) {
                        const x = e.x + e.face * reach * 0.55;
                        for (const side of [-1, 1])
                            p.line(x - h * 0.15, e.y - h * (0.5 + side * 0.15), x + h * 0.15, e.y - h * (0.5 - side * 0.15), color);
                    }
                }
                else {
                    const reach = bossPhase(e.hp, e.maxHp) > 1 ? 3 : 1.4;
                    p.line(e.x, w.ground - 0.6, e.x + e.face * h * reach, w.ground - 0.6, 0xff674b);
                }
            }
        }
    for (const hazard of w.hazards) {
        const { x, radius, timer } = hazard;
        p.line(x - radius, w.ground - 0.6, x + radius, w.ground - 0.6, hazard.frost ? 0x8cddff : timer > 0 ? 0xff674b : 0xffd399);
        if (timer <= 0)
            for (const s of [-1, 0, 1]) {
                const cx = x + s * radius * 0.6, top = w.ground - h * (s === 0 ? 1.3 : 0.8);
                p.line(cx - radius * 0.28, w.ground, cx, top, hazard.frost ? 0x70bce8 : 0xff785c);
                p.line(cx, top, cx + radius * 0.28, w.ground, hazard.frost ? 0xd5f5ff : 0xffe3b0);
            }
    }
}
