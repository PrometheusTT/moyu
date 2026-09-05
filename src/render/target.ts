/**
 * 画布抽象 —— 渲染层和"像素怎么变成终端字节"之间的唯一接口。
 *
 * 为什么需要它：**半块字符画不出能认出来的人**，这不是美术问题是算术问题。
 * 出货形态是输入框上方 1~2 个字符行的窄条，半块一格上下 2 个像素，于是画布只有
 * 4 个像素行 —— 反推出来的身高是 **3 个像素**，大腿 0.75 像素、头 0.35 像素。
 * 四肢比一个像素还细，任何姿势、任何角度补偿都不可能被看见（`core/stick.ts` 里
 * 那一堆矮尺寸补救就是在这个尺寸上挣扎的产物）。
 *
 * 所以档位是这样的，每一档能给的竖直分辨率差一个数量级：
 *
 * | 档 | 手段 | 2 行条能给的像素 | 每格颜色数 |
 * |---|---|---|---|
 * | `graphics` | kitty graphics 协议直送 RGB 位图 | **640 × 68**（视网膜格 16×34）| 每像素独立 |
 * | `half` | 上半块 `▀`，前景 = 上像素、背景 = 下像素 | 40 × 4 | 2 |
 *
 * （R2 的 Unicode 八分块档 —— 80 × 8、每格 2 色 —— 还没实现，它会作为第三个 tier 加进来。）
 *
 * 接口刻意**以字符格为尺寸单位**（`resize(cols, rows)`）而不是像素：外壳的分屏计算
 * 只认字符格，一个档位换成另一个不该让 `regions.ts` 跟着改。像素范围由档位自己算出来，
 * 通过 `pixelW/pixelH` 报出来 —— 作画的一方（`painter.ts`）只看这两个数。
 */

/** 档位。选档在 `caps.ts`，一旦选定整个进程不再变（换档要重建 target）。 */
export type Tier = 'graphics' | 'half';

export type PixelTarget = {
  readonly tier: Tier;
  /** 占的字符格数 —— 决定它在屏幕上多大。 */
  readonly cols: number;
  readonly rows: number;
  /** 能画的像素范围。半块档 = `cols × rows*2`，像素档 = 设备像素。 */
  readonly pixelW: number;
  readonly pixelH: number;
  /** 上一次 `encode` 真正写出的字节数。性能面板和预算测试看的就是它。 */
  readonly lastBytes: number;

  resize(cols: number, rows: number): void;
  setPixel(x: number, y: number, color: number): void;
  getPixel(x: number, y: number): number;
  fill(color: number): void;
  /**
   * 实心矩形（设备像素，半开区间）。
   *
   * 它在接口里而不是在 `painter.ts` 里用 `setPixel` 拼，是因为**背景占了每帧七成以上的
   * 像素**：像素档一帧 640×68 = 43520 个像素，逐个 `setPixel` 就是四万次方法调用，
   * 比 deflate 本身还贵。像素档可以整行写完再 `copyWithin` 复制，快两个数量级。
   */
  fillRect(x: number, y: number, w: number, h: number, color: number): void;
  /** 丢掉"屏幕上现在是什么"的记忆，下一帧全量重发。终端被别人擦过就得调它。 */
  invalidate(): void;

  /**
   * 一帧的字节。`screenTop` 是画布第一行在**真实屏幕**上的行号（1-based）；
   * 左边缘固定在第 1 列 —— 外壳把画布放在游戏区的最左边，HUD 在它右边。
   * 没有任何变化时返回 `''`（一个字节都不发）。
   */
  encode(screenTop: number): string;

  /**
   * 退出 / 收起游戏区 / 换档时要发的清理字节。
   *
   * 像素档必须发（终端里存着我们上传的图，不删就一直挂在那儿）；半块档没有终端侧
   * 状态，返回 `''`。**退出路径无条件调它**，和还原滚动区、光标一样。
   */
  disposeSeq(): string;
};
