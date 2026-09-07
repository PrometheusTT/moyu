/**
 * 内层 CLI 的 PTY 宿主。
 *
 * 这一层薄到几乎透明，只做四件事：
 *   1. **懒加载** `@lydell/node-pty`。它是原生模块，但 `moyu demo` / `moyu doctor`
 *      根本不需要它 —— 加载失败时不该让这些独立命令一起起不来。
 *   2. **改正 .d.ts 的谎**。`onData` 被声明成 `IEvent<string>`，但 `encoding: null` 下实际给的是
 *      `Buffer`（已实测确认）。字节透传层要的是字节，所以在这里把类型摆正，让谎言只存在于一处。
 *   3. **尺寸控制**（TIOCSWINSZ）。整个同屏合成方案的支点：告诉内层"你只有 innerRows 行"，
 *      它就自己按小尺寸排版，我们一行坐标都不用换算。已实测：内层 `stty size` 返回我们给的值。
 *   4. **收尾**。SIGHUP 之后给个宽限期再 SIGKILL。
 */
import type { IPty } from '@lydell/node-pty';

export type PtyHostOptions = {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
};

export type PtyExit = { exitCode: number; signal?: number | undefined };

/** node-pty 的 `spawn` 签名里 `encoding` 是 `string | null`，但类型没体现 null 会改变 onData 的类型。 */
type PtyModule = {
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => IPty;
};

let cached: PtyModule | null = null;

/**
 * 加载原生模块。失败时给一条**可执行**的错误信息 —— 原生模块加载失败的默认报错
 * （找不到 .node 文件）对用户毫无意义。
 */
export async function loadPty(): Promise<PtyModule> {
  if (cached !== null) return cached;
  try {
    const mod = await import('@lydell/node-pty');
    cached = mod as unknown as PtyModule;
    return cached;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `无法加载 PTY 原生模块（@lydell/node-pty）：${detail}\n` +
      `外壳模式需要它。可以先用 \`moyu demo\` 玩全屏版本，或者跑 \`npm install\` 补上依赖。`,
    );
  }
}

export class PtyHost {
  private readonly pty: IPty;
  private killed = false;
  cols: number;
  rows: number;

  private constructor(pty: IPty, cols: number, rows: number) {
    this.pty = pty;
    this.cols = cols;
    this.rows = rows;
  }

  static async spawn(opts: PtyHostOptions): Promise<PtyHost> {
    const { spawn } = await loadPty();
    const cols = Math.max(1, Math.floor(opts.cols));
    const rows = Math.max(1, Math.floor(opts.rows));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env ?? process.env)) {
      if (v !== undefined) env[k] = v;
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

  get pid(): number {
    return this.pty.pid;
  }

  /** 内层输出。给的是 `Buffer`（`Uint8Array` 的子类），不是 .d.ts 声明的 string。 */
  onData(fn: (data: Uint8Array) => void): () => void {
    const d = (this.pty.onData as unknown as (l: (e: Uint8Array) => void) => { dispose(): void })(fn);
    return () => { d.dispose(); };
  }

  onExit(fn: (e: PtyExit) => void): () => void {
    const d = this.pty.onExit(fn);
    return () => { d.dispose(); };
  }

  /** 键盘输入原样喂给内层。 */
  write(data: Uint8Array | string): void {
    if (this.killed) return;
    try {
      (this.pty.write as unknown as (d: Uint8Array | string) => void)(data);
    } catch {
      // 内层已经死了但 onExit 还没派发到 —— 丢掉这次输入即可，不该炸整个进程。
    }
  }

  pause(): void {
    if (!this.killed) this.pty.pause();
  }

  resume(): void {
    if (!this.killed) this.pty.resume();
  }

  /** forkpty 的子进程是会话/进程组首进程；杀整组才能收掉它启动的工具和孙进程。 */
  private signalGroup(signal: NodeJS.Signals): void {
    try { process.kill(-this.pty.pid, signal); }
    catch { try { this.pty.kill(signal); } catch { /* 已退 */ } }
  }

  /**
   * 改尺寸 → 内层收到 SIGWINCH → 自己重排。
   *
   * 幂等：尺寸没变就不发，因为多余的 SIGWINCH 会让内层 TUI 无意义地全量重绘，
   * 而重绘的字节要挤我们和游戏共用的那条终端带宽。
   */
  resize(cols: number, rows: number): boolean {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (this.killed || (c === this.cols && r === this.rows)) return false;
    try {
      this.pty.resize(c, r);
      this.cols = c;
      this.rows = r;
      return true;
    } catch {
      return false;
    }
  }

  /** 直接请求 inline TUI 重绘被临时覆盖的行；只在关闭浮层时调用。 */
  refresh(): boolean {
    if (this.killed) return false;
    try { this.signalGroup('SIGWINCH'); return true; } catch { return false; }
  }

  /** 先 SIGHUP 给内层机会自己收拾，宽限期后 SIGKILL。 */
  kill(graceMs = 250): void {
    if (this.killed) return;
    this.killed = true;
    const pid = this.pty.pid;
    this.signalGroup('SIGHUP');
    if (graceMs <= 0) return;
    const t = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); }
      catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 正常退了 */ } }
    }, graceMs);
    t.unref();
  }

  /** 同步收尾用（`process.on('exit')` 里没法等 timer）。 */
  killNow(): void {
    if (this.killed) { this.signalGroup('SIGKILL'); return; }
    this.killed = true;
    // 退出钩子是同步的，不能留一个 unref timer 等宽限期；先给清理信号，再确保整组消失。
    this.signalGroup('SIGHUP');
    this.signalGroup('SIGKILL');
  }
}
