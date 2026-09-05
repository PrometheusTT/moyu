/**
 * `moyu demo` —— 整屏跑游戏本身。
 *
 * 存在的理由是**调手感**：外壳（`moyu -- claude`）里游戏只有下半屏，而且屏幕上还有
 * 另一个程序在动，看不清自己写的动画到底对不对。整屏版是同一份模拟 + 同一份渲染，
 * 只是矩形更大 —— 在这里调好的东西，装进下半屏就是对的。
 *
 * 用**备用屏**：玩完之后用户的滚动历史一个字都不少。还原由 `Teardown` 统一负责，
 * 所以 Ctrl+C / 崩溃 / SIGTERM 都不会把终端留在 raw + 无光标的状态里。
 */

import { Canvas } from '../render/canvas.ts';
import { paintWorldTo } from '../render/scene.ts';
import { fitRow } from '../render/text.ts';
import { Teardown } from '../shell/teardown.ts';
import { Game, TITLE } from './game.ts';

const FPS = 30;
const FRAME_MS = 1000 / FPS;
/** 小于这个尺寸就没法玩了（火柴人会矮到看不出四肢）。 */
const MIN_COLS = 40;
const MIN_ROWS = 8;

const SGR_HUD = '\x1b[38;2;158;166;188m\x1b[48;2;24;26;36m';
/** 任务完成的横幅：红底。它的任务是**打断摸鱼**，所以必须比 HUD 显眼一个数量级。 */
const SGR_BANNER = '\x1b[38;2;255;238;238m\x1b[48;2;138;22;30m';

export async function cmdDemo(seed?: number): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(`moyu demo 需要一个真终端（现在 stdin/stdout 不是 TTY）。\n${TITLE}\n`);
    return 2;
  }
  return new Demo(seed).run();
}

class Demo {
  private readonly game: Game;
  private readonly canvas = new Canvas(80, 1);
  private readonly teardown: Teardown;
  private timer: NodeJS.Timeout | null = null;
  private resolve: ((code: number) => void) | null = null;
  private finished = false;
  private tooSmall = false;
  private toldSmall = false;

  constructor(seed?: number) {
    this.game = seed === undefined ? new Game() : new Game({ seed });
    // 备用屏上退出：`?1049l` 自己会把主屏和光标恢复，所以不给 homeRow ——
    // 给了反而会在**主屏**上从光标处往下擦，那是用户的滚动历史。
    this.teardown = new Teardown(() => ({}));
  }

  async run(): Promise<number> {
    process.stdout.on('error', () => { /* 终端没了，交给还原路径 */ });
    this.teardown.install();
    this.teardown.onRestore(() => { this.stop(); });
    this.teardown.onRestore(() => { try { process.stdin.setRawMode(false); } catch { /* 已经不是 TTY */ } });

    // 顺序：进备用屏 → 清屏 → 关自动换行 → 藏光标。
    // 关自动换行是必须的：画布最后一格就是屏幕右下角，开着 DECAWM 的话
    // 写它会置上延迟换行标志，下一个可打印字符就会把整屏顶上去一行。
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?7l\x1b[?25l');
    this.layout();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b: Buffer) => {
      if (this.game.feed(b)) this.finish(0);
    });
    process.stdout.on('resize', () => { this.layout(); });

    this.timer = setInterval(() => { this.frame(); }, FRAME_MS);
    this.timer.unref();
    return new Promise<number>((r) => { this.resolve = r; });
  }

  /** 第 1 行是 HUD 文本，剩下的全给画布。 */
  private layout(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    this.tooSmall = cols < MIN_COLS || rows < MIN_ROWS;
    if (this.tooSmall) { this.toldSmall = false; return; }
    this.canvas.resize(cols, rows - 1);
    this.canvas.invalidate();
    this.game.resize(this.canvas.cols, this.canvas.pixelHeight);
    process.stdout.write('\x1b[2J');
  }

  private frame(): void {
    if (this.finished) return;
    if (this.tooSmall) {
      if (!this.toldSmall) {
        this.toldSmall = true;
        process.stdout.write(`\x1b[2J\x1b[1;1H终端太小了（至少 ${MIN_COLS}×${MIN_ROWS}）。放大窗口就自动开始。`);
      }
      return;
    }
    this.game.advance(Date.now());

    const w = this.game.world;
    paintWorldTo(this.canvas, w);

    const cols = this.canvas.cols;
    const h = this.game.hud();
    const sgr = h.urgent ? SGR_BANNER : SGR_HUD;
    const hud = `\x1b[1;1H${sgr}${fitRow(h.left, h.right, cols)}\x1b[0m`;
    // 一次 write：HUD 和画布必须同一帧到达，不然横幅会比清屏技早/晚一帧，看着像 bug。
    process.stdout.write((this.game.takeAlert() ?? '') + hud + this.canvas.encode(2));
  }

  private stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();
    this.teardown.run();
    const r = this.resolve;
    this.resolve = null;
    r?.(code);
  }
}
