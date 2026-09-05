/**
 * SGR 状态跟踪与重放。
 *
 * 为什么需要它：游戏每帧都要在下半屏写自己的颜色，写完之后内层 CLI 的"待用属性"
 * 就被我们踩掉了。内层不会重发（它以为终端还记着），所以我们必须记下它设过什么，
 * 画完游戏后原样重放一遍。
 *
 * 不能用 DECSC/DECRC（CSI s / CSI u）代劳：那是**一个共享寄存器**，内层自己也在用。
 */

/** 颜色：null=默认，number=16/256 色索引对应的 SGR 参数序列。 */
export type Color = readonly number[] | null;

export type SgrState = {
  fg: Color;
  bg: Color;
  /** 下划线颜色（58;...），kitty/Ghostty 等支持。 */
  ul: Color;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  /** 0=无 1=单 2=双 3=波浪 4=点 5=虚 */
  underline: number;
  blink: boolean;
  reverse: boolean;
  hidden: boolean;
  strike: boolean;
  overline: boolean;
};

export function freshSgr(): SgrState {
  return {
    fg: null,
    bg: null,
    ul: null,
    bold: false,
    dim: false,
    italic: false,
    underline: 0,
    blink: false,
    reverse: false,
    hidden: false,
    strike: false,
    overline: false,
  };
}

export function cloneSgr(s: SgrState): SgrState {
  return {
    fg: s.fg === null ? null : s.fg.slice(),
    bg: s.bg === null ? null : s.bg.slice(),
    ul: s.ul === null ? null : s.ul.slice(),
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    blink: s.blink,
    reverse: s.reverse,
    hidden: s.hidden,
    strike: s.strike,
    overline: s.overline,
  };
}

export function sgrEqual(a: SgrState, b: SgrState): boolean {
  return emitSgr(a) === emitSgr(b);
}

/**
 * 消费一条 SGR 序列的参数，就地更新状态。
 *
 * `params` 是分号切开后的数字数组，空参数按 0 处理（`ESC[m` === `ESC[0m`）。
 * 38/48/58 的扩展色（`38;5;n` / `38;2;r;g;b`）按 xterm 语义解析；同时容忍
 * 冒号子参数形式（`38:2::r:g:b`），调用方应把冒号也切成参数并把空位填 0。
 */
export function applySgr(s: SgrState, params: readonly number[]): void {
  if (params.length === 0) {
    resetSgr(s);
    return;
  }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    switch (p) {
      case 0: resetSgr(s); break;
      case 1: s.bold = true; break;
      case 2: s.dim = true; break;
      case 3: s.italic = true; break;
      case 4: s.underline = 1; break;
      case 5: case 6: s.blink = true; break;
      case 7: s.reverse = true; break;
      case 8: s.hidden = true; break;
      case 9: s.strike = true; break;
      case 21: s.underline = 2; break;
      case 22: s.bold = false; s.dim = false; break;
      case 23: s.italic = false; break;
      case 24: s.underline = 0; break;
      case 25: s.blink = false; break;
      case 27: s.reverse = false; break;
      case 28: s.hidden = false; break;
      case 29: s.strike = false; break;
      case 39: s.fg = null; break;
      case 49: s.bg = null; break;
      case 53: s.overline = true; break;
      case 55: s.overline = false; break;
      case 59: s.ul = null; break;
      case 38: case 48: case 58: {
        const consumed = readExtColor(params, i);
        if (consumed === null) return; // 参数被截断，剩下的不可信，停止解析
        if (p === 38) s.fg = consumed.color;
        else if (p === 48) s.bg = consumed.color;
        else s.ul = consumed.color;
        i = consumed.next - 1;
        break;
      }
      default:
        if (p >= 30 && p <= 37) s.fg = [p];
        else if (p >= 90 && p <= 97) s.fg = [p];
        else if (p >= 40 && p <= 47) s.bg = [p];
        else if (p >= 100 && p <= 107) s.bg = [p];
        break;
    }
  }
}

function resetSgr(s: SgrState): void {
  s.fg = null; s.bg = null; s.ul = null;
  s.bold = false; s.dim = false; s.italic = false;
  s.underline = 0; s.blink = false; s.reverse = false;
  s.hidden = false; s.strike = false; s.overline = false;
}

/** 解析 38/48/58 之后的扩展色参数。返回完整参数序列（含前导 38/48/58）。 */
function readExtColor(
  params: readonly number[],
  at: number,
): { color: readonly number[]; next: number } | null {
  const kind = params[at + 1];
  if (kind === undefined) return null;
  if (kind === 5) {
    const idx = params[at + 2];
    if (idx === undefined) return null;
    return { color: [params[at]!, 5, idx], next: at + 3 };
  }
  if (kind === 2) {
    const r = params[at + 2], g = params[at + 3], b = params[at + 4];
    if (r === undefined || g === undefined || b === undefined) return null;
    return { color: [params[at]!, 2, r, g, b], next: at + 5 };
  }
  // 未知子类型（0/1/3/4 —— 实现定义），跳过它自己，不动颜色
  return { color: null as unknown as readonly number[], next: at + 2 };
}

/**
 * 把状态序列化成"从零建立该状态"的 SGR 序列。
 *
 * 总是以 `0`（reset）开头 —— 这是幂等的关键：游戏画完之后终端处于任意状态，
 * 我们不知道那是什么，所以只能先归零再重建。
 * 默认状态返回 `ESC[0m`（不返回空串），确保调用方无条件写出去就能对。
 */
export function emitSgr(s: SgrState): string {
  const p: (number | string)[] = [0];
  if (s.bold) p.push(1);
  if (s.dim) p.push(2);
  if (s.italic) p.push(3);
  if (s.underline === 1) p.push(4);
  else if (s.underline === 2) p.push(21);
  else if (s.underline >= 3) p.push(`4:${s.underline}`);
  if (s.blink) p.push(5);
  if (s.reverse) p.push(7);
  if (s.hidden) p.push(8);
  if (s.strike) p.push(9);
  if (s.overline) p.push(53);
  if (s.fg) p.push(...s.fg);
  if (s.bg) p.push(...s.bg);
  if (s.ul) p.push(...s.ul);
  return `\x1b[${p.join(';')}m`;
}
