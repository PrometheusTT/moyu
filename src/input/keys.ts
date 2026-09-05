/**
 * 按键 → 意图。终端输入的根本问题是**没有"松开"事件**，所以"按住往右走"必须靠 latch 猜。
 *
 * ## latch 的两档窗口（这是手感的全部）
 *
 * 终端只在按下和**自动重复**时给字节。macOS 的自动重复是"首次延迟 ~250–500ms，
 * 之后每 ~35ms 一次"。所以：
 *
 *   - **第一次**按下给一个长窗口（`FIRST_MS`，340ms）：它要**桥过首次延迟**那段空白，
 *     否则按住不动的头 0.3 秒会先走一步、停一下、再接着走 —— 一顿一顿的。
 *   - 一旦进到重复流里（上一个窗口还没过期就又来了字节），窗口收紧到 `HOLD_MS`（150ms）：
 *     这时候字节每 35ms 就来一个，窗口只需要覆盖一个间隔，松手才跟手。
 *
 * 150ms 是**下限**，不是调出来的数：自动重复间隔本身就在这个量级，再小就会把
 * "按住"误判成"松开又按下"。想要真正的按住/松开，只有 kitty 键盘协议（tmux 不透传），
 * 那是外壳层的事，这里必须在没有它的情况下也能玩。
 *
 * 跳和砍是**脉冲**（按一次算一次，被读走就清掉），所以点按精确、按住则由动作自身的
 * 时长和冷却决定节奏 —— 不需要为"连按"和"按住"写两套逻辑。
 */

import type { Intent } from '../core/world.ts';

const FIRST_MS = 340;
const HOLD_MS = 150;

/** 不属于"操作角色"的按键，交给 app 处理。 */
export type Cmd = 'quit' | 'task-done' | 'task-start' | 'redraw';

export class Keys {
  /**
   * 转义序列的状态，**跨 chunk 保留**。
   *
   * 必须有这个：终端会往 stdin 里塞回复（DA `ESC [ ? 1 ; 2 c`、CPR `ESC [ 24 ; 80 R`、
   * 鼠标 `ESC [ < 0 ; 30 ; 10 M`、OSC 11 背景色 `ESC ] 11 ; rgb:2e2e/.. ST`），
   * 而这些载荷里全是 `;`、数字和十六进制字母 —— `;` 是砍、`a`/`d` 是左右、`f` 是砍。
   * 不整段跳过的话，光是查一次背景色就能让角色自己挥刀乱走。
   */
  private st: 'ground' | 'esc' | 'seq' | 'str' = 'ground';
  private leftUntil = 0;
  private rightUntil = 0;
  private jumpPulse = false;
  private slashPulse = false;
  /** 最后按下的方向：同时按住左右时听后按的那个，而不是互相抵消变成站着不动。 */
  private lastDir: -1 | 1 = 1;

  /** 喂一段原始字节，返回其中的非操作命令。`now` 用 `Date.now()`。 */
  feed(bytes: Uint8Array, now: number): Cmd[] {
    const cmds: Cmd[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;

      // ── 转义序列：整段跳过，只从里面挑出方向键 ──
      if (this.st === 'seq') {
        // 参数/中间字节（0x20–0x3f）继续攒，终结字节（0x40–0x7e）收尾。
        if (b >= 0x40 && b <= 0x7e) {
          this.st = 'ground';
          if (b === 0x41) this.press('jump', now);         // ↑（带修饰键的 `ESC [ 1;5A` 也算）
          else if (b === 0x43) this.press('right', now);   // →
          else if (b === 0x44) this.press('left', now);    // ←
        } else if (b === 0x1b) {
          this.st = 'esc';
        }
        continue;
      }
      if (this.st === 'str') {
        // OSC/DCS 载荷。BEL 收尾；裸 ESC 也终结字符串（和 passthrough 的判断一致）。
        if (b === 0x07) this.st = 'ground';
        else if (b === 0x1b) this.st = 'esc';
        continue;
      }
      if (this.st === 'esc') {
        this.st = b === 0x5b || b === 0x4f ? 'seq'          // CSI / SS3
          : b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f ? 'str'  // OSC/DCS/SOS/PM/APC
            : 'ground';                                     // `ESC 7` 这类单字节序列：丢掉
        continue;
      }
      if (b === 0x1b) {
        this.st = 'esc';
        continue;
      }

      switch (b) {
        case 0x03: cmds.push('quit'); break;                       // Ctrl+C
        case 0x71: cmds.push('quit'); break;                       // q
        case 0x61: case 0x68: this.press('left', now); break;      // a / h
        case 0x64: case 0x6c: this.press('right', now); break;     // d / l
        case 0x77: case 0x6b: case 0x20: this.press('jump', now); break;   // w / k / space
        case 0x6a: case 0x66: case 0x3b: this.press('slash', now); break;  // j / f / ;
        case 0x74: cmds.push('task-done'); break;                  // t：假信号，任务完成
        case 0x79: cmds.push('task-start'); break;                 // y：假信号，任务开始
        case 0x12: cmds.push('redraw'); break;                     // Ctrl+R
        default: break;
      }
    }
    return cmds;
  }

  private press(k: 'left' | 'right' | 'jump' | 'slash', now: number): void {
    switch (k) {
      case 'left':
        this.leftUntil = now + (now < this.leftUntil ? HOLD_MS : FIRST_MS);
        this.lastDir = -1;
        break;
      case 'right':
        this.rightUntil = now + (now < this.rightUntil ? HOLD_MS : FIRST_MS);
        this.lastDir = 1;
        break;
      case 'jump': this.jumpPulse = true; break;
      case 'slash': this.slashPulse = true; break;
    }
  }

  /** 取这一帧的意图。**会清掉脉冲** —— 一次按下只算一次。 */
  intent(now: number): Intent {
    const l = now < this.leftUntil;
    const r = now < this.rightUntil;
    const move: -1 | 0 | 1 = l && r ? this.lastDir : l ? -1 : r ? 1 : 0;
    const it: Intent = { move, jump: this.jumpPulse, slash: this.slashPulse };
    this.jumpPulse = false;
    this.slashPulse = false;
    return it;
  }

  /** 焦点离开游戏 / 暂停时用：别让 latch 里残留的方向让角色自己走。 */
  clear(): void {
    this.st = 'ground';
    this.leftUntil = 0;
    this.rightUntil = 0;
    this.jumpPulse = false;
    this.slashPulse = false;
  }
}
