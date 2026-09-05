/**
 * 终端还原 —— 一等公民。
 *
 * 一个把用户 shell 搞坏的终端游戏是不可接受的。所以这里的目标不是"正常退出时收拾干净"，
 * 而是**在任何死法下都收拾干净**：正常 exit、Ctrl+C、SIGTERM、未捕获异常，全都走同一段字节。
 *
 * 三条设计约束：
 *   1. **同步**。`process.on('exit')` 里只能做同步事，所以用 `writeSync`，并且要处理
 *      非阻塞 fd 上的 EAGAIN（macOS 上 stdout 可能是 O_NONBLOCK，`writeSync` 会直接抛）。
 *   2. **幂等**。多个钩子可能同时触发（SIGINT 之后紧跟 exit），跑两遍不能出问题。
 *   3. **和 `moyu doctor --reset` 共用同一段字节**。逃生出口和正常路径分叉的话，
 *      逃生出口就是没测过的代码。
 *
 * 抓不到的只有 SIGKILL。那个交给 `bin/moyu` 的 sh EXIT trap 兜（node 被 -9 时 sh 还活着）。
 */
import { writeSync } from 'node:fs';
import { deleteImageSeq } from "../render/graphics.js";
/**
 * 还原序列的各个片段。顺序有讲究，不要随便调：
 *
 * - `syncOff` 必须最先 —— 如果死在一帧中间，DEC 2026 还开着，终端会扣住画面不刷新，
 *   后面发什么都看不见。
 * - `altOff` 必须在光标定位之前 —— `?1049l` 自带一次光标恢复，会覆盖我们的定位。
 * - `marginsOff` 必须在 `altOff` 之后 —— DECSTBM 是分屏缓冲区各自一份的。
 * - `imageOff` 要在 `altOff` 的**两边各发一次** —— kitty 图的存储也是每个缓冲区各自一份，
 *   见 `restoreSeq()` 里那段注释。
 */
const SEQ = {
    syncOff: '\x1b[?2026l',
    /**
     * 删掉我们上传给终端的那张图（像素档）。**只在真的用过像素档时发** —— 它是一条 APC，
     * 而不认 APC 的终端会把 `a=d,d=I,…` 当文字打在用户屏幕上，那比留一张图糟糕得多。
     *
     * 一次还原里它出现**两遍**（备用屏切换的两侧各一遍），原因见 `restoreSeq()`。
     */
    imageOff: deleteImageSeq(),
    /** 从 kitty 键盘标志栈弹出一层。 */
    kittyPop: '\x1b[<u',
    /** 硬复位 kitty 标志到 legacy（栈为空时也安全）。只在 doctor 里用。 */
    kittyHardReset: '\x1b[=0;1u',
    mouseOff: '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l',
    pasteOff: '\x1b[?2004l',
    altOff: '\x1b[?1049l\x1b[?1047l\x1b[?47l',
    marginsOff: '\x1b[r',
    wrapOn: '\x1b[?7h',
    originOff: '\x1b[?6l',
    sgrReset: '\x1b[0m',
    cursorOn: '\x1b[?25h',
};
/** 组装还原序列。纯函数，可单测、可直接 `printf` 出来人工检查。 */
export function restoreSeq(opts = {}) {
    const parts = [SEQ.syncOff];
    // 删图发**两遍**：`altOff` 之前一遍（现在这个缓冲区），之后再一遍（切回去的那个）。
    //
    // kitty 图的存储是**每个屏幕缓冲区各自一份**的 —— Ghostty 的 `kitty_images` 是
    // `Screen` 的字段（`/// Kitty graphics protocol state.`），主屏和备用屏各持一个
    // `ImageStorage`，所以一条 `a=d` 只删得掉**当前**那个缓冲区里的图。
    //
    // 而我们一定在两个缓冲区上都放过图：内层 claude 启动时才发 `?1049h`，在那之前的几十帧
    // 落在主屏上，之后的全部落在备用屏上。只删一次删掉的是备用屏那张，紧跟着的 `?1049l`
    // 一切回主屏，那张陈旧的图就露出来了 —— 用户报的“退出以后渲染框还在”正是它，
    // 而且位置刚好在新提示符下面，因为主屏上那几帧画在同一个 `gameTop` 上。
    //
    // 第二遍的代价只有 26 字节：删一个已经不存在的 `i=` 是空操作，`q=2` 连回复都没有。
    if (opts.deleteImage === true)
        parts.push(SEQ.imageOff);
    const pops = opts.kittyPops ?? 0;
    for (let i = 0; i < pops; i++)
        parts.push(SEQ.kittyPop);
    if (opts.kittyHardReset === true)
        parts.push(SEQ.kittyHardReset);
    parts.push(SEQ.mouseOff, SEQ.pasteOff, SEQ.altOff);
    // 现在一定在主屏上了（`?1049l/?1047l/?47l` 三条之后不可能还在备用屏）。第二遍删图。
    if (opts.deleteImage === true)
        parts.push(SEQ.imageOff);
    parts.push(SEQ.marginsOff, SEQ.wrapOn, SEQ.originOff, SEQ.sgrReset);
    if (opts.homeRow !== undefined) {
        // ED 0：从光标位置擦到屏幕末尾。游戏区就在下面，正好被擦掉。
        parts.push(`\x1b[${Math.max(1, Math.floor(opts.homeRow))};1H\x1b[J`);
    }
    parts.push(SEQ.cursorOn);
    return parts.join('');
}
/** `moyu doctor --reset` 用的无条件全量还原。不知道当前状态，所以最宽松。 */
export function doctorResetSeq() {
    // 弹 8 层是拍的：kitty 标志栈深度上限各终端不同，但正常使用不会超过个位数，
    // 而空栈上的 pop 按协议是被忽略的 —— 多弹几次没有副作用。
    // `deleteImage` 在这里是无条件的：doctor 的前提就是"屏幕已经坏了，不知道里面有什么"，
    // 而 SIGKILL 之后留在终端里的那张图只有这一条路能收走。
    return restoreSeq({ kittyPops: 8, kittyHardReset: true, deleteImage: true });
}
/** 阻塞式写 fd 1，自己处理 EAGAIN。退出路径上不能丢字节。 */
export function writeAllSync(fd, s) {
    const buf = Buffer.from(s, 'utf8');
    let off = 0;
    let spins = 0;
    while (off < buf.length) {
        try {
            off += writeSync(fd, buf, off, buf.length - off);
        }
        catch (e) {
            const code = e.code;
            if (code === 'EAGAIN') {
                // 非阻塞 fd 且内核缓冲满了。同步上下文里没法 await，只能忙等。
                // 上限保护：终端真死了（对端消失）就别在这儿转到天荒地老。
                if (++spins > 10_000)
                    return;
                continue;
            }
            if (code === 'EINTR')
                continue;
            return; // EPIPE / EBADF —— 终端没了，还原本身已无意义
        }
    }
}
/**
 * 还原钩子。`install()` 之后进程怎么死都会走一遍 `run()`。
 *
 * `stateProvider` 每次触发时现场取值 —— 因为 homeRow 和 kitty 层数是运行中变化的，
 * 安装时那份快照到退出时早过期了。
 */
export class Teardown {
    done = false;
    installed = false;
    extra = [];
    stateProvider;
    fd;
    // 不用参数属性（`constructor(private readonly x)`）—— Node 的类型剥离是纯删除，
    // 不做代码生成，参数属性需要生成赋值语句，所以它直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    // tsconfig 里的 `erasableSyntaxOnly` 就是为了让这条约束在类型检查阶段就暴露。
    constructor(stateProvider, fd = 1) {
        this.stateProvider = stateProvider;
        this.fd = fd;
    }
    /** 注册额外的同步清理动作（关 raw 模式、kill PTY 之类）。按注册顺序执行。 */
    onRestore(fn) {
        this.extra.push(fn);
    }
    /** 幂等。返回是否真的执行了（false = 之前已经跑过）。 */
    run() {
        if (this.done)
            return false;
        this.done = true;
        // 先发字节：终端状态是用户看得见的那部分，优先级最高。
        // 即使后面某个 extra 抛了，屏幕已经是干净的。
        let opts = {};
        try {
            opts = this.stateProvider();
        }
        catch { /* 状态取不到就用最保守的还原 */ }
        writeAllSync(this.fd, restoreSeq(opts));
        for (const fn of this.extra) {
            try {
                fn();
            }
            catch { /* 清理阶段的异常一律吞掉，不能挡住后面的清理 */ }
        }
        return true;
    }
    install() {
        if (this.installed)
            return;
        this.installed = true;
        process.on('exit', () => { this.run(); });
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
            process.on(sig, () => {
                this.run();
                // 用默认动作退出，好让父进程看到真实死因（128+signo）。
                // 不能直接 process.exit(0) —— 那会骗掉调用方的退出码。
                process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : sig === 'SIGHUP' ? 129 : 131);
            });
        }
        process.on('uncaughtException', (err) => {
            this.run();
            // 还原完了再把栈打出来 —— 反过来的话报错会被塞进滚动区里，或者根本看不见。
            console.error(err);
            process.exit(1);
        });
        process.on('unhandledRejection', (reason) => {
            this.run();
            console.error(reason);
            process.exit(1);
        });
    }
}
