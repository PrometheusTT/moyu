/**
 * 分屏几何 —— 把真实终端的行数切成"上面全是 CLI / 最下面留一条给游戏"。
 *
 * ## 两条硬性不变式
 *
 * **1. 内层区域永远从真实第 1 行开始**（`innerTop === 1`）。
 * 这是整个外壳方案能成立的关键 —— 内层的绝对光标定位（`CSI y;xH`）在真实屏幕
 * 坐标系里本来就是对的，零坐标转换。反过来（游戏在上、CLI 在下）就需要给内层
 * 每一条绝对定位做坐标平移，那正是"要写终端模拟器"的开始。
 *
 * **2. 安全回退布局把游戏放在最下面，Codex 则优先使用输入框上方覆盖层。**
 * 普通 CLI 没有可靠的输入框锚点，因此回退布局不能把 PTY 整体放到游戏下方：
 *   - 游戏区在上、CLI 在下 ⇒ 滚动区变成 `CSI top;bottom r` 且 `top ≠ 1`。
 *     按 Ghostty 的 `Terminal.zig`，`index()` 只在 `scrolling_region.top == 0` 时写
 *     history —— 也就是**所有终端上的 scrollback 都会没**。往上翻看不了刚才的输出，
 *     这个代价比"游戏在上面还是下面"大得多。
 *   - 未知 CLI 的输入框在自己的区域里是浮动的，外壳没有稳定的行号可贴。
 * Codex 有可观测的 `›` / `❯` composer 锚点，因此实际游玩时在它上方覆盖两行，且不改变
 * PTY 尺寸；退出后清行并用 SIGWINCH 请 Codex 重绘。识别不到锚点时才使用底部回退布局。
 *
 * ## 尺寸
 *
 * 候场恒定一行；默认游戏条恒定两行，并始终给 CLI 留至少 10 行。
 * 两行是产品约束而非自适应结果：它必须像输入框的一部分，而不是第二块主界面。
 * 切换只发生在用户的一次明确手势上，不随普通按键或任务动画抖动。
 */

/** 内层至少要这么多行才勉强能用（提示行 + 输入行 + 一点上下文）。 */
export const MIN_INNER_ROWS = 10;
/** 游戏区最少 1 行 —— 半块渲染下那也有 2 个像素行，够站一个 1 像素高的小人。 */
export const MIN_GAME_ROWS = 1;
/** 偷玩窗口的上限；更大就会从掌机变成屏幕上的主角。 */
export const MAX_GAME_ROWS = 8;
/** 候场状态只占一行。 */
export const DEFAULT_GAME_ROWS = 1;
/** 包裹模式的游戏高度：Braille 每格 2×4，恰好得到 80×8 的微型画布。 */
export const MICRO_GAME_ROWS = 2;
/** 终端至少要这么宽。半块渲染下像素宽度 = 列数。 */
export const MIN_COLS = 60;

/** 游戏画布的最大列数 —— "不要那么宽"。40 列的场地配 3~6 像素高的小人正好。 */
export const MAX_FIELD_COLS = 40;
/** HUD 文本区至少留这么多列（战绩 + 热键提示）。窄终端下先让场地缩。 */
export const MIN_HUD_COLS = 30;

export type Focus = 'cli' | 'game';

export type Layout = {
  cols: number;
  rows: number;
  /** 恒为 1。写出来是为了让不变式可断言。 */
  innerTop: 1;
  /** 内层可用行数 = gameTop - 1。这是通过 TIOCSWINSZ 告诉 PTY 的行数。 */
  innerRows: number;
  /** 游戏区第一行（真实坐标，1-based）。 */
  gameTop: number;
  gameRows: number;
  /** 画布占的列数（从第 1 列起）。右边剩下的列是 HUD 文本。 */
  fieldCols: number;
};

export type LayoutResult =
  | { kind: 'split'; layout: Layout }
  /** 终端太小，塞不下两个区域 —— 整屏让给内层，不显示游戏。 */
  | { kind: 'too-small'; cols: number; rows: number; reason: string };

export type LayoutInput = {
  cols: number;
  rows: number;
  /**
   * 宿主指定的游戏区行数：包裹模式候场为 1、游戏为 `MICRO_GAME_ROWS`。
   */
  manualGameRows?: number | undefined;
  /** 独立/调试布局可申请使用整行；日常包裹模式保持紧凑宽度。 */
  expanded?: boolean | undefined;
};

/** 场地宽度：先给 HUD 留够，剩下的给场地，再夹到最大宽度。 */
export function fieldColsFor(cols: number): number {
  // 两行精灵需要完整 80×8，不为提示区缩小人物；窄屏提示使用临时全宽帮助。
  return clamp(cols - 1, 12, MAX_FIELD_COLS);
}

/** 给独立 pocket/debug 布局保留的响应式高度；日常包裹模式固定使用两行。 */
export function expandedGameRows(rows: number): number {
  const cap = Math.min(MAX_GAME_ROWS, Math.max(MIN_GAME_ROWS, rows - MIN_INNER_ROWS));
  const floor = Math.min(5, cap);
  return clamp(Math.floor(rows * 0.18), floor, cap);
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const { cols, rows } = input;

  if (cols < MIN_COLS) {
    return { kind: 'too-small', cols, rows, reason: `需要至少 ${MIN_COLS} 列，当前 ${cols}` };
  }
  if (rows < MIN_INNER_ROWS + MIN_GAME_ROWS) {
    return {
      kind: 'too-small',
      cols,
      rows,
      reason: `需要至少 ${MIN_INNER_ROWS + MIN_GAME_ROWS} 行（CLI ${MIN_INNER_ROWS} + 游戏 ${MIN_GAME_ROWS}），当前 ${rows}`,
    };
  }

  const gameRows = clampRows(rows, input.manualGameRows ?? DEFAULT_GAME_ROWS);
  const innerRows = rows - gameRows;

  return {
    kind: 'split',
    layout: {
      cols,
      rows,
      innerTop: 1,
      innerRows,
      gameTop: innerRows + 1,
      gameRows,
      fieldCols: input.expanded ? cols - 1 : fieldColsFor(cols),
    },
  };
}

function clampRows(rows: number, want: number): number {
  return clamp(want, MIN_GAME_ROWS, Math.min(MAX_GAME_ROWS, rows - MIN_INNER_ROWS));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 手动调整游戏区行数，返回夹取后的合法值。 */
export function adjustGameRows(rows: number, current: number, delta: number): number {
  return clampRows(rows, current + delta);
}

/** 断言不变式。开发期调用，生产期也留着 —— 它坏了整个方案就坏了。 */
export function assertLayout(l: Layout): void {
  if (l.innerTop !== 1) throw new Error(`不变式被破坏：innerTop 必须是 1，得到 ${l.innerTop}`);
  if (l.gameTop !== l.innerRows + 1) throw new Error(`几何不自洽：gameTop=${l.gameTop} innerRows=${l.innerRows}`);
  if (l.innerRows + l.gameRows !== l.rows) throw new Error(`行数不守恒：${l.innerRows}+${l.gameRows}≠${l.rows}`);
  if (l.innerRows < MIN_INNER_ROWS) throw new Error(`内层行数不足：${l.innerRows}`);
  if (l.gameRows < MIN_GAME_ROWS) throw new Error(`游戏区行数不足：${l.gameRows}`);
  if (l.gameRows > MAX_GAME_ROWS) throw new Error(`游戏区行数超上限：${l.gameRows}`);
  // 场地必须给 HUD 留出至少一列，而且**不能占满整行** —— 写到最后一列会置上终端的
  // 延迟换行标志，下一个可打印字符就会把屏幕滚上去一行，游戏条从此错位。
  if (l.fieldCols >= l.cols) throw new Error(`场地占满了整行：fieldCols=${l.fieldCols} cols=${l.cols}`);
}

/** 真实终端的滚动区序列 —— 把内层的换行限制在上半屏。 */
export function scrollRegionSeq(l: Layout): string {
  return `\x1b[1;${l.innerRows}r`;
}

/** 撤掉滚动区（让屏 / 退出时用）。 */
export function fullScrollRegionSeq(): string {
  return '\x1b[r';
}
