# Architecture

本文面向贡献者，说明 Moyu 的运行边界、关键不变量和测试策略。产品层不可妥协的行为约束见
[PRODUCT.md](../PRODUCT.md)。

## 设计目标

Moyu 的首要任务不是渲染游戏，而是保证 wrapped CLI 的工作会话完整：

1. CLI 输入输出和退出语义优先；
2. 游戏可以随时隐藏、暂停或丢帧；
3. 终端状态在正常退出、信号、异常和 worker 崩溃后都可恢复；
4. 游戏逻辑不直接接触终端协议；
5. 发布包在 Node.js 20 上无需编译即可运行。

## 进程模型

```text
user terminal
    │
    ▼
bin/moyu.mjs (npm) / bin/moyu (checkout) ──> supervisor
                       │ authenticated IPC lease
                       ▼
                    worker/main
                       │
                       ├── terminal host / renderer
                       └── PTY ──> Codex, Claude Code, or another CLI
```

npm 安装包用跨平台的 `bin/moyu.mjs` 启动编译后的 `dist`；源码仓库的 `bin/moyu` 可选源码入口。
两者都启动 supervisor。supervisor 不参与正常
渲染；它保存 worker 最后确认的终端恢复状态。worker 在进入 raw mode、创建滚动区或上传 Kitty
图片前取得 lease，并在终端所有权变化时更新快照。

如果 worker 被 `SIGKILL`，supervisor 等待它真正停止输出后再写统一的恢复序列。正常退出时，
worker 先停止所有输出源、提交最终快照并恢复终端，然后完成 lease。supervisor 与 worker 同时被
操作系统强制终止超出了用户态程序能够保证的范围。

## 数据流

### 输入

`InputRouter` 逐字节识别终端回复、粘贴、传统按键和 Kitty keyboard protocol：

- CLI 焦点下，除 Moyu 的切换手势外全部转发；
- 游戏焦点下，游戏操作进入当前 Cartridge；
- `Ctrl+C`、`Ctrl+G` 和 `Ctrl+Space` 始终属于 CLI；
- 不完整控制序列可以跨 PTY chunk 继续解析。

### 输出

内层输出经过 `Passthrough`，保持字节不变，只对可能越过受保护区域的定位、滚动区和尺寸查询
做必要改写。`VtCursor` 镜像内层光标与终端状态，游戏帧结束后据此恢复 CLI 光标。

stdout 返回背压时，宿主暂停内层 PTY 到 `drain`，并跳过可选游戏帧。游戏绝不能通过无限排队
降低 CLI 响应速度。

## 模块边界

| 路径 | 责任 | 不应该做的事 |
| --- | --- | --- |
| `src/app/` | CLI 命令、supervisor、宿主编排 | 实现 Cartridge 游戏规则 |
| `src/shell/` | PTY、输入、透传、终端区域、teardown | 依赖具体游戏状态 |
| `src/platform/` | Cartridge API、加载、存档、画布与视图 | 发终端转义序列 |
| `src/render/` | Braille、半块、Kitty Graphics、场景绘制 | 读取用户配置或控制进程 |
| `src/core/` | 确定性游戏模拟、章节、RNG | 接触终端或文件系统 |
| `src/bridge/` | Agent hook 配置与事件文件 | 记录 prompt 或命令输出 |

## Cartridge 隔离边界

Cartridge 不是安全沙箱。宿主做的是故障隔离而不是权限隔离：

- manifest 在加载前严格验证；
- entry 必须留在 Cartridge 目录内；
- 内置 ID 不允许覆盖；
- 每个 factory 得到独立、不可变的确定性 context；
- 一个 factory 抛错或返回非法实例不会阻止其他游戏和 wrapped CLI 启动；
- hook 异常不能阻止持久化或宿主交接。

权限模型与披露规则见 [SECURITY.md](../SECURITY.md)。

## 渲染层

所有 Cartridge 首先面对逻辑 `GameCanvas`。宿主根据终端能力选择：

- `GraphicsTarget`：Kitty Graphics 原生设备像素；
- `BrailleTarget`：每字符 2×4 逻辑像素；
- `Canvas`：每字符 1×2 半块像素。

可选 `renderPixels()` 允许游戏在图片档直接绘制设备像素，但不会改变模拟尺寸。微型两行视图
使用专用 `renderMicro()` 构图，不把完整画面暴力缩小。

## 状态与确定性

游戏更新使用固定 60 Hz 步长。渲染帧率可以是 30 fps、SSH 下 15 fps，或因背压跳帧；这些
变化不应改变确定性模拟。内置游戏使用显式 RNG 状态，章节检查点只在稳定边界持久化。

## 测试层级

1. **纯单元测试**：RNG、世界、输入、画布、协议解析和 manifest 验证。
2. **组件测试**：Cartridge 宿主、renderer diff、teardown 与 supervisor 状态机。
3. **PTY-in-PTY E2E**：真实 raw mode、resize、背压、信号、备用屏和进程组清理。
4. **发布测试**：重新编译并比较 `dist/`、软链启动、Git 安装约束和包文件清单。
5. **视觉/性能 QA**：确定性章节样片、设备像素解码和 payload/timing 基线。

## 分发模型

仓库是源码仓库也是 Git 安装源。`dist/` 被刻意纳入版本控制，Node.js 20 用户直接运行编译后
JavaScript。不要添加 npm 会在 Git 依赖安装期间触发的构建生命周期脚本。详细发布步骤见
[releasing.md](./releasing.md)。
