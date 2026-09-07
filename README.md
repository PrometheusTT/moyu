# 摸鱼 Moyu

**Agent 在干活，你在掌机里。任务一结束，一键回到工作。**

Moyu 是一个很轻的终端游戏宿主。它把 Codex、Claude Code 或其他 coding CLI 原样包起来，
平时只在右下角占一行；按一次 `Ctrl+]`，Codex 输入框上方两行就变成一台微型掌机。
首次进入会显示操作说明，按游戏操作键开始，`?` 随时查看帮助。`E` 主动展开为六行，
空间不足时使用四行；贪吃蛇与落块需要六行完整棋盘，两行中显示展开入口。
不需要账户、服务端或首次配置，SSH 和 Termius 也能直接玩。

```text
┌──────────────────── coding CLI ────────────────────┐
│  agent 正在运行；你的输入、滚屏和快捷键照常工作     │
│  ⠈⠙⠦ 火柴快斩 / 贪吃蛇 / 落块（仅两行）          │
├──────────────────── Codex 输入框 ──────────────────┤
└────────────────────────────────────────────────────┘
```

## 安装

```sh
npm i -g github:PrometheusTT/moyu
```

需要 **Node ≥ 20**，支持 macOS、Linux 和 Windows WSL。发布包带编译产物和预编译 PTY，
安装时不编译、不启动 daemon，也没有运行时网络请求。

## 开始玩

```sh
moyu -- codex          # 包住 Codex
moyu -- claude         # 包住 Claude Code
moyu play              # 不包 CLI，直接打开掌机
moyu play snake        # 直接进入指定游戏
```

外壳默认把输入完整交给 coding CLI：

| 按键 | 作用 |
|---|---|
| `Ctrl+]` | 一次按键进入或离开游戏；SSH 可直接透传，也不占用输入法切换键 |
| `F12` | 兼容备用键，同样进入或离开 |
| `Ctrl+Space` | Moyu 永不占用；原样交给 CLI / 输入法 |
| `Esc` / `q` | 从游戏回到 CLI，不结束 agent 会话 |
| `Ctrl+C` | 始终交给 coding CLI |
| `Ctrl+G` | 始终交给 Codex/Claude，Moyu 不再占用 |
| `Tab` | 游戏中切换 Cartridge |
| `E` | 两行／展开切换，展开区域位于底部 |
| `?` | 查看或关闭操作帮助，查看时游戏暂停 |

火柴快斩使用 `A/D` 或方向键移动、空格跳跃、`J` 攻击。贪吃蛇与落块使用
`WASD` 或方向键；落块可用空格直落。游戏状态会保存在 `~/.moyu/state/`。
收起和查看帮助时暂停游戏，返回后接着玩；磁盘存档目前保留战绩，不保存整局进度。

## 图片画质与字符兼容

Moyu 有三层渲染能力：

1. **Kitty Graphics**通过探测后提供真正 RGB 像素。火柴快斩直接按设备像素绘制，使用
   独立镜头、连续轮廓和线性颜色空间的边缘覆盖率，不再先缩进 180×44 再放大。
2. **彩色 Braille**是通用兼容档：一个终端字符承载 2×4 个点位。它只使用 Unicode 与 ANSI，
   作为主流 UTF-8 终端的兼容路径。不同字体与行距仍需实机验证。内嵌画面继承终端的默认
   前景与背景色，不会在输入框旁贴一块与主题不一致的黑色矩形。
3. **半块字符**只作为明确指定的最低兼容档。

字符兼容档不等于图片画质。当前完成的是原生像素升级第一阶段，iTerm2/Sixel 尚未接入，
会在真实终端样片验收后实施。Termius 没有通过图片探测时仍使用字符档，不承诺 Kitty 级画质。
`moyu play` 当前仍是独立字符模式；新像素路径在 `moyu -- codex` 和 `doctor --visual` 中使用。

`MOYU_TIER=graphics` 现在只是“优先尝试”：探测失败会安全回到 Braille，不会再向 Termius
盲发图片协议导致空白。只有调试终端协议时才应使用严格覆盖：

```sh
MOYU_TIER=graphics moyu -- codex         # 安全尝试图片档
MOYU_TIER=braille moyu -- codex          # 明确使用字符兼容档
MOYU_THEME=light moyu -- codex           # 火柴快斩原生像素路径使用浅色画布
MOYU_FORCE_GRAPHICS=1 moyu -- codex      # 严格强制；不支持的终端可能空白或乱码
MOYU_REDUCE_MOTION=1 moyu -- codex       # 关闭震屏和闪白
MOYU_OVERLAY=1 moyu -- my-codex-alias    # 自定义启动器也启用“输入框上方两行”识别
```

本阶段仍保留 SSH 15 fps、本地 30 fps；统一背压和自适应调度属于下一阶段。
字符游戏绘制在固定逻辑画布上，
标准画面和 80×8 微型画面共享同一份角色、碰撞、姿态与游戏进度；微型画面会重新构图，
而不是把完整场景硬压扁。Codex 中它固定贴在输入框上方两行；识别不到输入框的 CLI 会安全
回退到底部两行。候场在右下角显示 `moyu  Ctrl+] 开玩`。
字符人物保持一致的点阵笔触，棋盘使用连续块面；火柴快斩图片档直接绘制到目标像素。
像素画布当前默认暗色，用 `MOYU_THEME=light` 明确切换，不会修改终端主题。
可读性与终端验证记录见 [终端验收](docs/terminal-qa.md)。

## 可选的任务联动

不装 hook 也能玩。想让任务完成时自动保存、回到 CLI，并在底栏留下完成标记：

```sh
moyu setup                    # 安装已检测到的 Codex / Claude Code hook
moyu install                  # 只预览将要修改什么
moyu install --write          # 与 setup 等价，实际写入并先备份
moyu install --uninstall --write
```

Codex 配置写入 `~/.codex/hooks.json`，Claude Code 配置写入 `~/.claude/settings.json`；
已有配置会合并保留，实际修改前会生成带时间戳的备份。

hook 只向当前会话的事件文件追加 `时间戳 + start/done/notify`。它不写 prompt、命令输出、
错误文本、命令、文件路径和仓库名。其他 agent CLI 可以调用 `moyu signal start` / `moyu signal done` 接入。

Codex 首次加载新 hook 会显示 `Hooks need review`；请选择 **`Trust all and continue`**，
否则 Codex 会按安全策略保持 hook 禁用。Claude Code 不需要这一步。

## Cartridge：把终端变成游戏社区

当前内置三个不同类型的游戏：`stick-slash`、`snake`、`blocks`。宿主提供固定步长更新、
逻辑帧缓冲、统一输入、任务事件、存档和多档终端渲染；游戏本身不接触终端转义序列。

```sh
moyu games list
moyu games add ./my-game              # 先展示代码权限警告，不安装
moyu games add ./my-game --yes        # 信任并安装到 ~/.moyu/games/
moyu games remove my-game --yes
```

Cartridge 目录包含 `moyu.game.json` 和一个 ESM 入口：

```json
{
  "id": "my-game",
  "name": "My Game",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "you",
  "description": "a tiny terminal game",
  "entry": "index.mjs",
  "viewport": { "width": 64, "height": 40 },
  "microViewport": { "width": 80, "height": 8 },
  "display": { "micro": true, "minRows": 6, "glyphs": "dots" },
  "palette": ["#0c0d12", "#ecf0f8"],
  "controls": [{ "action": "move", "label": "移动", "keys": ["WASD"] }]
}
```

入口默认导出 `{ create(context) }`；实例实现 `update(dt, input)` 与 `render(canvas)`，并可选实现
两行专用的 `renderMicro(canvas)`、展开字符画面的 `renderExpanded(canvas)`，以及
`onHostEvent(event)`、`serialize()`、`restore(state)`、`hud()`。`display.micro` 明确声明两行
可玩，`minRows` 指定展开所需行数，`glyphs` 选择一致点阵或块面。未声明两行能力的游戏
显示展开入口，不自动压缩。展开画布为 80×24，四行时为 80×16，应使用实际画布尺寸。
另可实现 `renderPixels(canvas, context)`：`canvas.width/height` 是实际目标像素，支持
`clear/pixel/rect/line/stroke/circle`；`context` 包含 `view: 'micro' | 'expanded'`、
`interpolation: 0..1` 和 `theme: 'dark' | 'light'`。`stroke` 的宽度参数是半径，所有坐标均为设备像素。
此路径只在图片档调用，不经过 `viewport` 缩放；未实现时保持旧卡带行为。
本地 Cartridge 是**受信任的
JavaScript 代码**，拥有当前用户进程的文件和网络权限；Moyu 会明确确认，但不会假装它是沙箱。

## 诊断

```sh
moyu doctor             # Node、PTY、hook 与事件文件
moyu doctor --caps      # 当前终端选择了 graphics / braille / half 中哪一档
moyu doctor --gfx       # 仅用于验证 Kitty Graphics 链路
moyu doctor --visual    # 实际像素动作对比：Tab 新旧、空格暂停、e 两/六行、l 深浅、Esc 退出
moyu doctor --reset     # 花屏、光标丢失或被 kill -9 后恢复终端
```

在 Termius 中看到 `braille` 表示当前使用通用字符绘制，并不代表画质已经通过实机验收。
不同终端允许细节不同，但必须看清角色和动作。字符缺失、轮廓模糊或行距割裂都应作为
兼容问题记录，不能只以“支持 Unicode”作为完成标准。

## 开发

```sh
npm test
npm run typecheck
npm run compile          # 更新提交到仓库的 dist/
npm run bench
node --experimental-strip-types scripts/visual-qa.mjs   # 真实字形与动画预览
node --experimental-strip-types scripts/pixel-qa.mjs    # 实际 Kitty 载荷解码后的新旧像素预览
node --experimental-strip-types scripts/codex-smoke.mjs # 本机 Codex 接入检查
npm pack                 # 检查实际安装包
```

架构边界见 [PRODUCT.md](./PRODUCT.md)：`src/shell/` 只负责安全透传和屏幕所有权，
`src/platform/` 是 Cartridge 宿主，`src/render/` 将同一逻辑画布输出到不同终端。

## License

MIT
