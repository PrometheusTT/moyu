/**
 * 启动时的一次能力探测：这个终端能不能收 kitty graphics 的图，一个字符格是多少设备像素。
 *
 * ## 为什么必须问，不能猜
 *
 * 像素档的整个尺寸链条都挂在"一个格子多少像素"上：条是 40 格宽 × 2 格高，图要正好铺满
 * 那块矩形。猜错了小是浪费分辨率，猜错了大就**溢进上半屏** —— 那上面是用户的 CLI。
 * `c=`/`r=` 会让终端把图夹回指定的格数，所以猜小是安全的（糊一点），猜大也不会溢出，
 * 但两种都不如问一次准。
 *
 * ## 探测的回复必须由我们自己吞掉
 *
 * 回复走的是**我们的 stdin**，而 stdin 的另一头接着输入路由器 → 内层 CLI。不吞掉的话
 * `\x1b_Gi=31;OK\x1b\\` 会被当普通按键转发进 claude 的输入框，用户开局就看到一行乱码。
 * 所以探测**排在把 stdin 交给路由器之前**：自己装一个临时 listener，读到 DA 回复
 * （最后发的那条查询的回复）或者超时就收工，把认得出的回复挑掉，剩下的字节
 * （用户抢跑打的字）原样交还给宿主。
 *
 * 这样做的另一个好处是不需要在路由器里加"永久过滤器" —— 内层自己发的查询和终端给它的
 * 回复要照常各走各的，一个永久过滤器会把它们也吃掉。
 *
 * ## 降档规则
 *
 * | 情况 | 结果 | 为什么 |
 * |---|---|---|
 * | `$TMUX` / `$STY` | `half` | tmux / screen 不透传 APC（除非用户自己开了 allow-passthrough，不值得赌） |
 * | 探测没回 OK，但 env 认得出终端 | `graphics` | 见下面「为什么还留一条 env 认定」 |
 * | 探测没回 OK，env 也不认得 | `half` | 不支持，或者支持但不肯说 —— 都当不支持 |
 * | `$SSH_CONNECTION` | `graphics` 但 15fps | 带宽减半，手感的损失比糊一档小 |
 * | `MOYU_TIER=half\|graphics` | 强制 | 调试和 bench 用；`MOYU_CELL=16x34` 一起指定格像素 |
 *
 * （八分块档 R2 还没实现，所以这里的"降档"只有一级。它进来之后 tmux 那一行会指向它。）
 *
 * ## 为什么还留一条 env 认定
 *
 * 探测是**一次性的、有时限的、走 stdin 的**握手，链条上任何一环出问题（回复被别的
 * listener 吃掉、终端那一拍正忙、150ms 不够、用户开局就在打字把回复冲散）都表现为
 * 同一个结果：静默退到半块档。而半块档在出货尺寸（2 行 = 4 个像素行）上是**火柴人只有
 * 3 个像素高**，也就是用户看到的"垃圾像素版" —— 一次丢包换来的不是画质降一档，是不可用。
 *
 * 所以对**自报身份就足以确定支持 kitty graphics** 的那几个终端（kitty / Ghostty / WezTerm）
 * 留一条 env 兜底：探测没回话也照样走像素档，格像素用默认值（`c=`/`r=` 会把图夹回该占的
 * 格数，所以猜错不会溢进上半屏，只影响源位图分辨率 —— 见 `DEFAULT_CELL` 为什么往大猜）。误判的代价是终端把 base64 当文本打出来，而
 * 这三个终端只有被 tmux/screen 包着时才会那样 —— 那两个上面已经先拦掉了。
 */

import type { Tier } from './target.ts';

/** 探测用的图片 id。和出帧用的那个（`graphics.ts` 的 `IMAGE_ID`）刻意不同 —— 别互相顶掉。 */
const PROBE_ID = 31;

/**
 * 问不出来时的格像素。**猜大（视网膜）那一侧**，8×17 的两倍。
 *
 * 原来这里写的是 8×17，理由是"猜小是安全的那一侧" —— 那条理由只覆盖了溢出，而溢出
 * 两个方向都不会发生：`c=`/`r=` 已经把图夹死在 40×2 格里，猜错只改变**源位图的分辨率**。
 * 于是真正的取舍是这个，而它是不对称的：
 *
 *   猜小（真机是视网膜）→ 320×34 被放大 2 倍：糊、块状，细节直接少一半。**这就是用户报的那个"垃圾像素版"的另一半成因。**
 *   猜大（真机不是视网膜）→ 640×68 被缩小 2 倍：软一点（其实等于 2× 超采样），几何一点不差，
 *                          代价是 1.95 KB/帧、0.46 ms/帧 —— 而这正是计划里当作出货配置量过的那一行。
 *
 * 所以宁可多花 1 KB 也不要糊。真回答了的终端一律用它报的值（`use = envCell ?? got ?? DEFAULT_CELL`），
 * 这个常量只在"问了但没人答"的时候才生效。
 */
export const DEFAULT_CELL = { w: 16, h: 34 } as const;

export type Caps = {
  tier: Tier;
  /** 一个字符格的设备像素。 */
  cellW: number;
  cellH: number;
  /** 目标帧率。SSH 下减半。 */
  fps: number;
  /** 为什么是这一档。`moyu doctor --caps` 和调试 HUD 打这个。 */
  why: string;
  /** 探测期间读到的、**不是**我们的回复的字节。宿主要把它交回给输入路由器。 */
  leftover: Uint8Array;
};

/**
 * 三条查询一次写完。顺序有讲究：**DA（`CSI c`）放最后**当哨兵 —— 任何终端都认它，
 * 它的回复到了就说明前面两条要么已经回了、要么这辈子不会回。
 *
 * 探测用的 `a=q` **不能带 `q=2`**：那会把回复也一起抑制掉，等于自己把眼睛蒙上。
 * （出帧用的 APC 才带 `q=2`，见 `graphics.ts`。）
 */
export function probeSeq(): string {
  return `\x1b_Gi=${PROBE_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`   // 支不支持 graphics
    + '\x1b[16t'                                                  // 格像素（首选）
    + '\x1b[14t'                                                  // 窗口像素（退路，除以格数）
    + '\x1b[c';                                                   // 哨兵
}

export type ProbeReply = {
  graphics: boolean;
  cellW: number | undefined;
  cellH: number | undefined;
  /** DA 回复到了吗（= 探测可以收工了）。 */
  done: boolean;
  /** 不属于我们的字节，按原顺序。 */
  leftover: string;
};

/**
 * 从收到的字节里挑出我们的三条回复。用 latin1 当"字节的字符串视图" ——
 * 逐字节可逆，所以剩下的部分能原样还回去（用户抢跑打的可能是任何 UTF-8 序列）。
 */
export function parseProbe(s: string, cols: number, rows: number): ProbeReply {
  let graphics = false;
  let cellW: number | undefined;
  let cellH: number | undefined;
  let done = false;
  let leftover = '';
  let i = 0;
  while (i < s.length) {
    // APC 回复：ESC _ G … ESC \（或者 BEL 收尾的变体）。
    if (s.startsWith('\x1b_G', i)) {
      const st = s.indexOf('\x1b\\', i);
      const bel = s.indexOf('\x07', i);
      const end = st >= 0 ? st + 2 : bel >= 0 ? bel + 1 : -1;
      if (end < 0) { leftover += s.slice(i); break; }   // 半截，当没收到（超时会兜住）
      const body = s.slice(i, end);
      if (body.includes(`i=${PROBE_ID}`) && body.includes(';OK')) graphics = true;
      i = end;
      continue;
    }
    if (s.startsWith('\x1b[', i)) {
      // CSI：参数字节 0x30..0x3f，中间字节 0x20..0x2f，然后一个终结符。
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
      if (j >= s.length) { leftover += s.slice(i); break; }
      const params = s.slice(i + 2, j);
      const final = s[j]!;
      const end = j + 1;
      if (final === 'c' && params.startsWith('?')) { done = true; i = end; continue; }
      if (final === 't') {
        const p = params.split(';').map(Number);
        // `CSI 6;h;w t` = 格像素（对 16 t 的回复）；`CSI 4;h;w t` = 窗口像素（对 14 t）。
        if (p[0] === 6 && p.length >= 3 && p[1]! > 0 && p[2]! > 0) {
          cellH = p[1]!;
          cellW = p[2]!;
          i = end;
          continue;
        }
        if (p[0] === 4 && p.length >= 3 && p[1]! > 0 && p[2]! > 0) {
          // 窗口像素含边距，除出来的值偏小 —— 只在 16 t 没回的时候用，所以不覆盖已有值。
          if (cellW === undefined) {
            cellH = Math.floor(p[1]! / Math.max(1, rows));
            cellW = Math.floor(p[2]! / Math.max(1, cols));
          }
          i = end;
          continue;
        }
      }
      leftover += s.slice(i, end);
      i = end;
      continue;
    }
    leftover += s[i]!;
    i++;
  }
  return { graphics, cellW, cellH, done, leftover };
}

/** 明显不合理的格像素当没问到 —— 宁可用默认值，也不要按一个坏数算出溢屏的图。 */
function sane(w: number | undefined, h: number | undefined): { w: number; h: number } | null {
  if (w === undefined || h === undefined) return null;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 3 || w > 64 || h < 5 || h > 128) return null;
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * 光看环境变量就能确定支持 kitty graphics 的终端。返回给 `why` 用的名字。
 *
 * 只收**终端自己设的、不会被继承错**的变量。`TERM` 是最可靠的一条（tmux/screen 会改写它，
 * 而那两种情况在上面已经先拦掉了）；`TERM_PROGRAM` 和各家自己的变量当补充。
 */
export function knownGraphicsTerm(env: NodeJS.ProcessEnv): string | null {
  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('kitty')) return 'kitty';
  if (term.includes('ghostty')) return 'Ghostty';
  if (term.includes('wezterm')) return 'WezTerm';
  const prog = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (prog === 'ghostty') return 'Ghostty';
  if (prog === 'wezterm') return 'WezTerm';
  if (prog === 'kitty') return 'kitty';
  if (env.KITTY_WINDOW_ID !== undefined && env.KITTY_WINDOW_ID !== '') return 'kitty';
  if (env.GHOSTTY_RESOURCES_DIR !== undefined && env.GHOSTTY_RESOURCES_DIR !== '') return 'Ghostty';
  if (env.WEZTERM_PANE !== undefined && env.WEZTERM_PANE !== '') return 'WezTerm';
  return null;
}

function parseCellEnv(v: string | undefined): { w: number; h: number } | null {
  if (v === undefined || v === '') return null;
  const m = /^(\d+)[x×](\d+)$/.exec(v.trim());
  if (m === null) return null;
  return sane(Number(m[1]), Number(m[2]));
}

const EMPTY = new Uint8Array(0);

export type ProbeIO = {
  stdin: {
    on: (ev: 'data', f: (b: Buffer) => void) => unknown;
    off: (ev: 'data', f: (b: Buffer) => void) => unknown;
  };
  write: (s: string) => void;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /** 超时。够短到没人察觉，够长到本地终端一定回得来。 */
  timeoutMs?: number;
  /** 哨兵（DA）到了但 graphics 的 OK 还没到时，再多等这么久。 */
  graceMs?: number;
  /** 没有 TTY 就别问（回复不会来，白等 150ms）。 */
  tty: boolean;
};

/**
 * 问一次。**必须在把 stdin 交给输入路由器之前调用**，而且此时 stdin 应该已经是 raw ——
 * 不是 raw 的话回复会被行缓冲卡住，直到用户按回车才到。
 */
export async function probeCaps(io: ProbeIO): Promise<Caps> {
  const env = io.env;
  const fps = env.SSH_CONNECTION !== undefined && env.SSH_CONNECTION !== '' ? 15 : 30;
  const forced = env.MOYU_TIER === 'half' || env.MOYU_TIER === 'graphics' ? env.MOYU_TIER : undefined;
  const envCell = parseCellEnv(env.MOYU_CELL);
  const cell = envCell ?? DEFAULT_CELL;

  if (forced === 'half') return { tier: 'half', cellW: cell.w, cellH: cell.h, fps, why: 'MOYU_TIER=half', leftover: EMPTY };
  if (forced === 'graphics') {
    return {
      tier: 'graphics', cellW: cell.w, cellH: cell.h, fps,
      why: `MOYU_TIER=graphics，格像素 ${cell.w}×${cell.h}${envCell === null ? '（默认值）' : ''}`,
      leftover: EMPTY,
    };
  }
  if (!io.tty) return { tier: 'half', cellW: cell.w, cellH: cell.h, fps, why: '不是 TTY', leftover: EMPTY };
  const mux = env.TMUX !== undefined && env.TMUX !== '' ? 'tmux'
    : env.STY !== undefined && env.STY !== '' ? 'screen' : null;
  if (mux !== null) {
    return { tier: 'half', cellW: cell.w, cellH: cell.h, fps, why: `${mux} 不透传 APC`, leftover: EMPTY };
  }

  // 400 而不是 150：会回话的终端根本走不到超时（哨兵一到就收工，本地是亚毫秒级），
  // 所以这个数字只在"终端一个字都不回"时才被真的等满 —— 那时宁可多等一会儿，也不要
  // 因为差几十毫秒把一个支持像素档的终端判成半块档（那是 3 像素高的火柴人，见文件头）。
  const budget = io.timeoutMs ?? 400;
  // 哨兵到了、graphics 的 OK 却没到：不立刻定论，再等一小会儿。
  // 我们是**一次 write 里发四条查询**，回复的顺序理论上跟着查询走，但那是终端的实现细节
  // （图形命令在有些终端里走的不是 CSI 那条同步路径）。押在顺序上的代价太不对称：
  // 猜错一次就是整个像素档静默消失，而这里多等 40ms 只发生在真的没收到 OK 的那一次。
  const grace = io.graceMs ?? 40;
  const budgetAt = Date.now() + budget;
  let raw = '';
  let settle: (() => void) | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let budgetTimer: NodeJS.Timeout | null = null;
  // 定时器一律**不 unref**，而是收工时显式清掉：这一段是启动路径上的阻塞等待，
  // 它要么按时结束、要么把整个程序卡在黑屏上，所以不能允许"事件循环空了就跳过"。
  const done = (): void => {
    if (settle === null) return;
    if (graceTimer !== null) clearTimeout(graceTimer);
    if (budgetTimer !== null) clearTimeout(budgetTimer);
    const f = settle;
    settle = null;
    f();
  };
  const onData = (b: Buffer): void => {
    raw += b.toString('latin1');
    const r = parseProbe(raw, io.cols, io.rows);
    if (settle === null) return;
    // OK 已经到手就不等超时了。启动路径上省下来的这几百毫秒用户能感觉到。
    if (r.graphics && r.done) { done(); return; }
    if (r.done && graceTimer === null) {
      graceTimer = setTimeout(done, Math.max(0, Math.min(grace, budgetAt - Date.now())));
    }
  };
  io.stdin.on('data', onData);
  io.write(probeSeq());
  await new Promise<void>((res) => {
    settle = res;
    budgetTimer = setTimeout(done, budget);
  });
  io.stdin.off('data', onData);

  const r = parseProbe(raw, io.cols, io.rows);
  const got = sane(r.cellW, r.cellH);
  const use = envCell ?? got ?? DEFAULT_CELL;
  const leftover = r.leftover === '' ? EMPTY : Uint8Array.from(Buffer.from(r.leftover, 'latin1'));
  if (!r.graphics) {
    const known = knownGraphicsTerm(env);
    if (known === null) {
      return { tier: 'half', cellW: use.w, cellH: use.h, fps, why: '终端没回 kitty graphics 的 OK', leftover };
    }
    return {
      tier: 'graphics', cellW: use.w, cellH: use.h, fps,
      why: `${known} 支持 kitty graphics（探测没回话，按 env 认定），格像素 ${use.w}×${use.h}`
        + `${got === null ? '（问不到，用默认值）' : ''}${fps === 15 ? '，SSH → 15fps' : ''}`,
      leftover,
    };
  }
  return {
    tier: 'graphics', cellW: use.w, cellH: use.h, fps,
    why: `kitty graphics ✓，格像素 ${use.w}×${use.h}${got === null ? '（问不到，用默认值）' : ''}`
      + (fps === 15 ? '，SSH → 15fps' : ''),
    leftover,
  };
}
