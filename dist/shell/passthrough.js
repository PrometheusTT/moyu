/**
 * 字节透传层 —— 内层 PTY 的输出原样送到真实终端，只改写会越界的序列。
 *
 * 设计原则：**默认不动字节**。绝大多数字节 memcpy 过去就完了。
 * 需要改写/上报的序列每一种都有实测依据（`strings` 扫过 claude 2.1.260 的二进制，
 * 又在真 PTY 里跑过一遍确认）：
 *
 *   1. DECSTBM（`CSI top;bot r`）→ 夹取到我们分给它的区域
 *   2. 绝对行定位（`CSI r;cH` / `CSI f` / `CSI d`）→ 夹取行号，防它写到游戏区
 *   3. 备用屏（`?1049h/l`、`?1047`、`?47`）→ 上报给上层，让它在新缓冲区上重设滚动区
 *   4. 全屏擦除（`ED 2` / `ED 3`）→ 上报给上层，让画布下一帧全量重绘
 *   5. 尺寸查询（`CSI 14/15/16/18/19 t`）→ **吞掉，我们自己回答**（见 `sizeReply`）
 *
 * ## 为什么备用屏期间**仍然**夹取
 *
 * 原来的策略是"内层进备用屏就让出整屏、停止夹取"，前提是"切备用屏 = 它想要整屏"。
 * 实测推翻了这个前提：真实 claude 2.1.260 启动时发**一次** `?1049h`，然后**整个会话
 * 都待在备用屏上**（退出时才 `?1049l`）。按原策略游戏就永远不显示，同屏合成等于不存在。
 *
 * 正确的理解是：备用屏只是另一个缓冲区，跟"它有多少行"无关 —— 行数是我们通过
 * TIOCSWINSZ 告诉它的，两个缓冲区上都一样。所以夹取在两边都成立，也都必须做。
 * 唯一的区别是 **DECSTBM 是每个缓冲区各自一份**，切过去之后要重新设一遍（上层的活）。
 *
 * 必须处理的坑：**一个转义序列可能被 PTY 的 read 切成两个 chunk**。
 * 所以扫描器持有一个未完成序列的缓冲区，跨 chunk 续上。
 */
import { DEFAULT_CELL } from "../render/caps.js";
/** CSI 参数缓冲上限。超过就认定是畸形/恶意序列，原样吐出去不再解析。 */
const MAX_CSI = 256;
const G_GROUND = 0;
const G_ESC = 1;
const G_CSI = 2;
/** OSC/DCS/SOS/PM/APC 的字符串体：只找终结符，不缓冲载荷。 */
const G_STRING = 3;
const G_STRING_ESC = 4;
const G_ESC_INTER = 5;
export class Passthrough {
    region;
    /** 内层可用的列数。和 `region` 一样，上层每次改布局都要跟着改。 */
    cols;
    /** 一个字符格的设备像素。构造时还没探测完，所以先给默认值，探完由上层赋值。 */
    cell;
    /**
     * 内层是否在备用屏。
     *
     * **不影响夹取** —— 见文件头"为什么备用屏期间仍然夹取"。它只用来给上层和还原逻辑
     * 报告状态，以及让 `?1049h` 的重复请求不触发第二次回调。
     */
    inAltScreen = false;
    /**
     * 内层往 kitty 键盘标志栈上 push 了几层（减去它自己弹掉的）。
     *
     * 退出时要照这个数弹回去。不还原的症状很难自己联想到我们：用户的 shell 从此收到
     * `CSI u` 形式的按键，方向键变成乱码、Ctrl+C 不再产生 SIGINT。实测 claude 2.1.260
     * 启动就 push 一层（`CSI > 5 u`），它正常退出会自己弹，被 SIGKILL 就不会。
     */
    kittyDepth = 0;
    /** 内层用 `CSI = flags u` 直接设过标志（不入栈，弹不掉，只有硬复位能收拾）。 */
    kittySet = false;
    onSizeQuery;
    onAltScreen;
    onScrollRegion;
    onFullClear;
    state = G_GROUND;
    /** 未完成的转义序列（含前导 ESC）。跨 chunk 续上靠它。 */
    pending = [];
    constructor(opts) {
        this.region = { top: opts.region.top, bottom: opts.region.bottom };
        this.cols = opts.cols;
        this.cell = opts.cell ?? { w: DEFAULT_CELL.w, h: DEFAULT_CELL.h };
        this.onSizeQuery = opts.onSizeQuery;
        this.onAltScreen = opts.onAltScreen;
        this.onScrollRegion = opts.onScrollRegion;
        this.onFullClear = opts.onFullClear;
    }
    /** 是否有半截序列悬在缓冲里（测试和退出路径要检查）。 */
    get hasPending() {
        return this.state !== G_GROUND;
    }
    /**
     * 处理一个 chunk，返回该写给真实终端的字节。
     *
     * 未完成的序列会留在内部缓冲，不出现在返回值里 —— 下一个 chunk 到了才一起吐出去。
     * 这是正确性要求：半截序列写给终端会被它当垃圾显示出来。
     */
    push(chunk) {
        const out = [];
        let copyFrom = -1; // GROUND 状态下连续可直接拷贝的区间起点
        const flushCopy = (end) => {
            if (copyFrom >= 0 && end > copyFrom) {
                for (let k = copyFrom; k < end; k++)
                    out.push(chunk[k]);
            }
            copyFrom = -1;
        };
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (this.state === G_GROUND) {
                if (b === 0x1b) {
                    flushCopy(i);
                    this.state = G_ESC;
                    this.pending = [0x1b];
                }
                else if (copyFrom < 0) {
                    copyFrom = i;
                }
                continue;
            }
            // 非 GROUND：逐字节走状态机，产出由 step 决定
            this.step(b, out);
        }
        flushCopy(chunk.length);
        return Uint8Array.from(out);
    }
    step(b, out) {
        switch (this.state) {
            case G_ESC: {
                this.pending.push(b);
                if (b === 0x5b) {
                    this.state = G_CSI;
                    return;
                } // '['
                if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
                    // OSC / DCS / SOS / PM / APC —— 载荷可能很长（OSC 52 剪贴板），不缓冲
                    this.state = G_STRING;
                    this.emitPending(out);
                    return;
                }
                if (b >= 0x20 && b <= 0x2f) {
                    this.state = G_ESC_INTER;
                    return;
                }
                // 单字节 ESC 序列（7 8 D E M c H 等）：不需要改写
                this.state = G_GROUND;
                this.emitPending(out);
                return;
            }
            case G_ESC_INTER: {
                this.pending.push(b);
                if (b >= 0x20 && b <= 0x2f)
                    return; // 还有中间字节
                this.state = G_GROUND;
                this.emitPending(out);
                return;
            }
            case G_CSI: {
                this.pending.push(b);
                if (this.pending.length > MAX_CSI) {
                    // 畸形：原样吐出，回到 GROUND，不再尝试理解
                    this.state = G_GROUND;
                    this.emitPending(out);
                    return;
                }
                if (b >= 0x40 && b <= 0x7e) { // 终结字节
                    this.state = G_GROUND;
                    this.emitCsi(out);
                    return;
                }
                return; // 参数/前缀/中间字节，继续攒
            }
            case G_STRING: {
                if (b === 0x07) {
                    out.push(b);
                    this.state = G_GROUND;
                    return;
                } // BEL 终结
                if (b === 0x18 || b === 0x1a) { // CAN / SUB：中止
                    out.push(b);
                    this.state = G_GROUND;
                    return;
                }
                if (b === 0x1b) {
                    // **不立刻吐这个 ESC**。它可能是 ST（`ESC \`）的前半，也可能是一条新序列的开头
                    // （比如 OSC 没写终结符就直接跟了 `ESC [ ... H`）。留到下一个字节才知道，
                    // 而如果是新序列，它必须走 CSI 那条路才会被夹取。
                    this.state = G_STRING_ESC;
                    this.pending = [0x1b];
                    return;
                }
                out.push(b);
                return;
            }
            case G_STRING_ESC: {
                if (b === 0x5c) { // ST
                    this.pending.push(b);
                    this.state = G_GROUND;
                    this.emitPending(out);
                    return;
                }
                // 字符串被一条新的转义序列打断。真实终端就是这么做的（VT500 状态表：
                // OSC_STRING 收到 ESC 直接转 escape 态，未终结的字符串被丢弃），
                // 所以我们跟着它按普通 ESC 序列重新解析这个字节 —— 后面的 CSI 照样会被夹取。
                this.state = G_ESC;
                this.step(b, out);
                return;
            }
        }
    }
    emitPending(out) {
        for (const x of this.pending)
            out.push(x);
        this.pending = [];
    }
    static encoder = new TextEncoder();
    emitStr(out, s) {
        const bytes = Passthrough.encoder.encode(s);
        for (let i = 0; i < bytes.length; i++)
            out.push(bytes[i]);
        this.pending = [];
    }
    /** 一条完整 CSI 序列已在 pending 里。决定原样透传还是改写。 */
    emitCsi(out) {
        const seq = this.pending;
        const final = seq[seq.length - 1];
        // seq = ESC [ <prefix><params><inter> <final>
        let i = 2;
        let prefix = '';
        while (i < seq.length - 1 && seq[i] >= 0x3c && seq[i] <= 0x3f) {
            prefix += String.fromCharCode(seq[i]);
            i++;
        }
        const paramStart = i;
        while (i < seq.length - 1 && ((seq[i] >= 0x30 && seq[i] <= 0x39) || seq[i] === 0x3b || seq[i] === 0x3a))
            i++;
        const paramEnd = i;
        let inter = '';
        while (i < seq.length - 1) {
            inter += String.fromCharCode(seq[i]);
            i++;
        }
        // 有中间字节的一律不碰（DECSCUSR / DECRQM / DECSET-with-inter 等）
        if (inter !== '') {
            this.emitPending(out);
            return;
        }
        // 备用屏检测：?h / ?l
        if (prefix === '?' && (final === 0x68 || final === 0x6c)) {
            const on = final === 0x68;
            const params = this.parseParams(seq, paramStart, paramEnd);
            for (const p of params) {
                if (p === 1049 || p === 1047 || p === 47) {
                    // 注意：真实终端把它当幂等的 set/reset，不是计数器。
                    // 内层再 spawn 一个也用备用屏的程序（less/vim）时会有歧义，
                    // 但那个歧义真实终端本来就有，内层程序自己会重绘，我们跟着它就对。
                    if (this.inAltScreen !== on) {
                        this.inAltScreen = on;
                        this.onAltScreen?.(on);
                    }
                }
            }
            this.emitPending(out);
            return;
        }
        // ── kitty 键盘标志栈：只数，不改写 ──────────────────────────────
        // 字节必须原样过去（标志仲裁是 M4 的事），我们只需要知道内层留了几层没弹，
        // 好在它死得不干净的时候替它弹掉。
        if (final === 0x75 && (prefix === '>' || prefix === '<' || prefix === '=')) {
            if (prefix === '>')
                this.kittyDepth++;
            else if (prefix === '<') {
                const n = this.parseParams(seq, paramStart, paramEnd)[0];
                this.kittyDepth = Math.max(0, this.kittyDepth - (n === undefined || n < 1 ? 1 : n));
            }
            else
                this.kittySet = true;
            this.emitPending(out);
            return;
        }
        if (prefix !== '') {
            this.emitPending(out);
            return;
        }
        // ── 尺寸查询（XTWINOPS）：吞掉，我们自己回答 ──────────────────────
        if (final === 0x74) { // 't'
            const cb = this.onSizeQuery;
            const reply = cb === undefined ? '' : this.sizeReply(this.parseParams(seq, paramStart, paramEnd)[0]);
            if (cb !== undefined && reply !== '') {
                this.pending = []; // 查询一个字节都不给终端
                cb(reply);
                return;
            }
            // 不是尺寸查询（`CSI 24 t` 改窗口行数、`CSI 22/23 t` 存取标题等）：原样透传。
            this.emitPending(out);
            return;
        }
        // ── DECSTBM：夹取 ──────────────────────────────────────────────
        if (final === 0x72) { // 'r'
            const params = this.parseParams(seq, paramStart, paramEnd);
            const reqTop = params[0] === undefined || params[0] < 0 ? 1 : params[0];
            const reqBot = params[1] === undefined || params[1] < 0
                ? this.region.bottom - this.region.top + 1
                : params[1];
            this.onScrollRegion?.(reqTop, reqBot);
            // 内层以为自己有 (bottom-top+1) 行，它给的是**区域内**行号；
            // 我们让内层从 region.top 开始，所以要平移再夹取。
            const lo = this.region.top;
            const hi = this.region.bottom;
            let top = Math.max(lo, Math.min(hi, this.region.top + reqTop - 1));
            let bot = Math.max(lo, Math.min(hi, this.region.top + reqBot - 1));
            if (top >= bot) {
                top = lo;
                bot = hi;
            }
            this.emitStr(out, `\x1b[${top};${bot}r`);
            return;
        }
        // ── 全屏擦除：不改写，只上报 ────────────────────────────────────
        //
        // 刻意**不夹取** ED 2。夹取要么把光标搬走（`CSI {bottom};{cols}H` + ED 1），
        // 要么发 innerRows 条 EL（几百字节）。而内层紧跟着 ED 2 一定会重绘它自己那一片，
        // 所以擦到游戏区的那部分只会亮一帧 —— 代价是 33ms 的闪，换来的是零光标风险。
        // 真正必须做的是让画布知道"屏幕被人动过了"，否则差分编码会以为不用重发。
        if (final === 0x4a) { // 'J'
            const params = this.parseParams(seq, paramStart, paramEnd);
            const mode = params[0] ?? 0;
            if (mode === 2 || mode === 3)
                this.onFullClear?.();
            this.emitPending(out);
            return;
        }
        // ── 绝对行定位：夹取行号 ────────────────────────────────────────
        if (final === 0x48 || final === 0x66 || final === 0x64) {
            const params = this.parseParams(seq, paramStart, paramEnd);
            const span = this.region.bottom - this.region.top + 1;
            if (final === 0x64) { // VPA: CSI r d
                const r = params[0] === undefined || params[0] < 0 ? 1 : params[0];
                if (r >= 1 && r <= span) {
                    this.emitPending(out);
                    return;
                } // 本来就在界内
                this.emitStr(out, `\x1b[${Math.max(1, Math.min(span, r))}d`);
                return;
            }
            // CUP / HVP: CSI r;c H|f
            const r = params[0] === undefined || params[0] < 0 ? 1 : params[0];
            const c = params[1] === undefined || params[1] < 0 ? 1 : params[1];
            if (r >= 1 && r <= span) {
                this.emitPending(out);
                return;
            }
            const fin = final === 0x48 ? 'H' : 'f';
            this.emitStr(out, `\x1b[${Math.max(1, Math.min(span, r))};${c}${fin}`);
            return;
        }
        this.emitPending(out);
    }
    /**
     * 内层问尺寸时该回它什么。返回 `''` = 这条不是尺寸查询，原样透传。
     *
     * **为什么不能让终端回答**：终端回的是整个窗口，而内层只有上半屏。内层照那个数排版
     * 就会算错自己的高度；更糟的是它按窗口高度往 kitty graphics 里塞一张图 —— 那张图会
     * 溢下来盖住游戏区。这条和 DECSTBM 夹取、绝对行夹取是同一件事的第三个面。
     *
     * **为什么是"吞掉查询"而不是"改写回复"**：改写回复要在两个方向上维护"有一条查询在飞"
     * 的状态，而焦点在游戏时按键根本不进内层，回复到底是给谁的无法区分。几何本来就是我们
     * 算出来的，自己回答既短又准。
     *
     * 回复格式（xterm XTWINOPS）：14→`CSI 4;h;w t`（文本区像素）、15→`CSI 5;h;w t`
     * （屏幕像素）、16→`CSI 6;h;w t`（格像素）、18→`CSI 8;rows;cols t`（文本区字符）、
     * 19→`CSI 9;rows;cols t`（屏幕字符）。14/15 和 18/19 都按**内层拿到的**那块回，
     * 因为内层能用的就那么大。
     */
    sizeReply(kind) {
        const rows = this.region.bottom - this.region.top + 1;
        const ph = rows * this.cell.h;
        const pw = this.cols * this.cell.w;
        switch (kind) {
            case 14: return `\x1b[4;${ph};${pw}t`;
            case 15: return `\x1b[5;${ph};${pw}t`;
            case 16: return `\x1b[6;${this.cell.h};${this.cell.w}t`;
            case 18: return `\x1b[8;${rows};${this.cols}t`;
            case 19: return `\x1b[9;${rows};${this.cols}t`;
            default: return '';
        }
    }
    parseParams(seq, start, end) {
        const params = [];
        let cur = -1;
        for (let k = start; k < end; k++) {
            const b = seq[k];
            if (b >= 0x30 && b <= 0x39)
                cur = (cur < 0 ? 0 : cur) * 10 + (b - 0x30);
            else {
                params.push(cur);
                cur = -1;
            }
        }
        params.push(cur);
        return params;
    }
}
