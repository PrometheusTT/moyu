import { SWORD_ARTS, currentSwordForm, artDuration } from "../core/martial.js";
import { bossPhase, bossQuakeOffsets } from "../core/world.js";
export function paintLandmark(p, width, ground, scene) {
    if (!scene.landmark)
        return;
    const far = scene.skyTint, near = scene.groundTint, light = scene.foeTint;
    const line = (a, b, c, d, color = near) => p.line(a * width, b * ground, c * width, d * ground, color);
    // 两层山脊构成连续景深，地标保持静态以保住终端帧差预算。
    for (let i = 0; i < 6; i++) {
        const a = i / 5 - 0.08, peak = a + 0.12;
        line(a, 0.76, peak, 0.32 + (i % 3) * 0.08, far);
        line(peak, 0.32 + (i % 3) * 0.08, a + 0.28, 0.76, far);
    }
    p.circle(width * 0.72, ground * 0.2, ground * 0.1, light);
    switch (scene.landmark) {
        case 'bamboo':
            for (const x of [0.06, 0.14, 0.24, 0.85, 0.94]) {
                line(x, 1, x + 0.015, 0.06);
                for (let i = 0; i < 4; i++) {
                    const y = 0.2 + i * 0.18;
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
export function paintSwordArt(p, cast, h) {
    if (!cast)
        return;
    const { x, y, face, art, level } = cast;
    const form = currentSwordForm(cast);
    const t = Math.min(1, cast.age / artDuration(art, cast.full));
    const power = cast.full ? 2 : form.qi >= 60 ? 1 : 0;
    const reach = h * (form.reach + (level - 1) * 0.15);
    const color = SWORD_ARTS[art].color;
    // 每套剑法只有一种构图语言；奥义增强同一构图，不轮播不相关图形。
    // 垂直幅度受身高约束，防止宽战场上的圆阵长成遮满屏幕的车轮。
    const line = (a, b, c, d, ink = color) => p.line(x + face * a, y + b, x + face * c, y + d, ink);
    const arc = (cx, rx, ry, start, span, ink = color) => {
        for (let i = 0; i < 24; i++) {
            const a = start + span * i / 24, b = start + span * (i + 1) / 24;
            line(cx + Math.cos(a) * rx, Math.sin(a) * ry, cx + Math.cos(b) * rx, Math.sin(b) * ry, ink);
        }
    };
    const grow = Math.min(1, t * 5), fade = Math.max(0, (t - 0.7) / 0.3);
    // 出鞘闪光：所有剑招共用的一记起手亮环，先读到"技能出手了"，再读是哪一种。
    if (t < 0.2) {
        const r = h * (0.22 + t * 1.9);
        arc(0, r, r * 0.8, 0, Math.PI * 2, 0xfff6dd);
    }
    // 奥义落地气浪：沿地面向两侧推开一圈，给统一收招补上重量感。
    if (cast.full) {
        const wave = reach * 1.35 * Math.min(1, t * 1.4);
        const feet = h * 0.5;
        for (const s of [-1, 1]) {
            p.line(x + s * wave * 0.45, y + feet, x + s * wave, y + feet, color);
            p.line(x + s * wave * 0.8, y + feet, x + s * wave * 1.08, y + feet, 0xfff0c7);
        }
        // 四连节拍：每个伤害脉冲的起点亮一记白环，把"奥义连打四段"的鼓点敲出来。
        const beat = (cast.age % 0.3) / 0.3;
        if (beat < 0.25) {
            const r = reach * (0.35 + beat * 2.2);
            arc(0, r, r * 0.7, 0, Math.PI * 2, 0xfff6dd);
        }
    }
    if (art === 'dugu') {
        // 金色剑痕从不同角度聚向同一破绽，九剑归一收束成一线。
        const count = [2, 4, 9][power];
        const tip = reach * grow;
        for (let i = 0; i < count; i++) {
            const offset = (i / (count - 1) - 0.5) * h * (1 - t) * 0.85;
            line(tip * (0.12 + fade * 0.72), offset, tip, 0);
        }
        line(tip * 0.7, 0, tip, 0, 0xfff0c7);
        // 奥义：剑尖聚合处炸开一圈放射星芒 —— "万剑归一点"的定格。
        if (power === 2)
            for (let i = 0; i < 8; i++) {
                const a = i / 8 * Math.PI * 2;
                line(tip + Math.cos(a) * h * 0.1, Math.sin(a) * h * 0.1, tip + Math.cos(a) * h * 0.34, Math.sin(a) * h * 0.34, 0xfff0c7);
            }
    }
    else if (art === 'liumai') {
        // 六脉是平行、纤细的青色指劲，不画实体剑或剑雨。
        const count = [1, 3, 6][power];
        for (let i = 0; i < count; i++) {
            const offset = (i - (count - 1) / 2) * h * 0.13;
            const end = reach * Math.min(1, grow * (1 - i * 0.025));
            line(h * 0.2 + fade * end * 0.75, offset, end, offset);
            line(end - h * 0.2, offset, end, offset, 0xd7ffff);
            // 奥义：每道指劲的落点炸一朵十字星花。
            if (power === 2) {
                line(end - h * 0.13, offset - h * 0.13, end + h * 0.13, offset + h * 0.13, 0xd7ffff);
                line(end - h * 0.13, offset + h * 0.13, end + h * 0.13, offset - h * 0.13, 0xd7ffff);
            }
        }
    }
    else if (art === 'taiji') {
        // 阴阳两条相抱的低扁弧，缓旋后合拢，没有放射状剑刺。
        const r = reach * (0.6 + grow * 0.4) * (1 - fade * 0.2);
        for (let side = 0; side < 2; side++) {
            const a = side * Math.PI + t * Math.PI * 0.8;
            arc(0, r, h * (0.32 + power * 0.1), a, Math.PI * 0.85, side ? 0xe9e6ff : color);
            if (power > 0)
                arc(0, r * 0.78, h * 0.25, a + 0.15, Math.PI * 0.65);
        }
        // 奥义：外围再加一圈四段旋转罡气，太极图外有剑阵。
        if (power === 2)
            for (let k = 0; k < 4; k++) {
                const a = k * Math.PI / 2 + t * Math.PI * 1.6;
                arc(0, r * 1.35, h * 0.52, a, Math.PI * 0.3, k % 2 ? 0xe9e6ff : color);
            }
    }
    else if (art === 'feixian') {
        // 飞仙只留一条斜贯长空的剑光和细尾迹。
        const end = reach * grow, start = end * fade * 0.8;
        line(start, -h * 0.8 + start / reach * h, end, -h * 0.8 + end / reach * h, 0xf3fcff);
        for (let i = 1; i <= power + 1; i++)
            line(start + h * 0.15, -h * 0.8 + start / reach * h - i * h * 0.045, end * 0.8, -h * 0.8 + end / reach * h * 0.8 - i * h * 0.045);
        // 奥义：主剑光身后拖两道平行的残影，像同一剑被时光重放了两次。
        if (power === 2)
            for (let k = 1; k <= 2; k++) {
                const d = k * h * 0.32;
                line(start - d, -h * 0.8 + (start - d) / reach * h, end - d, -h * 0.8 + (end - d) / reach * h);
            }
    }
    else if (art === 'wanjian') {
        // 剑雨分列落下，短剑体、低高度，明确区别于飞仙的单道斜斩。
        const count = [5, 9, 13][power];
        for (let i = 0; i < count; i++) {
            const cx = (i / (count - 1) - 0.5) * reach * 2;
            const fall = Math.max(0, Math.min(1, (t - (i % 3) * 0.07) * 1.7));
            const cy = h * (-0.8 + fall * 1.05);
            line(cx, cy - h * 0.3, cx, cy);
            line(cx - h * 0.07, cy - h * 0.24, cx + h * 0.07, cy - h * 0.24);
            // 奥义：剑落到底时钉出一横接地刻痕，剑阵是真的"扎"进了地里。
            if (power === 2 && fall > 0.92)
                line(cx - h * 0.14, cy, cx + h * 0.14, cy, 0xfff0c7);
        }
    }
    else if (art === 'getsuga') {
        const cx = reach * (0.1 + t * 0.75), rx = h * (0.25 + power * 0.07);
        for (let i = 0; i <= power + 1; i++)
            arc(cx - i * h * 0.075, rx, h * (0.5 + power * 0.1), -1.3, 2.6, i ? color : 0xd7edff);
        // 奥义：最外层再推一圈更大的回声月牙，冲击波有"厚度"。
        if (power === 2)
            arc(cx * 1.3, rx * 1.55, h * 0.78, -1.05, 2.1, 0xd7edff);
    }
    else {
        // 火焰是有缺口的横扫弧与短余烬，不是完整的发光车轮。
        const start = -Math.PI + t * Math.PI * 1.5, span = Math.PI * (0.75 + power * 0.15);
        arc(0, reach * grow, h * 0.5, start, span);
        arc(0, reach * grow * 0.88, h * 0.38, start + 0.1, span * 0.85, 0xffd389);
        // 奥义：最外层一道白热火舌，火轮有了"刃口"。
        if (power === 2)
            arc(0, reach * grow * 1.14, h * 0.62, start - 0.06, span * 1.04, 0xffe9c8);
        for (let i = 0; i < 3 + power * 2; i++) {
            const a = start + span * i / (3 + power * 2);
            const cx = Math.cos(a) * reach * grow, cy = Math.sin(a) * h * 0.5;
            line(cx, cy, cx - h * 0.12, cy - h * (0.1 + (i % 2) * 0.08), 0xff623d);
        }
    }
}
/** 红线预告落点，白红地刺爆发；生命刻度与受击裂光三档共用。 */
export function paintBossPressure(p, w) {
    const h = w.fh;
    for (const e of w.enemies)
        if (e.tag === 'boss') {
            const cells = Math.min(10, e.maxHp ?? 5), filled = Math.ceil(e.hp / (e.maxHp ?? 5) * cells), unit = h * 1.5 / cells;
            for (let i = 0; i < cells; i++)
                p.line(e.x - h * 0.7 + i * unit, e.y - e.h * 1.14, e.x - h * 0.7 + (i + 0.7) * unit, e.y - e.h * 1.14, i < filled ? 0xff785c : 0x453b45);
            if (e.hurt > 0.16)
                for (let i = 0; i < 6; i++) {
                    const a = i / 6 * Math.PI * 2, r = h * (0.55 + (0.3 - e.hurt) * 3);
                    p.line(e.x + Math.cos(a) * r, e.y - h * 0.5 + Math.sin(a) * r * 0.6, e.x + Math.cos(a) * (r + h * 0.3), e.y - h * 0.5 + Math.sin(a) * (r + h * 0.3) * 0.6, 0xfff0c7);
                }
            if (e.windup >= 0) {
                if (e.quakeX !== undefined)
                    for (const offset of bossQuakeOffsets(e)) {
                        const cx = Math.max(0, Math.min(w.w, e.quakeX + offset * h * 1.5));
                        p.line(cx - h * 0.48, w.ground - 0.6, cx + h * 0.48, w.ground - 0.6, 0xff674b);
                    }
                else
                    p.line(e.x, w.ground - 0.6, e.x + e.face * h * (bossPhase(e.hp, e.maxHp) > 1 ? 3 : 1.4), w.ground - 0.6, 0xff674b);
            }
        }
    for (const hazard of w.hazards) {
        const { x, radius, timer } = hazard;
        p.line(x - radius, w.ground - 0.6, x + radius, w.ground - 0.6, timer > 0 ? 0xff674b : 0xffd399);
        if (timer <= 0)
            for (const s of [-1, 0, 1]) {
                const cx = x + s * radius * 0.6, top = w.ground - h * (s === 0 ? 1.3 : 0.8);
                p.line(cx - radius * 0.28, w.ground, cx, top, 0xff785c);
                p.line(cx, top, cx + radius * 0.28, w.ground, 0xffe3b0);
            }
    }
}
