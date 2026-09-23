# 摸鱼 Moyu · 火柴快斩

[English](./README.en.md) · [问题排查](./docs/troubleshooting.md) · [参与共创](./CONTRIBUTING.md)

在终端里玩的火柴人动作游戏。可以独立运行，也可以包住 Codex、Claude Code 等 coding CLI：工作时只占底部一行，按 `Ctrl+]` 进入游戏，再按一次回到工作。游戏会暂停并保存进度。

![斗笠火柴人在竹林中挥剑的火柴快斩封面](./cover-stick-slash.png)

## 玩法

`J` 快斩，`A/D` 移动，空格或 `K` 跳跃，`U` 冲刺斩，`I` 旋斩。依次按 `S`、`K` 可解控并短暂霸体防御；防御时不能移动或出招，仍会受伤。按 `?` 查看剑谱，`Esc` 或 `q` 返回 CLI，`F12` 可代替 `Ctrl+]` 切换。

每关约 30 秒刷怪，清空敌人才结算。每三关有 Boss，招式与控制逐步增加；玩家通过击破积累剑气、阅历和剑法熟练度，提升生命上限并缩短部分冷却。剑谱、成长和关卡进度自动保存。

## 终端与画质

需要 **Node ≥ 20** 和交互式终端。Moyu 会探测图形能力，自动选择 Kitty Graphics、彩色 Braille 或半块字符；运行 `moyu doctor --caps` 查看实际档位。

| 终端 | 系统 | 预期画质 |
| --- | --- | --- |
| Kitty、Ghostty、WezTerm | macOS / Linux；WezTerm 也支持 Windows 原生 | 可尝试 Kitty Graphics 高清档，失败时回退字符档 |
| iTerm2、macOS Terminal、VS Code 终端 | macOS / Linux | 字符档；iTerm2 图片协议暂未实现 |
| Windows Terminal / PowerShell | Windows 原生或 WSL | 字符档；高清建议用 WezTerm |
| SSH、tmux、screen | 跨平台 | 通常使用字符档 |

以上是支持路径和自动化测试覆盖，具体终端版本、字体与远程链路的画面仍需[人工验证](./docs/terminal-qa.md)。

## 安装

macOS / Linux（已安装 Node）：

```sh
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main'
moyu play stick-slash
```

macOS 缺少 Node 时可用[安装脚本](./install/macos.sh)。Windows 10/11 **无需 WSL**，在 PowerShell 中运行：

```powershell
$file = Join-Path $env:TEMP 'moyu-native-install.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/PrometheusTT/moyu/main/install/windows-native.ps1 -OutFile $file
powershell -NoProfile -ExecutionPolicy Bypass -File $file
```

安装器会补齐 Node 和 WezTerm。完成后新开 WezTerm 的 PowerShell 标签页，运行 `moyu play stick-slash`。已有 coding CLI 时运行 `moyu -- codex` 或 `moyu -- claude`；Windows 上须先安装对应 CLI 的 Windows 版本。

## 更新

当前只从 GitHub `main` 安装，尚未发布到 npm registry。为确保拿到同版本号下的最新提交，先卸载包，再重新安装；存档不会随 npm 包删除。macOS / Linux：

```sh
npm uninstall --global moyu-game
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main'
```

Windows PowerShell：

```powershell
npm.cmd uninstall --global moyu-game
npm.cmd install --global "https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main"
```

更新后退出并重新打开 Moyu；已经运行的进程不会热更新。

## 语言

内置游戏的 HUD、帮助、章节和战斗提示会按系统语言显示中文或英文；其他语言回退英文。可用 `MOYU_LANG=zh` 或 `MOYU_LANG=en` 覆盖。Windows PowerShell 示例：`$env:MOYU_LANG='en'; moyu play stick-slash`。第三方 Cartridge 使用自己的文案。

## 共创

欢迎报告 Bug、改进终端适配、翻译或设计新敌人和招式。先查阅 [Issues](https://github.com/PrometheusTT/moyu/issues)，再提交 Issue 或 Pull Request；小修复可直接发 PR。开发时运行 `npm ci`、`npm run check`、`npm run compile`，并把 `dist/` 与源码一起提交。新游戏可按 [Cartridge API](./docs/cartridge-api.md) 制作本地插件，详见[贡献指南](./CONTRIBUTING.md)。

可选任务联动：`moyu setup` 安装 Codex / Claude Code hook；`moyu install` 可先预览，`moyu install --write` 才写入。Codex 首次出现 `Hooks need review` 时须选 `Trust all and continue`。配置位于 `~/.codex/hooks.json` 或 `~/.claude/settings.json`；hook 不写 prompt、输出或错误文本。

## 卸载

如果启用了任务联动，先运行 `moyu install --uninstall --write` 移除 Moyu hook，再运行 `npm uninstall --global moyu-game`（Windows 用 `npm.cmd`）。存档和本地 Cartridge 留在 `~/.moyu`；只有确定不再需要时才手动删除该目录。Node 和 WezTerm 是独立软件，不会被卸载。

使用问题见[故障排查](./docs/troubleshooting.md)，安全问题见[安全策略](./SECURITY.md)。
