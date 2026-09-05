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
 * **2. 游戏在最下面一条，紧贴内层的输入框。**
 * 用户想要的是"输入框上方那条线"，但那个位置做不到，而且不是取舍问题：
 *   - 游戏区在上、CLI 在下 ⇒ 滚动区变成 `CSI top;bottom r` 且 `top ≠ 1`。
 *     按 Ghostty 的 `Terminal.zig`，`index()` 只在 `scrolling_region.top == 0` 时写
 *     history —— 也就是**所有终端上的 scrollback 都会没**。往上翻看不了刚才的输出，
 *     这个代价比"游戏在上面还是下面"大得多。
 *   - 内层的输入框在它自己的区域里是浮动的（它自己会重绘、位置随内容变），
 *     外壳没有稳定的行号可以贴。而"最后一行的下面"是**恒定**的。
 * 所以游戏条钉在屏幕最底部：内层的输入框就在它正上方，视觉上就是"输入框那条线"。
 *
 * ## 尺寸：固定 2 行，不再跟焦点联动
 *
 * 以前是焦点在游戏时涨到 65%、回 CLI 时缩到 32%。现在整条只有 1~4 个字符行
 * （默认 2 行 = 4 个像素行），所以**焦点不再改尺寸** —— 好处不只是简单：
 * 焦点联动要 `pty.resize()`，而 resize 会让内层 TUI 全量重绘，切一次焦点抖一次。
 * 现在切焦点只改按键路由，内层从头到尾不知道有人在它下面玩。
 */

/** 内层至少要这么多行才勉强能用（提示行 + 输入行 + 一点上下文）。 */
export const MIN_INNER_ROWS = 10;
/** 游戏区最少 1 行 —— 半块渲染下那也有 2 个像素行，够站一个 1 像素高的小人。 */
export const MIN_GAME_ROWS = 1;
/** 上限 4 行。再高就不是"输入框下面那条线"了，而是又变成半屏游戏。 */
export const MAX_GAME_ROWS = 4;
/** 默认 2 行 = 4 个像素行。用户的原话是"字体的 1-2 倍"。 */
export const DEFAULT_GAME_ROWS = 2;
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
   * 手动指定的游戏区行数（`^G +/-` 调的值，会持久化）。
   * 焦点**不**影响尺寸，所以这是唯一能让它变高的路径。
   */
  manualGameRows?: number | undefined;
};

/** 场地宽度：先给 HUD 留够，剩下的给场地，再夹到最大宽度。 */
export function fieldColsFor(cols: number): number {
  return clamp(cols - 1 - MIN_HUD_COLS, 12, MAX_FIELD_COLS);
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
      fieldCols: fieldColsFor(cols),
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
