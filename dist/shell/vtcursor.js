/**
 * 局部 VT 解析器 —— 整个外壳方案的承重件。
 *
 * 明确**只**跟踪四样东西：光标行列、光标可见性、SGR 状态、影响坐标语义的模式。
 * 明确**不**做：不维护单元格网格、不重排、不存 scrollback。
 * 因为字节是原样透传给真实终端的，真实终端才是那个终端模拟器。
 * 这是"双区域透传 + 局部光标跟踪"而不是"写一个 tmux"的分界线。
 *
 * 用途：游戏每帧画完下半屏后，用 `restoreSeq()` 把内层的光标位置和属性精确还原，
 * 让内层完全感知不到我们在同一块屏幕上画过东西。
 */
import { charWidth } from "./wcwidth.js";
import { applySgr, cloneSgr, emitSgr, freshSgr } from "./sgr.js";
/** 解析器状态机。用 const 对象而不是 enum —— Node 的类型剥离不支持 enum。 */
const S_GROUND = 0;
const S_ESC = 1;
const S_ESC_INTER = 2;
const S_CSI_PARAM = 3;
const S_CSI_INTER = 4;
const S_OSC = 5;
const S_DCS = 6;
const S_SOS_PM_APC = 7;
const S_UTF8 = 8;
export class VtCursor {
    cols;
    rows;
    /** 1-based 绝对屏幕坐标。内层从真实第 1 行开始，所以这就是真实坐标，无需转换。 */
    row = 1;
    col = 1;
    visible = true;
    /**
     * 「待换行」标志（xterm 的 wrapnext）。写满最后一列时光标停在该列，
     * 直到下一个可打印字符才真正换行。不跟踪它会让长行的列号漂一格。
     */
    pendingWrap = false;
    sgr = freshSgr();
    saved = null;
    autowrap = true; // DECAWM，默认开
    origin = false; // DECOM，默认关
    /** 内层请求的滚动区（1-based，含端点）。默认全屏。 */
    scrollTop = 1;
    scrollBot;
    /** 内层是否处于备用屏。altscreen.ts 是权威，这里只是镜像给还原逻辑用。 */
    altScreen = false;
    /** 制表位。默认每 8 列一个。 */
    tabs = new Set();
    state = S_GROUND;
    params = [];
    curParam = -1; // -1 表示"该位为空"
    csiPrefix = ''; // ? > < = 之类的私有前缀
    csiInter = ''; // 中间字节
    escInter = '';
    /** UTF-8 多字节序列累积。 */
    u8Need = 0;
    u8Acc = 0;
    constructor(opts) {
        this.cols = Math.max(1, opts.cols);
        this.rows = Math.max(1, opts.rows);
        this.scrollBot = this.rows;
        this.resetTabs();
    }
    resetTabs() {
        this.tabs.clear();
        for (let c = 9; c <= this.cols; c += 8)
            this.tabs.add(c);
    }
    /** 终端 resize：夹取光标和滚动区，重建制表位。 */
    resize(cols, rows) {
        this.cols = Math.max(1, cols);
        this.rows = Math.max(1, rows);
        this.col = Math.min(this.col, this.cols);
        this.row = Math.min(this.row, this.rows);
        this.scrollTop = Math.min(this.scrollTop, this.rows);
        this.scrollBot = Math.min(this.scrollBot, this.rows);
        if (this.scrollBot <= this.scrollTop) {
            this.scrollTop = 1;
            this.scrollBot = this.rows;
        }
        this.pendingWrap = false;
        this.resetTabs();
    }
    snapshot() {
        return { row: this.row, col: this.col, visible: this.visible, sgr: cloneSgr(this.sgr) };
    }
    /**
     * 游戏画完之后要写出去的还原序列。
     *
     * 顺序有讲究：先重建 SGR（内层可能设了"接下来用红色"的 pending 属性），
     * 再定位光标，最后恢复可见性 —— 定位时光标应该是隐藏的，否则会看到它跳。
     *
     * 注意这里**不发 DECSTBM** —— 滚动区由 passthrough 层负责，
     * 因为那是我们夹取过的值，不是内层原始请求的值。
     */
    restoreSeq() {
        let out = emitSgr(this.sgr);
        out += `\x1b[${this.row};${this.col}H`;
        // pendingWrap 无法用 CUP 还原（CUP 会清掉它）。这是已知的、可接受的精度损失：
        // 只在内层刚好写满一行、且下一次写入是相对定位时才会差一格。
        out += this.visible ? '\x1b[?25h' : '\x1b[?25l';
        return out;
    }
    /** 喂入内层输出的字节。只更新状态，不产生输出 —— 透传由调用方负责。 */
    feed(chunk) {
        for (let i = 0; i < chunk.length; i++) {
            this.byte(chunk[i]);
        }
    }
    byte(b) {
        // ESC / CAN / SUB 在任何状态下都会中断当前序列
        if (b === 0x1b) {
            this.state = S_ESC;
            this.escInter = '';
            return;
        }
        if ((b === 0x18 || b === 0x1a) && this.state !== S_GROUND) {
            this.state = S_GROUND;
            return;
        }
        switch (this.state) {
            case S_GROUND:
                this.ground(b);
                return;
            case S_UTF8:
                this.utf8Cont(b);
                return;
            case S_ESC:
                this.esc(b);
                return;
            case S_ESC_INTER:
                this.escIntermediate(b);
                return;
            case S_CSI_PARAM:
                this.csiParam(b);
                return;
            case S_CSI_INTER:
                this.csiIntermediate(b);
                return;
            case S_OSC:
                this.stringTerm(b);
                return;
            case S_DCS:
                this.stringTerm(b);
                return;
            case S_SOS_PM_APC:
                this.stringTerm(b);
                return;
        }
    }
    // ── GROUND：C0 控制字符与可打印字符 ────────────────────────────────
    ground(b) {
        if (b < 0x20) {
            switch (b) {
                case 0x07: return; // BEL
                case 0x08: // BS
                    if (this.pendingWrap)
                        this.pendingWrap = false;
                    else if (this.col > 1)
                        this.col--;
                    return;
                case 0x09:
                    this.tab();
                    return; // HT
                case 0x0a:
                case 0x0b:
                case 0x0c: // LF VT FF
                    this.index();
                    return;
                case 0x0d: // CR
                    this.col = 1;
                    this.pendingWrap = false;
                    return;
                default: return; // 其余 C0 不影响光标
            }
        }
        if (b === 0x7f)
            return; // DEL
        // UTF-8 前导字节
        if (b >= 0xc2 && b <= 0xdf) {
            this.u8Need = 1;
            this.u8Acc = b & 0x1f;
            this.state = S_UTF8;
            return;
        }
        if (b >= 0xe0 && b <= 0xef) {
            this.u8Need = 2;
            this.u8Acc = b & 0x0f;
            this.state = S_UTF8;
            return;
        }
        if (b >= 0xf0 && b <= 0xf4) {
            this.u8Need = 3;
            this.u8Acc = b & 0x07;
            this.state = S_UTF8;
            return;
        }
        if (b >= 0x80)
            return; // 孤立续字节 / 非法前导，忽略
        this.printCp(b);
    }
    utf8Cont(b) {
        if (b < 0x80 || b > 0xbf) {
            // 非法续字节：放弃这个码位，回到 GROUND 重新处理这个字节
            this.state = S_GROUND;
            this.ground(b);
            return;
        }
        this.u8Acc = (this.u8Acc << 6) | (b & 0x3f);
        if (--this.u8Need === 0) {
            this.state = S_GROUND;
            this.printCp(this.u8Acc);
        }
    }
    /** 写一个可打印码位，按宽度推进列号，处理自动换行。 */
    printCp(cp) {
        const w = charWidth(cp);
        if (w === 0)
            return; // 组合记号附着在前一格，不动光标
        if (this.pendingWrap) {
            this.pendingWrap = false;
            this.col = 1;
            this.index();
        }
        // 双宽字符放不进最后一列时，xterm 会先换行
        if (w === 2 && this.col === this.cols) {
            this.col = 1;
            this.index();
        }
        this.col += w;
        if (this.col > this.cols) {
            this.col = this.cols;
            if (this.autowrap)
                this.pendingWrap = true;
        }
    }
    tab() {
        this.pendingWrap = false;
        for (let c = this.col + 1; c <= this.cols; c++) {
            if (this.tabs.has(c)) {
                this.col = c;
                return;
            }
        }
        this.col = this.cols;
    }
    /** IND / LF：下移一行，到滚动区底就滚屏（滚屏时行号不变）。 */
    index() {
        this.pendingWrap = false;
        if (this.row === this.scrollBot)
            return; // 真实终端会滚，光标行号不变
        if (this.row < this.rows)
            this.row++;
    }
    /** RI：上移一行，到滚动区顶就反向滚屏。 */
    reverseIndex() {
        this.pendingWrap = false;
        if (this.row === this.scrollTop)
            return;
        if (this.row > 1)
            this.row--;
    }
    // ── ESC ───────────────────────────────────────────────────────────
    esc(b) {
        if (b >= 0x20 && b <= 0x2f) { // 中间字节：( ) * + # SP 等
            this.escInter = String.fromCharCode(b);
            this.state = S_ESC_INTER;
            return;
        }
        if (b === 0x5b) { // '[' → CSI
            this.state = S_CSI_PARAM;
            this.params = [];
            this.curParam = -1;
            this.csiPrefix = '';
            this.csiInter = '';
            return;
        }
        if (b === 0x5d) {
            this.state = S_OSC;
            return;
        } // ']' OSC
        if (b === 0x50) {
            this.state = S_DCS;
            return;
        } // 'P' DCS
        if (b === 0x58 || b === 0x5e || b === 0x5f) { // X ^ _ → SOS/PM/APC
            this.state = S_SOS_PM_APC;
            return;
        }
        this.state = S_GROUND;
        switch (b) {
            case 0x37:
                this.decsc();
                return; // '7' DECSC
            case 0x38:
                this.decrc();
                return; // '8' DECRC
            case 0x44:
                this.index();
                return; // 'D' IND
            case 0x45: // 'E' NEL
                this.col = 1;
                this.index();
                return;
            case 0x4d:
                this.reverseIndex();
                return; // 'M' RI
            case 0x48:
                this.tabs.add(this.col);
                return; // 'H' HTS
            case 0x63: // 'c' RIS 全复位
                this.hardReset();
                return;
            default: return;
        }
    }
    escIntermediate(b) {
        // ESC # 8 (DECALN) 会把光标移到左上角；其余（字符集选择等）不影响光标
        if (this.escInter === '#' && b === 0x38) {
            this.row = 1;
            this.col = 1;
            this.pendingWrap = false;
        }
        this.state = S_GROUND;
    }
    decsc() {
        this.saved = {
            row: this.row,
            col: this.col,
            sgr: cloneSgr(this.sgr),
            origin: this.origin,
            autowrap: this.autowrap,
        };
    }
    decrc() {
        const s = this.saved;
        if (s === null) {
            // 没保存过：DEC 规定恢复到原点、默认属性
            this.row = 1;
            this.col = 1;
            this.sgr = freshSgr();
            this.origin = false;
            this.pendingWrap = false;
            return;
        }
        this.row = Math.min(s.row, this.rows);
        this.col = Math.min(s.col, this.cols);
        this.sgr = cloneSgr(s.sgr);
        this.origin = s.origin;
        this.autowrap = s.autowrap;
        this.pendingWrap = false;
    }
    hardReset() {
        this.row = 1;
        this.col = 1;
        this.visible = true;
        this.pendingWrap = false;
        this.sgr = freshSgr();
        this.saved = null;
        this.autowrap = true;
        this.origin = false;
        this.scrollTop = 1;
        this.scrollBot = this.rows;
        this.altScreen = false;
        this.resetTabs();
    }
    // ── CSI ───────────────────────────────────────────────────────────
    csiParam(b) {
        if (b >= 0x30 && b <= 0x39) { // 0-9
            this.curParam = (this.curParam < 0 ? 0 : this.curParam) * 10 + (b - 0x30);
            if (this.curParam > 0xffff)
                this.curParam = 0xffff; // 防溢出
            return;
        }
        if (b === 0x3b || b === 0x3a) { // ';' 或 ':'（子参数按同级处理）
            this.params.push(this.curParam);
            this.curParam = -1;
            return;
        }
        if (b >= 0x3c && b <= 0x3f) { // < = > ? 私有前缀
            this.csiPrefix += String.fromCharCode(b);
            return;
        }
        if (b >= 0x20 && b <= 0x2f) { // 中间字节
            this.csiInter = String.fromCharCode(b);
            this.state = S_CSI_INTER;
            return;
        }
        if (b >= 0x40 && b <= 0x7e) { // 终结字节
            this.params.push(this.curParam);
            this.state = S_GROUND;
            this.dispatchCsi(String.fromCharCode(b));
            return;
        }
        // 其它（C0 已在 byte() 处理）：当作非法，丢弃
        this.state = S_GROUND;
    }
    csiIntermediate(b) {
        if (b >= 0x20 && b <= 0x2f) {
            this.csiInter += String.fromCharCode(b);
            return;
        }
        if (b >= 0x40 && b <= 0x7e) {
            this.params.push(this.curParam);
            this.state = S_GROUND;
            this.dispatchCsi(String.fromCharCode(b));
            return;
        }
        this.state = S_GROUND;
    }
    /** 取第 n 个参数（0-based），空参数用 def。 */
    p(n, def) {
        const v = this.params[n];
        return v === undefined || v < 0 ? def : v;
    }
    /**
     * 「次数」类参数：缺省是 1，而**显式的 0 也当 1**。
     *
     * 这是 xterm 的实际行为（`count = (param < 1) ? 1 : param`），不是宽容处理 ——
     * `CSI 0 C` 移动一列，不是不动。位置类参数（CUP/CHA/VPA）不走这个，
     * 它们的 0 由 setRow/setCol 夹到 1，语义不同。
     */
    pn(n) {
        const v = this.p(n, 1);
        return v < 1 ? 1 : v;
    }
    dispatchCsi(final) {
        // 有中间字节的（DECSCUSR 'q'、DECRQM '$p' 等）都不影响光标位置
        if (this.csiInter !== '')
            return;
        if (this.csiPrefix === '?') {
            if (final === 'h')
                this.setModes(true);
            else if (final === 'l')
                this.setModes(false);
            return;
        }
        // 其它私有前缀（> < =）：kitty 键盘、modifyOtherKeys 等，不影响光标
        if (this.csiPrefix !== '')
            return;
        switch (final) {
            case 'A':
                this.moveRow(-this.pn(0));
                return; // CUU
            case 'B':
            case 'e':
                this.moveRow(this.pn(0));
                return; // CUD / VPR
            case 'C':
            case 'a':
                this.moveCol(this.pn(0));
                return; // CUF / HPR
            case 'D':
                this.moveCol(-this.pn(0));
                return; // CUB
            case 'E':
                this.col = 1;
                this.moveRow(this.pn(0));
                return; // CNL
            case 'F':
                this.col = 1;
                this.moveRow(-this.pn(0));
                return; // CPL
            case 'G':
            case '`':
                this.setCol(this.p(0, 1));
                return; // CHA / HPA
            case 'd':
                this.setRow(this.p(0, 1));
                return; // VPA
            case 'H':
            case 'f': // CUP / HVP
                this.setRow(this.p(0, 1));
                this.setCol(this.p(1, 1));
                return;
            case 'I':
                for (let i = this.pn(0); i > 0; i--)
                    this.tab();
                return; // CHT
            case 'Z':
                this.backTab(this.pn(0));
                return; // CBT
            case 'm':
                applySgr(this.sgr, this.normalizedSgrParams());
                return; // SGR
            case 'r':
                this.decstbm();
                return; // DECSTBM
            case 's':
                this.decsc();
                return; // ANSI.SYS SCP
            case 'u':
                this.decrc();
                return; // ANSI.SYS RCP
            case 'L':
            case 'M': // IL / DL
                // 插入/删除行会把光标移到该行第一列
                this.col = 1;
                this.pendingWrap = false;
                return;
            case 'J':
            case 'K':
            case 'P':
            case 'X':
            case '@': // ED EL DCH ECH ICH
                this.pendingWrap = false; // 内容变了但光标不动
                return;
            case 'S':
            case 'T': // SU / SD
                this.pendingWrap = false;
                return;
            case 'g': // TBC
                if (this.p(0, 0) === 3)
                    this.tabs.clear();
                else
                    this.tabs.delete(this.col);
                return;
            default: return;
        }
    }
    /**
     * SGR 参数归一化：空参数（-1）转成 0。
     * 注意 csiParam 把 ':' 和 ';' 同等对待，所以 `38:2::255:0:0` 会得到
     * [38,2,-1,255,0,0]；把 -1 转 0 之后 readExtColor 会读成 38;2;0;255;0 —— 错一位。
     * 因此这里对 38/48/58 的冒号形式做一次修正：丢掉紧跟在 2 后面的空位（色彩空间 ID）。
     */
    normalizedSgrParams() {
        const out = [];
        for (let i = 0; i < this.params.length; i++) {
            const v = this.params[i];
            if ((v === 38 || v === 48 || v === 58) && this.params[i + 1] === 2 && this.params[i + 2] === -1) {
                out.push(v, 2);
                i += 2; // 跳过 kind 和那个空的色彩空间位
                continue;
            }
            out.push(v < 0 ? 0 : v);
        }
        return out;
    }
    backTab(n) {
        this.pendingWrap = false;
        for (let i = 0; i < n; i++) {
            let target = 1;
            for (let c = this.col - 1; c >= 1; c--) {
                if (this.tabs.has(c)) {
                    target = c;
                    break;
                }
            }
            this.col = target;
            if (target === 1)
                break;
        }
    }
    moveRow(delta) {
        this.pendingWrap = false;
        // CUU/CUD 受滚动区限制（不滚屏，只是夹取）
        const lo = this.origin ? this.scrollTop : 1;
        const hi = this.origin ? this.scrollBot : this.rows;
        this.row = Math.max(lo, Math.min(hi, this.row + delta));
    }
    moveCol(delta) {
        this.pendingWrap = false;
        this.col = Math.max(1, Math.min(this.cols, this.col + delta));
    }
    /** DECOM 开启时行号相对滚动区顶端。 */
    setRow(r) {
        this.pendingWrap = false;
        if (this.origin) {
            this.row = Math.min(this.scrollBot, this.scrollTop + Math.max(1, r) - 1);
        }
        else {
            this.row = Math.max(1, Math.min(this.rows, r));
        }
    }
    setCol(c) {
        this.pendingWrap = false;
        this.col = Math.max(1, Math.min(this.cols, c));
    }
    /**
     * 内层请求的滚动区。**这里只记录，不夹取** —— 夹取是 passthrough 层改写字节时做的事。
     * 分开是有意的：解析器要如实反映内层的意图，改写是策略。
     */
    decstbm() {
        const top = this.p(0, 1);
        const bot = this.p(1, this.rows);
        if (top >= bot) {
            // 非法区间：DEC 规定复位为全屏
            this.scrollTop = 1;
            this.scrollBot = this.rows;
        }
        else {
            this.scrollTop = Math.max(1, top);
            this.scrollBot = Math.min(this.rows, bot);
        }
        // DECSTBM 会把光标移到原点
        this.row = this.origin ? this.scrollTop : 1;
        this.col = 1;
        this.pendingWrap = false;
    }
    setModes(on) {
        for (const raw of this.params) {
            switch (raw) {
                case 6: // DECOM
                    this.origin = on;
                    this.row = on ? this.scrollTop : 1;
                    this.col = 1;
                    this.pendingWrap = false;
                    break;
                case 7:
                    this.autowrap = on;
                    break; // DECAWM
                case 25:
                    this.visible = on;
                    break; // DECTCEM
                case 47:
                case 1047:
                case 1049: // 备用屏
                    this.altScreen = on;
                    if (raw === 1049) {
                        // 1049 = 保存光标 + 切屏 + 清屏 / 反向
                        if (on) {
                            this.decsc();
                            this.row = 1;
                            this.col = 1;
                        }
                        else
                            this.decrc();
                    }
                    this.pendingWrap = false;
                    break;
                default: break; // 鼠标/粘贴/同步输出等不影响光标
            }
        }
    }
    /** OSC / DCS / SOS / PM / APC 的字符串体：找到终结符（BEL 或 ST）就回 GROUND。 */
    stringTerm(b) {
        // ESC 已在 byte() 里拦掉并把状态设成 S_ESC；ESC \ 的 '\' 会在 esc() 里落到 default。
        if (b === 0x07)
            this.state = S_GROUND;
        // 其余字节都是载荷，不影响光标
    }
}
