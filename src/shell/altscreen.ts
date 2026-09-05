/**
 * 屏幕仲裁 —— 决定"现在游戏该不该显示"，并且只在真正翻转的那一刻通知上层。
 *
 * 有两个互相独立的原因会让我们让出整屏，而它们的**效果完全一样**（撤滚动区 +
 * PTY 调成整屏 + 游戏消失），所以不该写成两套逻辑：
 *
 *   1. `user-hidden` —— 用户按 `^G h` 收起游戏。
 *   2. `too-small`   —— 终端小到塞不下两个区域。
 *
 * 用"原因集合"而不是布尔量的理由：两个原因可以同时成立（收起之后又 resize 到很小，
 * 然后放大），布尔量会在其中一个消失时错误地恢复。集合天然处理这个。
 *
 * ## 备用屏为什么**不在**这个列表里（实测推翻了原设计）
 *
 * 原来有第三个原因 `alt-screen`：内层切备用屏就让屏，理由是"它想要整屏，给它"。
 * 在真 PTY 里跑真实 claude 2.1.260 之后发现这个前提是错的 —— 它启动时发**一次**
 * `?1049h`，然后**整个会话都待在备用屏上**，直到退出才 `?1049l`。也就是说按原设计
 * 游戏在启动后一秒就永久消失，同屏合成从来没有真正发生过。
 *
 * 现在备用屏走另一条路径（`Shell.onScreenSwap`）：不让屏，只在切过去的新缓冲区上
 * 重设滚动区 + 全量重绘。备用屏只是另一个缓冲区，内层有多少行是我们用 TIOCSWINSZ
 * 告诉它的，跟它在哪个缓冲区上无关。
 */

export type YieldReason = 'user-hidden' | 'too-small';

export type ArbiterHooks = {
  /**
   * 让屏：撤掉真实终端的滚动区、擦掉游戏区、把 PTY 尺寸调成整屏（触发内层 SIGWINCH 重绘）。
   *
   * 顺序上先撤滚动区再 resize —— 反过来的话内层收到 SIGWINCH 会立刻按整屏高度画，
   * 而滚动区还卡在上半屏，它画到底部时会被滚动区截断。
   */
  onYield: () => void;
  /** 收屏：重设滚动区、PTY 尺寸调回 innerRows、游戏全量重绘。 */
  onResume: () => void;
};

export class ScreenArbiter {
  private readonly reasons = new Set<YieldReason>();
  private readonly hooks: ArbiterHooks;

  constructor(hooks: ArbiterHooks) {
    this.hooks = hooks;
  }

  /** 当前是否让出了整屏（= 游戏不可见）。 */
  get yielded(): boolean {
    return this.reasons.size > 0;
  }

  /** 当前让屏的原因，调试和 HUD 用。 */
  get activeReasons(): YieldReason[] {
    return [...this.reasons];
  }

  /**
   * 置位/清除一个原因。返回可见性是否发生了翻转。
   *
   * 只在翻转时调 hook —— 中间态（两个原因先后消失）不该触发两次重绘，
   * 重绘是整个方案里最贵的操作。
   */
  set(reason: YieldReason, active: boolean): boolean {
    const before = this.yielded;
    if (active) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const after = this.yielded;

    if (before === after) return false;
    if (after) this.hooks.onYield();
    else this.hooks.onResume();
    return true;
  }

  /**
   * 启动时同步一次初始状态。
   *
   * 存在的理由：内层可能**在我们装好之前就已经在备用屏里**（比如它启动第一件事就是
   * `?1049h`，或者我们是在一个已经处于备用屏的终端里被拉起来的）。这时不能假设
   * 初始状态是 split，否则第一帧就画到内层的界面上去了。
   *
   * 不走 `set()`，因为初始化不该触发 onResume —— 那时候还没有东西可以重绘。
   */
  initialize(reasons: readonly YieldReason[]): void {
    this.reasons.clear();
    for (const r of reasons) this.reasons.add(r);
    if (this.yielded) this.hooks.onYield();
  }
}
