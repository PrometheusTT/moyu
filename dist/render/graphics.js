/**
 * 像素档 —— kitty graphics 协议，把 RGB 位图直接送给终端。
 *
 * ## 为什么必须有这一档
 *
 * 半块字符一格上下 2 个像素，输入框上方 2 行的条 = **4 个像素行**，反推出来的火柴人
 * 身高 3 像素、大腿 0.75 像素。四肢比一个像素还细，这不是姿势问题，是分辨率问题。
 * 同一条 2 行的窄条用这一档能拿到 **640 × 68 个设备像素**（视网膜格 16×34），
 * 竖直 17 倍、横向 16 倍 —— 火柴人从 3 像素变成 40 像素。
 *
 * ## 为什么每帧整幅重传，而不是只传变化的部分
 *
 * Ghostty **不支持动画帧**（`a=f` / `a=a`，维护者在 discussion #5218 / issue #5255 里确认），
 * 所以 kitty-doom 那套"传一次、之后只更新帧"的做法用不了。协议里规定：用**同一个
 * `i`+`p` 重传**就是原地替换，不闪烁，旧数据被顶掉也不泄漏 —— 这是这一档唯一可用的更新方式。
 *
 * 实测这样反而比字符档还便宜：一帧 640×68 的 RGB 原始 128 KB，deflate 等级 6 压到
 * 0.72~1.06 KB，加上 base64 和 APC 键是**线上 1.46 KB/帧**（30fps ≈ 44 KB/s），
 * 而已经验收过的全屏半块基线是 43 KB/s。便宜的原因是设计里本来就有的：调色板限定 +
 * 背景是平色，deflate 压平色位图的效率远高于逐格 SGR 文本。
 *
 * 顺带解掉一条美术约束：字符档的背景**只能是水平色带**（加一朵云会让每帧全脏，实测差
 * 14 倍）；这一档字节由 deflate 决定而不由"变了多少格"决定，云、视差、竖向震屏全部免费。
 *
 * ## 几个不能改的取舍
 *
 * - **`q=2` 是正确性要求，不是礼貌**：它抑制 OK 和错误回复。不抑制的话回复落在我们自己的
 *   stdin 上，被输入路由器当普通按键转发进内层的输入框里。
 * - **`o=z` 直接压 RGB，不用 PNG、不做索引化**：实测那一帧只有 13 种颜色，4bpp 打包后
 *   0.94 KB，和直接压 RGB 的 1.06 KB 没有差距 —— 不值得为此引一套调色板机器。
 * - **等级 6**：等级 1 是 1.7 倍字节只省 0.24 ms，等级 9 只再省 11% 却要 2.7 倍 CPU。
 * - **`c=` / `r=` 硬夹住占的格数**：探到的格像素尺寸万一过期（改字号那一拍），宁可让终端
 *   缩放糊一帧，也不能让图溢进上半屏 —— 那上面是用户的 CLI。
 * - **一帧一条 APC，必须一次 `write` 写完**，不能和光标还原的字节交错。
 */
import { deflateSync } from 'node:zlib';
/** 图片 id。固定一个就够 —— 我们只有一张图，每帧顶掉上一张。 */
export const IMAGE_ID = 19801;
/** 放置 id。同 `i`+`p` 重传 = 原地替换。 */
const PLACEMENT_ID = 1;
/** base64 **之后**的分块上限，协议规定 4096。 */
const CHUNK = 4096;
/**
 * 设备像素上限。超了就按整数倍降采样（格数不变，让终端放大回去）。
 *
 * 存在的理由：`^G +` 能把游戏区拉高，10 行 × 视网膜格就是 640×340。这一档的成本
 * 和像素数成正比（deflate + memcpy），没有这道闸，把条拉到半屏就会开始掉帧 ——
 * 而 P11 说内层吞吐永远优先，掉帧的代价是内层卡住。
 */
const MAX_PIXELS = 400_000;
const ESC = '\x1b';
const APC = `${ESC}_G`;
const ST = `${ESC}\\`;
export class GraphicsTarget {
    tier = 'graphics';
    cols;
    rows;
    lastBytes = 0;
    /** 一个字符格的设备像素（探测来的）。 */
    cellW;
    cellH;
    pw = 0;
    ph = 0;
    /** RGB888，长度补到 4 的倍数，好让整帧比较走 32 位。 */
    buf = new Uint8Array(0);
    prev = new Uint8Array(0);
    cur32 = new Uint32Array(0);
    prev32 = new Uint32Array(0);
    dirtyAll = true;
    /** 终端里现在存着我们的图吗（决定 `disposeSeq` 要不要发）。 */
    live = false;
    constructor(cols, rows, cellW, cellH) {
        this.cols = Math.max(1, cols);
        this.rows = Math.max(1, rows);
        this.cellW = Math.max(2, Math.round(cellW));
        this.cellH = Math.max(2, Math.round(cellH));
        this.alloc();
    }
    get pixelW() {
        return this.pw;
    }
    get pixelH() {
        return this.ph;
    }
    alloc() {
        let cw = this.cellW;
        let ch = this.cellH;
        // 降采样只按整数倍，避免把 1 个虚拟像素摊到 1.5 个设备像素上（会出摩尔纹似的锯齿）。
        for (let f = 1; f <= 8; f++) {
            cw = Math.max(2, Math.floor(this.cellW / f));
            ch = Math.max(2, Math.floor(this.cellH / f));
            if (this.cols * cw * this.rows * ch <= MAX_PIXELS)
                break;
        }
        this.pw = this.cols * cw;
        this.ph = this.rows * ch;
        const n = this.pw * this.ph * 3;
        const padded = n + ((4 - (n & 3)) & 3);
        this.buf = new Uint8Array(padded);
        this.prev = new Uint8Array(padded);
        this.cur32 = new Uint32Array(this.buf.buffer, 0, padded >> 2);
        this.prev32 = new Uint32Array(this.prev.buffer, 0, padded >> 2);
        this.dirtyAll = true;
    }
    resize(cols, rows) {
        const c = Math.max(1, cols);
        const r = Math.max(1, rows);
        if (c === this.cols && r === this.rows)
            return;
        this.cols = c;
        this.rows = r;
        this.alloc();
    }
    invalidate() {
        this.dirtyAll = true;
    }
    fill(color) {
        this.fillRect(0, 0, this.pw, this.ph, color);
    }
    /** 先铺满第一行，再整行复制 —— 背景占每帧七成以上的像素，这是最热的一个循环。 */
    fillRect(x, y, w, h, color) {
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        const x1 = Math.min(this.pw, x + w);
        const y1 = Math.min(this.ph, y + h);
        if (x1 <= x0 || y1 <= y0)
            return;
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        const rowStart = (y0 * this.pw + x0) * 3;
        const bytes = (x1 - x0) * 3;
        for (let i = rowStart; i < rowStart + bytes; i += 3) {
            this.buf[i] = r;
            this.buf[i + 1] = g;
            this.buf[i + 2] = b;
        }
        for (let yy = y0 + 1; yy < y1; yy++) {
            const at = (yy * this.pw + x0) * 3;
            this.buf.copyWithin(at, rowStart, rowStart + bytes);
        }
    }
    setPixel(x, y, color) {
        if (x < 0 || x >= this.pw || y < 0 || y >= this.ph)
            return;
        const i = (y * this.pw + x) * 3;
        this.buf[i] = (color >> 16) & 0xff;
        this.buf[i + 1] = (color >> 8) & 0xff;
        this.buf[i + 2] = color & 0xff;
    }
    getPixel(x, y) {
        if (x < 0 || x >= this.pw || y < 0 || y >= this.ph)
            return 0;
        const i = (y * this.pw + x) * 3;
        return (this.buf[i] << 16) | (this.buf[i + 1] << 8) | this.buf[i + 2];
    }
    /** 整帧和上一帧一模一样吗。32 位比较，640×68 是 3.2 万次字比较 ≈ 0.03 ms。 */
    unchanged() {
        const a = this.cur32;
        const b = this.prev32;
        for (let i = 0; i < a.length; i++)
            if (a[i] !== b[i])
                return false;
        return true;
    }
    /**
     * 组一帧。`screenTop` 是图左上角该落在第几行（1 起）；**给 0 或负数 = 画在光标当前
     * 位置、不发定位**，`moyu doctor --gfx` 要的就是这个（它把图印在普通输出流里，
     * 那时候绝对行号是未知的，只能靠相对移动）。游戏里永远给绝对行。
     */
    encode(screenTop) {
        // 没动就一个字节都不发。静止的条（暂停、等任务）在这一档下是完全免费的。
        if (!this.dirtyAll && this.live && this.unchanged()) {
            this.lastBytes = 0;
            return '';
        }
        const raw = this.buf.subarray(0, this.pw * this.ph * 3);
        const b64 = deflateSync(raw, { level: 6 }).toString('base64');
        const keys = `a=T,f=24,s=${this.pw},v=${this.ph},o=z,i=${IMAGE_ID},p=${PLACEMENT_ID}`
            + `,c=${this.cols},r=${this.rows},q=2,C=1`;
        // 图落在光标处，所以先把光标放到游戏区左上角。`C=1` 让它别动光标（我们每帧本来
        // 也会显式还原，所以不依赖它，但发了更省事）。
        let out = screenTop > 0 ? `${ESC}[${screenTop};1H` : '';
        if (b64.length <= CHUNK) {
            out += `${APC}${keys};${b64}${ST}`;
        }
        else {
            // 分块：键只写在第一块，后续块只带 `m`（协议要求，多写终端会当错误）。
            for (let at = 0; at < b64.length; at += CHUNK) {
                const part = b64.slice(at, at + CHUNK);
                const more = at + CHUNK < b64.length ? 1 : 0;
                out += at === 0
                    ? `${APC}${keys},m=1;${part}${ST}`
                    : `${APC}m=${more};${part}${ST}`;
            }
        }
        this.prev.set(this.buf);
        this.dirtyAll = false;
        this.live = true;
        this.lastBytes = out.length; // 全是 ASCII，长度就是字节数
        return out;
    }
    /**
     * 删掉终端里存的图 + 它的放置。大写 `I` = 连图片数据一起释放（小写只删放置，
     * 数据会留在终端的显存里）。退出 / 收起游戏区 / 换档都必须发。
     */
    disposeSeq() {
        if (!this.live)
            return '';
        this.live = false;
        this.dirtyAll = true;
        return deleteImageSeq();
    }
}
/**
 * 同一条删图字节，但**无条件**。
 *
 * 退出路径（`shell/teardown.ts`）和 `moyu doctor --reset` 用它：那两处都不知道 —— 也不该知道 ——
 * 当前有没有一张图挂在终端里。SIGKILL 之后图是真的会留在那儿的，`--reset` 是唯一能收走它的手。
 */
export function deleteImageSeq() {
    return `${APC}a=d,d=I,i=${IMAGE_ID},q=2${ST}`;
}
