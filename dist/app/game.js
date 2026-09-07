/**
 * 把模拟 / 输入 / 信号 / HUD 文案拼成一个可以嵌到任何地方的东西。
 *
 * 存在的理由：这个游戏有**两个宿主** —— `moyu demo`（整屏，用来调手感）和
 * `moyu -- claude`（下半屏，真正的使用形态）。两边只有"画在哪个矩形里"不同，
 * 步进节奏、信号处理、HUD 文案必须是同一份代码，否则调好的手感只在其中一个里成立。
 *
 * 画布**不**归它管：两个宿主的画布尺寸和屏幕位置都不一样，那是宿主的事。
 */
import { World, NO_INTENT } from "../core/world.js";
import { Keys } from "../input/keys.js";
import { SignalTail } from "../bridge/signal.js";
/** 固定步长 60Hz。渲染是 30fps —— 两者解耦，掉帧不影响物理。 */
const STEP = 1 / 60;
/** 一帧最多补多少模拟时间。超过就丢掉，别追帧 —— 追帧会让角色一次跳过半个屏幕。 */
const MAX_CATCHUP = 0.25;
/** 信号文件的轮询间隔（帧）。8 帧 ≈ 0.27s，人感觉不到延迟，也不会去猛敲文件系统。 */
const POLL_EVERY = 8;
export const TITLE = '谁不想在Claude Code干活的时候酣畅淋漓地砍一顿火柴小人';
export class Game {
    world;
    keys = new Keys();
    tail;
    acc = 0;
    lastMs = 0;
    pollN = 0;
    /** 待发的响铃 / 桌面通知。宿主取走并写出去 —— 通知是 I/O，模拟层不做 I/O。 */
    alert = null;
    /** 上一次任务的战绩，暂停横幅要报。 */
    lastScore = 0;
    constructor(opts = {}) {
        this.world = new World(opts.seed ?? (Date.now() & 0x7fffffff));
        this.tail = opts.events === false ? null : new SignalTail(opts.eventsFile);
    }
    /** 宿主的画布尺寸变了。`h` 是**像素**行数（= canvas.pixelHeight）。 */
    resize(w, h) {
        this.world.resize(w, h);
    }
    /** 原始输入字节。返回 true 表示用户要退出。 */
    feed(bytes) {
        let quit = false;
        for (const cmd of this.keys.feed(bytes, Date.now())) {
            switch (cmd) {
                case 'quit':
                    quit = true;
                    break;
                case 'task-done':
                    this.signalDone('手动');
                    break;
                case 'task-start':
                    this.world.taskStart();
                    break;
                case 'redraw': break; // 宿主自己处理（它才知道怎么重画）
            }
        }
        return quit;
    }
    /** 推进到当前时刻。第一次调用只对时，不模拟。 */
    advance(nowMs) {
        if (this.lastMs === 0) {
            this.lastMs = nowMs;
            return;
        }
        let dt = (nowMs - this.lastMs) / 1000;
        this.lastMs = nowMs;
        if (dt > MAX_CATCHUP)
            dt = MAX_CATCHUP;
        if (this.tail !== null && ++this.pollN >= POLL_EVERY) {
            this.pollN = 0;
            for (const sig of this.tail.poll()) {
                if (sig === 'start')
                    this.world.taskStart();
                else
                    this.signalDone(sig === 'notify' ? '要你确认' : '任务完成');
            }
        }
        this.acc += dt;
        // 脉冲（跳/砍）只喂给第一个子步，方向键则整帧有效 —— 不然一次按下会在
        // 同一帧里被多个子步各算一次。
        let first = this.keys.intent(Date.now());
        const held = { move: first.move, jump: false, slash: false };
        while (this.acc >= STEP) {
            this.world.step(STEP, first ?? held);
            first = null;
            this.acc -= STEP;
        }
    }
    signalDone(why) {
        if (this.world.phase === 'clear' || this.world.phase === 'paused')
            return;
        this.lastScore = this.world.taskKills;
        this.world.taskDone();
        // 摸鱼摸过头错过下一步操作，这个产品就是负分 —— 所以响铃 + 桌面通知是必须的，
        // 不是锦上添花。OSC 9 不被支持的终端会忽略它，无害。
        // The legacy full-screen demo keeps its explicit notification. The coding shell uses
        // Arcade, whose task completion path is intentionally silent and only changes the bar.
        this.alert = `\x07\x1b]9;摸鱼：${why}（砍了 ${this.lastScore} 个）\x07`;
    }
    /** 取走待发的通知字节。 */
    takeAlert() {
        const a = this.alert;
        this.alert = null;
        return a;
    }
    /**
     * HUD 文案。`left`/`right` 给整屏宿主（`moyu demo`）按宽度对齐；
     * `short` 给窄条形宿主 —— 它的文本区只有 ~30 列，`left` 在那里会被截断。
     */
    hud() {
        const w = this.world;
        switch (w.phase) {
            case 'title':
                return { left: TITLE, right: 'J 砍 · A/D 走 · 空格 跳', short: '按 J 砍火柴小人', urgent: false };
            case 'clear':
                return { left: '★ 任务完成 —— 清屏技', right: `砍了 ${w.taskKills} 个`, short: '★ 任务完成！', urgent: true };
            case 'paused':
                return {
                    left: `★ 任务完成 · 本轮砍了 ${this.lastScore} 个 · 最高连击 ${w.bestCombo}`,
                    right: 'J 接着砍 · 等下一个任务',
                    short: `★ 完成 · 砍了 ${this.lastScore} 个`,
                    urgent: true,
                };
            case 'fight': {
                const hp = w.respawn > 0 ? '倒了' : `血 ${w.player.hp}/4`;
                const combo = w.combo >= 2 ? ` · 连击 ${w.combo}` : '';
                return {
                    left: `砍了 ${w.taskKills} 个${combo} · ${hp}`,
                    right: `t 完成 · q 退`,
                    short: `砍 ${w.taskKills}${w.combo >= 2 ? ` ×${w.combo}` : ''} · ${hp}`,
                    urgent: false,
                };
            }
        }
    }
}
export { NO_INTENT };
