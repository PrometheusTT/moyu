/** Legacy terminals have no key-up: bridge the initial repeat delay, then stop promptly. */
export const FIRST_DIRECTION_MS = 550;
export const REPEAT_DIRECTION_MS = 150;
export class DirectionHold {
    key = '';
    started = 0;
    last = 0;
    repeating = false;
    press(key, until, now) {
        if (key !== this.key || now >= until || now < this.last) {
            this.key = key;
            this.started = this.last = now;
            this.repeating = false;
            return now + FIRST_DIRECTION_MS;
        }
        // Batched bytes / quick double taps must not cut short the initial grace period.
        if (now > this.last && (this.repeating || now - this.started >= 180))
            this.repeating = true;
        this.last = now;
        return this.repeating ? now + REPEAT_DIRECTION_MS : Math.max(until, now + REPEAT_DIRECTION_MS);
    }
    interrupt() { this.key = ''; this.repeating = false; }
}
export class Keys {
    /**
     * 转义序列的状态，**跨 chunk 保留**。
     *
     * 必须有这个：终端会往 stdin 里塞回复（DA `ESC [ ? 1 ; 2 c`、CPR `ESC [ 24 ; 80 R`、
     * 鼠标 `ESC [ < 0 ; 30 ; 10 M`、OSC 11 背景色 `ESC ] 11 ; rgb:2e2e/.. ST`），
     * 而这些载荷里全是 `;`、数字和十六进制字母 —— `;` 是砍、`a`/`d` 是左右、`f` 是砍。
     * 不整段跳过的话，光是查一次背景色就能让角色自己挥刀乱走。
     */
    st = 'ground';
    directionHold = new DirectionHold();
    leftUntil = 0;
    rightUntil = 0;
    jumpPulse = false;
    slashPulse = false;
    /** 最后按下的方向：同时按住左右时听后按的那个，而不是互相抵消变成站着不动。 */
    lastDir = 1;
    /** 喂一段原始字节，返回其中的非操作命令。`now` 用 `Date.now()`。 */
    feed(bytes, now) {
        const cmds = [];
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            // ── 转义序列：整段跳过，只从里面挑出方向键 ──
            if (this.st === 'seq') {
                // 参数/中间字节（0x20–0x3f）继续攒，终结字节（0x40–0x7e）收尾。
                if (b >= 0x40 && b <= 0x7e) {
                    this.st = 'ground';
                    if (b === 0x41)
                        this.press('jump', now); // ↑（带修饰键的 `ESC [ 1;5A` 也算）
                    else if (b === 0x43)
                        this.press('right', now); // →
                    else if (b === 0x44)
                        this.press('left', now); // ←
                }
                else if (b === 0x1b) {
                    this.st = 'esc';
                }
                continue;
            }
            if (this.st === 'str') {
                // OSC/DCS 载荷。BEL 收尾；裸 ESC 也终结字符串（和 passthrough 的判断一致）。
                if (b === 0x07)
                    this.st = 'ground';
                else if (b === 0x1b)
                    this.st = 'esc';
                continue;
            }
            if (this.st === 'esc') {
                this.st = b === 0x5b || b === 0x4f ? 'seq' // CSI / SS3
                    : b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f ? 'str' // OSC/DCS/SOS/PM/APC
                        : 'ground'; // `ESC 7` 这类单字节序列：丢掉
                continue;
            }
            if (b === 0x1b) {
                this.st = 'esc';
                continue;
            }
            switch (b) {
                case 0x03:
                    cmds.push('quit');
                    break; // Ctrl+C
                case 0x71:
                    cmds.push('quit');
                    break; // q
                case 0x61:
                case 0x68:
                    this.press('left', now);
                    break; // a / h
                case 0x64:
                case 0x6c:
                    this.press('right', now);
                    break; // d / l
                case 0x77:
                case 0x6b:
                case 0x20:
                    this.press('jump', now);
                    break; // w / k / space
                case 0x6a:
                case 0x66:
                case 0x3b:
                    this.press('slash', now);
                    break; // j / f / ;
                case 0x74:
                    cmds.push('task-done');
                    break; // t：假信号，任务完成
                case 0x79:
                    cmds.push('task-start');
                    break; // y：假信号，任务开始
                case 0x12:
                    cmds.push('redraw');
                    break; // Ctrl+R
                default: break;
            }
        }
        return cmds;
    }
    press(k, now) {
        switch (k) {
            case 'left':
                this.leftUntil = this.directionHold.press('left', this.leftUntil, now);
                this.rightUntil = 0;
                this.lastDir = -1;
                break;
            case 'right':
                this.rightUntil = this.directionHold.press('right', this.rightUntil, now);
                this.leftUntil = 0;
                this.lastDir = 1;
                break;
            case 'jump':
                this.directionHold.interrupt();
                this.jumpPulse = true;
                break;
            case 'slash':
                this.directionHold.interrupt();
                this.slashPulse = true;
                break;
        }
    }
    /** 取这一帧的意图。**会清掉脉冲** —— 一次按下只算一次。 */
    intent(now) {
        const l = now < this.leftUntil;
        const r = now < this.rightUntil;
        const move = l && r ? this.lastDir : l ? -1 : r ? 1 : 0;
        const it = { move, jump: this.jumpPulse, slash: this.slashPulse };
        this.jumpPulse = false;
        this.slashPulse = false;
        return it;
    }
    /** 焦点离开游戏 / 暂停时用：别让 latch 里残留的方向让角色自己走。 */
    clear() {
        this.directionHold.interrupt();
        this.st = 'ground';
        this.leftUntil = 0;
        this.rightUntil = 0;
        this.jumpPulse = false;
        this.slashPulse = false;
    }
}
