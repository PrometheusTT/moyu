# Cartridge API v1

Cartridge 是 Moyu 的本地游戏包。API v1 适合实验和本地分发，但在 Moyu `1.0` 前仍可能发生
有迁移说明的调整。

> [!WARNING]
> Cartridge 是受信任 JavaScript，不在沙箱中运行。它拥有当前用户进程的文件、子进程和网络
> 权限。发布 Cartridge 时应保持依赖透明，不收集用户数据，并说明任何额外权限需求。

## 最小目录

```text
my-game/
├── moyu.game.json
└── index.mjs
```

## Manifest

```json
{
  "id": "my-game",
  "name": "My Game",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "you",
  "description": "A tiny deterministic terminal game",
  "entry": "index.mjs",
  "viewport": { "width": 64, "height": 40 },
  "microViewport": { "width": 80, "height": 8 },
  "display": { "micro": true, "minRows": 6, "glyphs": "dots" },
  "palette": ["#0c0d12", "#ecf0f8", "#e05a47"],
  "controls": [
    { "action": "move", "label": "移动", "keys": ["WASD", "方向键"] },
    { "action": "primary", "label": "动作", "keys": ["J"] }
  ]
}
```

约束：

- `id`：2–63 个小写字母、数字或连字符，且不能覆盖内置 ID；
- `apiVersion`：当前必须为 `1`；
- `entry`：Cartridge 目录内的相对路径，不允许 `..`；
- `viewport`：宽高范围为 8–320 和 8–200；
- `microViewport`：可选，宽高范围为 8–160 和 8–32；
- `palette`：2–16 个 `#RRGGBB` 颜色；画布方法使用这里的颜色索引；
- `display.micro`：是否提供可玩的两行构图；
- `display.minRows`：展开视图需要的最少字符行，范围 4–24；
- `display.glyphs`：可选 `dots` 或 `blocks`，帮助宿主选择合适的字符风格。

## 最小入口

```js
export default {
  create(context) {
    let x = 20;

    return {
      update(dt, input) {
        if (input.left) x -= 24 * dt;
        if (input.right) x += 24 * dt;
        if (input.primary && context.random() < 0.25) x += 1;
        x = Math.max(1, Math.min(62, x));
      },

      render(canvas) {
        canvas.clear(0);
        canvas.rect(Math.round(x), canvas.height - 6, 3, 5, 1);
      },

      renderMicro(canvas) {
        canvas.clear(0);
        canvas.rect(Math.round(x), Math.max(0, canvas.height - 4), 3, 4, 1);
      }
    };
  }
};
```

入口也可以直接导出包含 `create` 的模块对象。`create(context)` 必须同步返回合法实例；Promise
会被视为无效 Cartridge。

## GameContext

```ts
type GameContext = {
  readonly seed: number;
  random(): number; // [0, 1)
};
```

每个 Cartridge 有独立随机流。使用 `context.random()` 而不是 `Math.random()`，才能保证测试、
存档和视觉样片可复现。不要修改或跨实例共享 context。

## 生命周期

实例必须实现：

```ts
update(dt: number, input: GameInput): void;
render(canvas: GameCanvas): void;
```

可选方法：

```ts
renderMicro?(canvas: GameCanvas): void;
renderExpanded?(canvas: GameCanvas): void;
renderPixels?(canvas: PixelCanvas, context: PixelRenderContext): void;
onHostEvent?(event: HostEvent): void;
serialize?(): unknown;
restore?(state: unknown): void;
hud?(): string;
```

`update` 使用固定步长调用。隐藏、帮助和不支持的视图会暂停模拟；恢复时不会补算隐藏时间。
宿主可能随时改变画布尺寸，因此每一帧都应读取 `canvas.width` / `canvas.height`。

## 输入

```ts
type GameInput = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  primary: boolean;
  secondary: boolean;
};
```

方向是短时 latch，动作是单次脉冲。不要依赖终端产生 key-up 事件。

## 逻辑画布

```ts
clear(color: number): void;
pixel(x: number, y: number, color: number): void;
rect(x: number, y: number, width: number, height: number, color: number): void;
line(x0: number, y0: number, x1: number, y1: number, color: number): void;
```

颜色是 manifest `palette` 的索引。越界绘制会被裁剪，但 Cartridge 应主动使用当前尺寸布局，
避免把重要信息放到边缘外。

## 原生像素路径

图片档可实现 `renderPixels`：

```ts
type PixelRenderContext = {
  readonly view: 'micro' | 'expanded';
  readonly interpolation: number; // 0..1
  readonly theme: 'dark' | 'light';
};
```

`PixelCanvas` 在逻辑画布基础上增加 `stroke()` 和 `circle()`。这里的坐标是实际设备像素，不经过
`viewport` 缩放；`stroke` 的宽度参数是半径。`interpolation` 只应用于连续运动，不应混合离散
攻击姿势、传送或死亡状态。

## 宿主事件

`onHostEvent` 可能收到：

- `task-start`
- `task-done`
- `task-notify`
- `pause`
- `resume`

事件 handler 不应阻塞、抛出或执行长时间同步 I/O。宿主会隔离异常，但 Cartridge 自身状态可能
因此不完整。

## 存档

如果实现 `serialize()`，返回值必须是可 JSON 序列化的数据。`restore(value)` 必须把输入当作
不可信数据：先完整验证，再原子应用，避免部分恢复。推荐在数据内保存独立 schema 版本。

## 安装与测试

```sh
moyu games add ./my-game
moyu games add ./my-game --yes
moyu play my-game
```

发布前至少检查：

- 同一个 seed 和输入产生同一个结果；
- 极小画布与 resize 不抛异常；
- `renderMicro` 在 80×8 中仍能看清状态与动作；
- 暂停时不更新时间和随机流；
- `serialize`/`restore` 能拒绝畸形或旧版本数据；
- factory 抛错不会产生未处理 Promise rejection；
- README 明确说明 Cartridge 是受信任代码及其依赖。
