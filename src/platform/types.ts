export type GameManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  author: string;
  description: string;
  entry: string;
  viewport: { width: number; height: number };
  /** 两字符行游戏条的专用逻辑分辨率。 */
  microViewport?: { width: number; height: number };
  /** 未声明时不把标准画面强压进两行。minRows 是展开模式最低可玩行数。 */
  display?: { micro: boolean; minRows: number; glyphs?: 'dots' | 'blocks' };
  palette: string[];
  controls: Array<{ action: string; label: string; keys: string[] }>;
};

export type GameInput = {
  left: boolean; right: boolean; up: boolean; down: boolean;
  jump: boolean; primary: boolean; secondary: boolean;
};

export type GameCanvas = {
  readonly width: number;
  readonly height: number;
  clear(color: number): void;
  pixel(x: number, y: number, color: number): void;
  rect(x: number, y: number, w: number, h: number, color: number): void;
  line(x0: number, y0: number, x1: number, y1: number, color: number): void;
};

export type GameContext = {
  readonly seed: number;
  random(): number;
};

/** Device-pixel drawing, never terminal cells. Smooth primitives do not affect pixel sprites. */
export type PixelCanvas = GameCanvas & {
  stroke(x0: number, y0: number, x1: number, y1: number, radius: number, color: number): void;
  circle(x: number, y: number, radius: number, color: number): void;
};

export type PixelRenderContext = {
  readonly view: 'micro' | 'expanded';
  /** Fraction between the previous and current fixed simulation step, in [0, 1]. */
  readonly interpolation: number;
  readonly theme: 'dark' | 'light';
};

export type HostEvent = 'task-start' | 'task-done' | 'task-notify' | 'pause' | 'resume';

export interface GameInstance {
  update(dt: number, input: GameInput): void;
  render(canvas: GameCanvas): void;
  /** 可选的两行专用构图。用于保住角色轮廓和动作，而不是把完整场景压扁。 */
  renderMicro?(canvas: GameCanvas): void;
  /** 通用字符终端的展开构图；六行为 80×24，四行为 80×16。使用实际画布尺寸。 */
  renderExpanded?(canvas: GameCanvas): void;
  /** Optional native-resolution path. Old cartridges retain their existing framebuffer renderer. */
  renderPixels?(canvas: PixelCanvas, context: PixelRenderContext): void;
  onHostEvent?(event: HostEvent): void;
  serialize?(): unknown;
  restore?(state: unknown): void;
  hud?(): string;
}

export interface GameModule {
  manifest: GameManifest;
  create(context: GameContext): GameInstance;
}
