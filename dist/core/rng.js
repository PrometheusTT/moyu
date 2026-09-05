/**
 * 种子化 xorshift32。
 *
 * 为什么不用 `Math.random()`：**确定性是可测试性的前提**。血花往哪飞、敌人从哪边刷，
 * 全都过这个 RNG，于是"同一个种子 + 同一串输入 = 同一场战斗"，无头测试才能断言
 * "砍一刀会掉 6 块肉"这种事。顺带也让 bench 的字节数每次都一样。
 */
export class Rng {
    s;
    constructor(seed = 0x2545f491) {
        // 0 是 xorshift 的不动点，会永远返回 0。
        this.s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
    }
    /** 下一个 32 位无符号数。 */
    next() {
        let x = this.s;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.s = x | 0;
        return x >>> 0;
    }
    /** [0, 1) */
    float() {
        return this.next() / 0x1_0000_0000;
    }
    /** [lo, hi) 的浮点。 */
    range(lo, hi) {
        return lo + this.float() * (hi - lo);
    }
    /** [lo, hi] 的整数。 */
    int(lo, hi) {
        return lo + Math.floor(this.float() * (hi - lo + 1));
    }
    /** ±spread。 */
    spread(spread) {
        return (this.float() * 2 - 1) * spread;
    }
    /** 概率为 p 的真。 */
    chance(p) {
        return this.float() < p;
    }
    /** 随机挑一个（空数组返回 undefined —— 调用方自己保证非空）。 */
    pick(xs) {
        return xs.length === 0 ? undefined : xs[Math.floor(this.float() * xs.length)];
    }
}
