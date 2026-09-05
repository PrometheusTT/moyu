/**
 * 输入路由 —— 决定每一个从真实终端进来的字节归谁。
 *
 * 默认**全部转发给内层**。这不是保守选择，是唯一可行的选择：内层是个交互式 CLI，
 * 少转一个字节就是少打一个字。所以拦截必须是精确的白名单，不能是"看起来像热键就吃掉"。
 *
 * ## 为什么用前缀键而不是 Ctrl+方向键
 *
 * 计划里写的是 `Ctrl+↑/↓` 调分屏。实现时改成了 tmux 式前缀（`Ctrl+G` 再跟一个命令字符），
 * 理由是安全性：`Ctrl+↑` 在线上是 `ESC [ 1 ; 5 A`，要认出它就得在 **stdin 侧**再写一个
 * 带跨读缓冲的 CSI 解析器。而 stdin 侧解析器的失败模式是**吃掉用户的按键** ——
 * 对一个包裹层来说这是最糟的一种坏法，比功能缺失糟得多。而且 `Ctrl+↑` 在没有
 * modifyOtherKeys / kitty 协议的终端里根本和 `↑` 无法区分，本来就不可靠。
 *
 * 前缀路径是字节精确的：`0x07` 后面那一个字节就是命令，不需要预测、不会误判、不会
 * 因为读被切断而错。代价是多按一个键。
 *
 * ## Ctrl+C 无条件转发给内层
 *
 * raw 模式下 `Ctrl+C` 只是字节 `0x03`，不是信号，所以路由权在我们手上。它永远给内层：
 * 你想中断的是那个在跑任务的东西，不是摸鱼游戏。想退出 moyu 用 `Ctrl+G q`。
 */
/** 前缀键：Ctrl+G = BEL = 0x07。 */
export const PREFIX = 0x07;
/**
 * 前缀之后的命令表。刻意只有单字节命令 —— 多字节命令又会把跨读缓冲的问题引回来。
 *
 * ## `Ctrl+G Ctrl+G` 是切焦点，**不是**"送一个字面 Ctrl+G 给内层"
 *
 * tmux 的惯例是前缀连按两次 = 送一个字面前缀键。这里**故意不这样做**，因为实测踩到了：
 * 切焦点是这个外壳里最高频的动作，而单按一次 `^G` 从用户角度看**什么都没发生**
 * （它只是进了等命令状态），于是下一步一定是再按一次 —— 按到 tmux 惯例上，
 * 那一下就把真的 `0x07` 送进了 claude，而 claude 的 Ctrl+G 是**打开外部编辑器**。
 * 症状：一按 `^G ^G` 就跳进一个文档编辑界面，看起来像外壳失灵了。
 *
 * 所以连按 = 切焦点（也就是用户本来想干的事），代价是内层永远收不到 Ctrl+G。
 * 这个代价可以接受：前缀键被占用就是要付这个的，而 `^G` 在内层上的功能恰好是
 * 我们最不希望被误触的那一个。
 *
 * 另外单按一次 `^G` 之后 HUD 会立刻显示等命令的菜单（见 `pendingHint`）——
 * "按了没反应"本身就是上面那条 bug 的根，光改按键表不改反馈还会再踩一次。
 */
function command(b) {
    switch (b) {
        case PREFIX: // ^G ^G：就是切焦点，见上面
        case 0x09: // Tab
        case 0x67: // 'g'
            return { kind: 'toggle-focus' };
        case 0x68: return { kind: 'toggle-hidden' }; // 'h'
        case 0x2b: // '+'
        case 0x3d: // '=' （不用按 Shift 的 '+'）
        case 0x6b: return { kind: 'adjust-split', delta: 1 }; // 'k'
        case 0x2d: // '-'
        case 0x5f: // '_'
        case 0x6a: return { kind: 'adjust-split', delta: -1 }; // 'j'
        case 0x0c: // Ctrl+L
        case 0x72: return { kind: 'redraw' }; // 'r'
        case 0x71: return { kind: 'quit' }; // 'q'
        default: return 'unknown';
    }
}
/**
 * ## kitty 键盘协议：为什么这里必须解析 `CSI u`
 *
 * 内层一 push kitty 键盘标志，`^G` 就**不再是字节 0x07**。实测 claude 2.1.260 启动时发
 * `CSI > 5 u`（标志 1|4 = 消歧 + 上报备用键码），而协议规定这之后 `ctrl+key` 一律改走
 * `CSI u` 形式 —— Ctrl+G 变成 `ESC [ 103 ; 5 u`，Ctrl+C 变成 `ESC [ 99 ; 5 u`。
 * 只认 0x07 的路由器会把整条序列原样转发下去，于是内层收到一个货真价实的 Ctrl+G，
 * **打开外部编辑器** —— 就是用户报的那个"^G 还是会进一个编辑界面"。同一个机制也悄悄
 * 废掉了上面"Ctrl+C 无条件转发给内层"那条保证（它变成了一条谁都不认的转义序列）。
 *
 * 所以这里破例做了一个 stdin 侧解析器，但**只窄到能修这条 bug**：只认 `ESC [ <数字;:> u`，
 * 只拦 ctrl+g 和 ctrl+c 两个键，其余一概原样转发。范围窄是安全前提 —— 文件头说过，
 * stdin 侧解析器的失败模式是吃掉用户的按键。
 *
 * 另一条路是**抑制**内层的标志（不转发它那条 `CSI > 5 u`），^G 就还是 0x07。没走，
 * 因为那会连带废掉 Shift+Enter、Alt+方向键这些只有 kitty 编码才区分得出来的键 ——
 * 内层的输入保真度优先（计划里的 P11：内层吞吐永远优先于游戏）。
 */
/** 扣住的半截序列上限。超了就当畸形原样放行 —— 绝不让扣在手里的缓冲无界增长。 */
const MAX_HOLD = 24;
/** 修饰键自己的 code 区间（左右 shift/ctrl/alt/super/hyper/meta/iso）。 */
function isModifierOnly(code) {
    return code >= 57441 && code <= 57452;
}
/** 第 `i` 个分号段的第 `sub` 个冒号子参数。空/缺省返回 undefined。 */
function subParam(params, i, sub) {
    const seg = params.split(';')[i];
    if (seg === undefined)
        return undefined;
    const part = seg.split(':')[sub];
    if (part === undefined || part === '')
        return undefined;
    return Number(part);
}
function parseKitty(params) {
    const code = subParam(params, 0, 0);
    if (code === undefined)
        return null;
    const mods = subParam(params, 1, 0) ?? 1;
    return {
        code,
        ctrl: ((mods - 1) & 4) !== 0,
        alt: ((mods - 1) & 2) !== 0,
        event: subParam(params, 1, 1) ?? 1,
    };
}
/**
 * ctrl+字母 在 `CSI u` 里是"字母的码位 + ctrl 标志"，这里换算回它对应的控制字节。
 * 换回来之后 kitty 编码和裸字节就能共用下面那张单字节命令表，不用维护两份。
 */
function ctrlByte(key) {
    if (!key.ctrl || key.alt)
        return null;
    if (key.code < 0x40 || key.code > 0x7f)
        return null;
    return key.code & 0x1f;
}
/**
 * 从 `at`（一个 ESC）处扫一条转义序列。两条取舍是刻意的：
 *
 * - **末尾的裸 ESC 绝不扣住**。ESC 是内层的中断键，晚一个 chunk 到比偶尔认错一次严重得多。
 * - **ESC 后面跟控制字节的不算序列**。`ESC` `0x07`（先按 Esc 再按 Ctrl+G，凑在一个 chunk 里）
 *   必须还是"Esc + 前缀键"；当成一条两字节序列转发出去就等于把 0x07 送进了内层。
 */
function scanEsc(buf, at) {
    const next = buf[at + 1];
    if (next === undefined || next < 0x20)
        return null;
    if (next !== 0x5b) {
        // 不是 CSI。SS3（`ESC O A`，应用键盘模式下的方向键）是三字节，其余按两字节算。
        // 这个长度只在"等命令"状态下有用（要整条吃掉，不能只吃 ESC 把 `OA` 当文字漏给内层）；
        // 转发路径上吐出去的字节和逐字节转发完全一样。
        if (next === 0x4f && buf[at + 2] !== undefined)
            return { end: at + 3, key: null };
        return { end: at + 2, key: null };
    }
    let j = at + 2;
    while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f)
        j++; // 参数字节（含私有前缀）
    const paramEnd = j;
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x2f)
        j++; // 中间字节
    if (j >= buf.length)
        return j - at <= MAX_HOLD ? 'partial' : null;
    const end = j + 1;
    if (buf[j] !== 0x75)
        return { end, key: null }; // 不是 `u` 收尾，不是我们的事
    let params = '';
    for (let k = at + 2; k < paramEnd; k++)
        params += String.fromCharCode(buf[k]);
    // `CSI > … u` / `CSI < u` / `CSI ? u` 是发给**终端**的标志操作，不是按键上报；
    // 终端对查询的回复（`CSI ? flags u`）也长这样，得原样交回给发起查询的内层。
    if (/[<=>?]/.test(params))
        return { end, key: null };
    return { end, key: parseKitty(params) };
}
const EMPTY = new Uint8Array(0);
function join(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
export class InputRouter {
    focus;
    /** 上一个键是前缀键，正在等命令。跨 read 保持 —— 前缀和命令完全可能分在两次读里。 */
    awaiting = false;
    /** 扣在手里的半截 CSI，下一个 chunk 到了拼回去。见 `scanEsc`。 */
    held = EMPTY;
    constructor(opts = {}) {
        this.focus = opts.focus ?? 'cli';
    }
    get awaitingCommand() {
        return this.awaiting;
    }
    /** 手里扣着的半截序列字节数。给测试看的 —— 它必须在下一个 chunk 里被吐出去。 */
    get heldBytes() {
        return this.held.length;
    }
    /**
     * 路由一个 chunk。返回按顺序执行的动作列表。
     *
     * 相邻的转发字节会被合并成一个动作 —— 一次 write 比 N 次便宜，而且内层看到的
     * 分块边界越少越好（它自己也在做转义序列的跨块拼接）。
     */
    route(chunk) {
        const buf = this.held.length === 0 ? chunk : join(this.held, chunk);
        this.held = EMPTY;
        const actions = [];
        let runStart = -1;
        const flushRun = (end) => {
            if (runStart < 0 || end <= runStart) {
                runStart = -1;
                return;
            }
            const bytes = buf.subarray(runStart, end);
            // Ctrl+C 在这一段里也无所谓：整段的归属只看焦点，而 0x03 的特判在下面单独做。
            actions.push(this.focus === 'game' ? { kind: 'game', bytes } : { kind: 'forward', bytes });
            runStart = -1;
        };
        let i = 0;
        while (i < buf.length) {
            const b = buf[i];
            // ── 转义序列：整条一起判归属，绝不逐字节判 ──────────────────────
            if (b === 0x1b) {
                const s = scanEsc(buf, i);
                if (s === 'partial') {
                    flushRun(i);
                    this.held = buf.slice(i); // 只可能在 chunk 末尾，所以后面没有漏掉的字节
                    return actions;
                }
                if (s !== null) {
                    const act = this.escSeq(s.key);
                    if (act === 'pass') {
                        if (runStart < 0)
                            runStart = i;
                    }
                    else {
                        flushRun(i);
                        if (act === 'inner')
                            actions.push({ kind: 'forward', bytes: buf.subarray(i, s.end) });
                        else if (act !== 'drop')
                            actions.push(act);
                    }
                    i = s.end;
                    continue;
                }
                // scanEsc 说这不算一条序列（末尾的裸 ESC、ESC 后面跟控制字节）：ESC 自己按普通字节走。
            }
            if (this.awaiting) {
                this.awaiting = false;
                const cmd = command(b);
                if (cmd === 'unknown') {
                    // 未知命令：什么都不做，也**不**把这个字节透给内层。
                    // 透过去的话手滑按错就会往对话框里插一个随机字符，比静默丢弃烦人得多。
                }
                else {
                    actions.push(cmd);
                }
                i++;
                continue;
            }
            if (b === PREFIX) {
                flushRun(i);
                this.awaiting = true;
                i++;
                continue;
            }
            // Ctrl+C：不管焦点在哪都给内层。
            if (b === 0x03 && this.focus === 'game') {
                flushRun(i);
                actions.push({ kind: 'forward', bytes: Uint8Array.of(0x03) });
                i++;
                continue;
            }
            if (runStart < 0)
                runStart = i;
            i++;
        }
        flushRun(buf.length);
        return actions;
    }
    /**
     * 一条完整转义序列的归属。`key` 为空 = 不是 kitty 按键上报（方向键、F 键、终端的查询回复……）。
     *
     * - `'pass'`：进转发流，和前后的普通字节合并成一次写
     * - `'drop'`：吃掉，谁都不给
     * - `'inner'`：把**原始字节**无条件给内层（Ctrl+C —— 内层在 kitty 模式里，它认的是这个形式）
     * - Action：直接执行
     */
    escSeq(key) {
        if (this.awaiting) {
            // 等命令状态下，一整条序列算**一个**键。修饰键自己和重复/松开事件不算键 ——
            // 它们不能消费掉等命令状态（按住 Shift 去按 '+' 时修饰键先到，一消费掉命令就丢了）。
            if (key !== null && (isModifierOnly(key.code) || key.event !== 1))
                return 'drop';
            this.awaiting = false;
            if (key === null)
                return 'drop'; // 不认识的序列 = 按错了，整条丢掉（不能只丢 ESC）
            const cmd = command(ctrlByte(key) ?? key.code);
            return cmd === 'unknown' ? 'drop' : cmd;
        }
        if (key === null)
            return 'pass';
        const ctl = ctrlByte(key);
        if (ctl === PREFIX) {
            // 前缀键：整条吃掉（漏一个字节进内层就是打开外部编辑器），只有按下事件进等命令状态。
            // 自动重复/松开也吃掉但不重复触发 —— 按住 ^G 不该反复切焦点。
            if (key.event === 1)
                this.awaiting = true;
            return 'drop';
        }
        if (ctl === 0x03)
            return 'inner';
        if (this.focus === 'game' && ctl === null && !key.alt
            && key.event !== 3 && key.code >= 0x20 && key.code <= 0x7e) {
            // 内层要是 push 了"所有按键都报转义码"（标志 8），连字母也走 CSI u。游戏那层输入
            // 只认裸字节，所以在这儿换回去 —— 不换的话标志 8 下游戏是完全没有输入的。
            return { kind: 'game', bytes: Uint8Array.of(key.code) };
        }
        return 'pass';
    }
}
/**
 * HUD 上那行提示。字符串写在这里，免得散落在渲染代码里。
 *
 * **必须压到 30 列以内**：游戏条只有 1~2 行，HUD 文本挤在画布右边那点地方，
 * 长一个字就被截断，而被截断的热键提示等于没有提示。所以这里只留最要紧的三条，
 * 完整的命令表在按下前缀之后才展开（见 `pendingRows`）。
 *
 * `^G g` 里那个 `g` **必须写出来**：写成 `^G 切焦点` 会让人以为单按一次就切，
 * 按下去没反应就会再按一次 —— 那正是把字面 `^G` 送进内层的那条老路。
 */
export function hotkeyHint(focus) {
    return focus === 'game'
        ? '砍 J · 走 A/D · ^G g 回 CLI'
        : '^G g 玩 · ^G h 收起 · ^G q 退';
}
/**
 * 按下前缀、正在等命令时的提示。有它才知道"按了有反应"。
 *
 * 分成两行是因为一行放不下 —— 而这条提示恰好是**最不能被截断**的那条：
 * 它出现的那一刻用户正悬在半个命令上，看不到完整的选项就会乱按。
 */
export function pendingRows() {
    return ['^G … g 切焦点 · h 收起/展开', '+/- 高度 · r 重绘 · q 退出'];
}
/** 单行版（窄条形宿主用 `pendingRows`，这里给日志和测试留一个可读的整体）。 */
export function pendingHint() {
    return pendingRows().join(' · ');
}
