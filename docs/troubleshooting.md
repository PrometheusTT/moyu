# Troubleshooting

## 先收集最小诊断

```sh
node --version
moyu doctor
moyu doctor --caps
```

提交 Issue 时请说明操作系统、终端名称和版本、本地/SSH/tmux 路径、Moyu commit，以及问题发生
在 `moyu play` 还是 `moyu -- <cli>`。分享输出前删除用户名、主机名、IP、token 和私有路径。

## 安装后找不到 `moyu`

```sh
npm prefix --global
npm list --global --depth=0
```

确认 npm 全局 `bin` 所在目录位于 `PATH`。然后重新安装：

```sh
npm uninstall --global moyu-game
npm install --global moyu-game
```

如果 npm registry 中尚未发布所需版本，可以安装 GitHub 默认分支：

```sh
npm install --global github:PrometheusTT/moyu
```

两种安装方式都不需要本机 TypeScript。如果错误提到 `tsc`、`prepare` 或临时目录死软链，
请附上 Node/npm 版本创建 Bug Report。

## PTY 原生模块加载失败

`moyu -- <cli>` 依赖 `@lydell/node-pty`；`moyu play` 和部分诊断命令仍可能可用。

```sh
npm install
moyu doctor
```

确认当前平台是受支持的 macOS、Linux 或 WSL，以及 Node 架构与安装时使用的架构一致。不要从
另一台机器复制 `node_modules`。

## 图片不显示

先区分“能力探测失败”和“终端确实不支持”：

```sh
moyu doctor --caps
moyu doctor --gfx
```

`doctor --gfx` 会绕过探测直接发送一张小图。可能结果：

- 看见火柴人：单向 Kitty Graphics 链路可用；
- 什么都没有：终端可能识别 APC 但不支持图片协议；
- 出现 base64 文本：终端不识别这类 APC。

`tmux`/`screen` 默认使用 Braille。字符档可强制验证：

```sh
MOYU_TIER=braille moyu -- codex
MOYU_TIER=half moyu -- codex
```

只有调试协议时才使用 `MOYU_FORCE_GRAPHICS=1`；不兼容终端可能显示空白或乱码。

## Braille 字符断裂或人物模糊

- 换用等宽字体，并关闭会改变字符宽度的字体 fallback；
- 调整终端 line height，使上下字符行连续；
- 尝试 `MOYU_TIER=half` 判断是否为 Braille 字形问题；
- 记录终端、字体、字号、line height、缩放比例和主题。

协议自动化通过不代表具体字体已经完成视觉认证。兼容矩阵见
[terminal-qa.md](./terminal-qa.md)。

## Codex 输入框上方没有出现游戏

Moyu 只有在确认 composer 位置后才使用 inline overlay，避免覆盖普通 transcript。无法确认时会
回退到底部受保护区域。

自定义 Codex 别名或启动器可尝试：

```sh
MOYU_OVERLAY=1 moyu -- my-codex-alias
```

如果 fallback 也不可见，请记录终端尺寸和内层 CLI 启动时的原始输出模式，不要粘贴真实 prompt。

## Hook 不触发

```sh
moyu install          # 查看检测和计划
moyu setup            # 安装到检测到的 CLI
moyu doctor
```

Codex 首次加载新 hook 会要求 `Hooks need review`；选择 `Trust all and continue` 后才会执行。
安装器会备份并合并配置。若配置被其他工具改动，重新运行 dry-run，不要手工覆盖整个文件。

也可以绕过 hook 验证宿主事件：

```sh
moyu signal start
moyu signal done
moyu signal notify
```

## 终端退出后花屏、光标消失或按键异常

运行：

```sh
moyu doctor --reset
reset
```

第一条恢复 Moyu 可能拥有的同步输出、图片、备用屏、滚动区、鼠标、粘贴和 Kitty keyboard
状态；第二条由 shell/终端执行通用恢复。如果问题可以稳定复现，请不要只提交截图，同时说明
退出方式（正常、信号、崩溃或断开 SSH）。

## 性能或 SSH 卡顿

- SSH 默认 15 fps；确认没有用 `MOYU_FORCE_GRAPHICS=1` 强制高带宽图片档；
- 尝试 `MOYU_TIER=braille`；
- 检查是否存在持续刷新的 shell prompt、日志或 coding CLI 动画；
- 使用 `npm run bench -- --strip` 在仓库中测量本地渲染，不把网络延迟混入编码时间。

Moyu 在 stdout 拥塞时会优先内层 CLI 并跳过游戏帧。如果 CLI 自身也停止响应，请提交可复现的
输出规模和连接方式。

## 报告安全问题

命令注入、路径逃逸、配置破坏、隐私泄露或信任提示绕过请按照
[SECURITY.md](../SECURITY.md) 私密报告，不要创建公开 Issue。
