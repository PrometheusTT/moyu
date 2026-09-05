let cached = null;
/**
 * 加载原生模块。失败时给一条**可执行**的错误信息 —— 原生模块加载失败的默认报错
 * （找不到 .node 文件）对用户毫无意义。
 */
export async function loadPty() {
    if (cached !== null)
        return cached;
    try {
        const mod = await import('@lydell/node-pty');
        cached = mod;
        return cached;
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`无法加载 PTY 原生模块（@lydell/node-pty）：${detail}\n` +
            `外壳模式需要它。可以先用 \`moyu play\` 玩全屏版本，或者跑 \`npm install\` 补上依赖。`);
    }
}
export class PtyHost {
    pty;
    killed = false;
    cols;
    rows;
    constructor(pty, cols, rows) {
        this.pty = pty;
        this.cols = cols;
        this.rows = rows;
    }
    static async spawn(opts) {
        const { spawn } = await loadPty();
        const cols = Math.max(1, Math.floor(opts.cols));
        const rows = Math.max(1, Math.floor(opts.rows));
        const env = {};
        for (const [k, v] of Object.entries(opts.env ?? process.env)) {
            if (v !== undefined)
                env[k] = v;
        }
        // LINES / COLUMNS 会被一些程序优先于 ioctl 采信，那就绕过了我们的尺寸控制。
        delete env.LINES;
        delete env.COLUMNS;
        // 给内层（和它触发的 hook）一个能识别"我在 moyu 里面"的标志。
        env.MOYU_SHELL = '1';
        const p = spawn(opts.file, opts.args, {
            cols,
            rows,
            cwd: opts.cwd ?? process.cwd(),
            env,
            // 关键：null = 不解码，onData 给 Buffer。透传层必须拿到原始字节，
            // 因为按 UTF-8 解码再编码会改写非法字节序列，而内层完全可以合法地输出它们。
            encoding: null,
            name: env.TERM ?? 'xterm-256color',
            // 流控关掉：我们自己不发 XON/XOFF，而开着它会让内层输出里偶然出现的
            // 0x11/0x13 被吞掉（node-pty 的匹配是整块匹配，但没必要留这个风险）。
            handleFlowControl: false,
        });
        return new PtyHost(p, cols, rows);
    }
    get pid() {
        return this.pty.pid;
    }
    /** 内层输出。给的是 `Buffer`（`Uint8Array` 的子类），不是 .d.ts 声明的 string。 */
    onData(fn) {
        const d = this.pty.onData(fn);
        return () => { d.dispose(); };
    }
    onExit(fn) {
        const d = this.pty.onExit(fn);
        return () => { d.dispose(); };
    }
    /** 键盘输入原样喂给内层。 */
    write(data) {
        if (this.killed)
            return;
        try {
            this.pty.write(data);
        }
        catch {
            // 内层已经死了但 onExit 还没派发到 —— 丢掉这次输入即可，不该炸整个进程。
        }
    }
    /**
     * 改尺寸 → 内层收到 SIGWINCH → 自己重排。
     *
     * 幂等：尺寸没变就不发，因为多余的 SIGWINCH 会让内层 TUI 无意义地全量重绘，
     * 而重绘的字节要挤我们和游戏共用的那条终端带宽。
     */
    resize(cols, rows) {
        const c = Math.max(1, Math.floor(cols));
        const r = Math.max(1, Math.floor(rows));
        if (this.killed || (c === this.cols && r === this.rows))
            return false;
        try {
            this.pty.resize(c, r);
            this.cols = c;
            this.rows = r;
            return true;
        }
        catch {
            return false;
        }
    }
    /** 先 SIGHUP 给内层机会自己收拾，宽限期后 SIGKILL。 */
    kill(graceMs = 250) {
        if (this.killed)
            return;
        this.killed = true;
        const pid = this.pty.pid;
        try {
            this.pty.kill('SIGHUP');
        }
        catch { /* 已经没了 */ }
        if (graceMs <= 0)
            return;
        const t = setTimeout(() => {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch { /* 正常退了 */ }
        }, graceMs);
        t.unref();
    }
    /** 同步收尾用（`process.on('exit')` 里没法等 timer）。 */
    killNow() {
        if (this.killed) {
            try {
                process.kill(this.pty.pid, 'SIGKILL');
            }
            catch { /* 已退 */ }
            return;
        }
        this.killed = true;
        try {
            this.pty.kill('SIGHUP');
        }
        catch { /* 已退 */ }
    }
}
