/**
 * 任务信号桥。游戏靠它知道"外面那个 AI 在干活 / 干完了"。
 *
 * ## 为什么是"一个追加写的文本文件"而不是 socket / HTTP
 *
 *   - **hook 里付不起 Node 启动成本**（~40ms × 每次工具调用），所以写入端必须是一行 shell。
 *   - 游戏没开的时候事件**照样攒着**，开起来就能看到"上一个任务已经完成了"。
 *     socket 在没人监听时直接丢事件。
 *   - `cat` 就能调试。这一条在事件流出问题时值很多钱。
 *
 * 格式故意退化到极致：一行一个事件，`<epoch> <kind>`，读的时候只取最后一个字段。
 * 不用 JSON 是因为写入端是 shell —— JSON 转义在 shell 里出错的概率远高于它带来的好处。
 *
 * ## 启动时**跳到文件末尾**
 *
 * 不这样做的话每次开游戏都会把历史事件重放一遍，开局就是一串清屏技。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Signal = 'start' | 'done' | 'notify';

export function eventsPath(): string {
  const p = process.env.MOYU_EVENTS;
  if (p !== undefined && p !== '') return p;
  return path.join(os.homedir(), '.moyu', 'events.log');
}

/** 写入端。`moyu signal <kind>` 用它，也给别的 CLI 做集成留了个出口。 */
export function appendSignal(kind: Signal, file = eventsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${Math.floor(Date.now() / 1000)} ${kind}\n`);
}

/** 增量跟读。轮询而不是 fs.watch —— 文件系统事件在 macOS 上会漏，而这里漏一个就卡住不动了。 */
export class SignalTail {
  private readonly file: string;
  private pos = 0;
  private rest = '';
  private lastSize = -1;

  constructor(file = eventsPath(), fromStart = false) {
    this.file = file;
    if (!fromStart) {
      try { this.pos = fs.statSync(this.file).size; } catch { this.pos = 0; }
    }
  }

  /** 读出上次调用以来的新事件。文件不存在、读不了都当"没有新事件"。 */
  poll(): Signal[] {
    let size: number;
    try { size = fs.statSync(this.file).size; } catch { return []; }
    if (size === this.lastSize && size === this.pos) return [];
    this.lastSize = size;
    // 被截断/轮转了（size 变小）：从头开始，别读到半行乱码。
    if (size < this.pos) { this.pos = 0; this.rest = ''; }
    if (size === this.pos) return [];

    let text: string;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const buf = Buffer.allocUnsafe(size - this.pos);
        const n = fs.readSync(fd, buf, 0, buf.length, this.pos);
        this.pos += n;
        text = buf.subarray(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return []; }

    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop() ?? '';
    const out: Signal[] = [];
    for (const raw of lines) {
      const parts = raw.trim().split(/\s+/);
      const k = parts[parts.length - 1];
      if (k === 'start' || k === 'done' || k === 'notify') out.push(k);
    }
    return out;
  }
}
