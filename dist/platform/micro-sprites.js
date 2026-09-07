function frame(head, limbs, sword) {
    const grid = Array.from({ length: 8 }, () => Array(20).fill('.'));
    const dot = (x, y, mark) => { if (x >= 0 && x < 20 && y >= 0 && y < 8)
        grid[y][x] = mark; };
    const line = (a, b, mark) => {
        const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
        for (let i = 0; i <= steps; i++)
            dot(Math.round(a[0] + (b[0] - a[0]) * i / steps), Math.round(a[1] + (b[1] - a[1]) * i / steps), mark);
    };
    for (const limb of limbs)
        for (let i = 1; i < limb.length; i++)
            line(limb[i - 1], limb[i], '#');
    for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++)
            dot(head[0] + x, head[1] + y, '#');
    for (let i = 1; i < sword.length; i++)
        line(sword[i - 1], sword[i], '*');
    return grid.map(row => row.join(''));
}
export const MICRO_FIGHTER = {
    idle: frame([8, 0], [[[8, 2], [8, 5]], [[6, 4], [6, 3], [10, 3], [11, 2]], [[6, 7], [8, 5], [10, 7]]], [[12, 2], [14, 0]]),
    runA: frame([8, 0], [[[8, 2], [8, 5]], [[5, 2], [6, 3], [10, 3], [11, 2]], [[5, 7], [8, 5], [10, 6], [12, 6]]], [[12, 2], [14, 0]]),
    runB: frame([8, 0], [[[8, 2], [8, 5]], [[5, 4], [6, 3], [10, 3], [11, 2]], [[5, 6], [7, 6], [8, 5], [11, 7]]], [[12, 2], [14, 0]]),
    jump: frame([8, 0], [[[8, 2], [8, 4]], [[5, 2], [6, 3], [10, 3], [11, 1]], [[5, 5], [7, 6], [8, 4], [10, 5], [11, 4]]], [[12, 1], [14, 0]]),
    windup: frame([8, 0], [[[8, 2], [8, 5]], [[6, 1], [6, 3], [10, 3]], [[5, 7], [8, 5], [11, 7]]], [[5, 1], [2, 0]]),
    strike: frame([8, 0], [[[8, 2], [8, 5]], [[5, 4], [6, 3], [11, 3]], [[5, 7], [8, 5], [11, 7]]], [[12, 3], [19, 3]]),
    recover: frame([8, 0], [[[8, 2], [8, 5]], [[6, 4], [6, 3], [10, 3], [11, 4]], [[5, 7], [8, 5], [11, 7]]], [[12, 4], [15, 7]]),
    hurt: frame([6, 0], [[[7, 2], [8, 5]], [[4, 2], [7, 3], [10, 2]], [[5, 7], [8, 5], [11, 7]]], []),
};
export function microPoseFor(f) {
    if (f.hurt > 0)
        return 'hurt';
    if (f.atk >= 0)
        return f.atk < 0.20 ? 'windup' : f.atk < 0.43 ? 'strike' : 'recover';
    if (!f.onGround)
        return 'jump';
    if (Math.abs(f.vx) > f.h * 0.12)
        return f.walk < 0.5 ? 'runA' : 'runB';
    return 'idle';
}
export function drawMicroFighter(c, f, centerX, body, blade, lift = 0) {
    const sprite = MICRO_FIGHTER[microPoseFor(f)];
    const pivot = Math.round(centerX / 2) * 2;
    for (let y = 0; y < sprite.length; y++)
        for (let x = 0; x < sprite[y].length; x++) {
            const mark = sprite[y][x];
            const dy = !f.onGround && f.atk < 0 && f.hurt <= 0 ? 1 - Math.round(lift) : 0;
            if (mark === '#' || (mark === '*' && f.armed))
                c.pixel(pivot + (x - 8) * f.face, y + dy, mark === '#' ? body : blade);
        }
}
