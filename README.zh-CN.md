# 摸鱼 Moyu · 火柴快斩

在终端里玩火柴人动作游戏。可以独立运行，也可以包住 Codex、Claude Code 等 coding CLI：平时只占底部一行，按 `Ctrl+]` 进入战斗，再按一次返回工作。游戏会暂停并保存进度。

![斗笠火柴人在竹林中挥剑的火柴快斩封面](./cover-stick-slash.png)

[English](./README.md) · [快速开始](#快速开始) · [操作](#操作) · [剑法谱](#剑法谱) · [故障排查](./docs/troubleshooting.md)

## 快速开始

需要 **Node ≥ 20** 和交互式终端，支持 macOS、Linux 与 Windows 10/11。

macOS / Linux：

```sh
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main'
moyu play stick-slash
```

macOS 尚未安装 Node 时，可使用 [安装脚本](./install/macos.sh)。

Windows 无需 WSL。在 PowerShell 中运行：

```powershell
$file = Join-Path $env:TEMP 'moyu-native-install.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/PrometheusTT/moyu/main/install/windows-native.ps1 -OutFile $file
powershell -NoProfile -ExecutionPolicy Bypass -File $file
```

安装器会补齐 Node.js 和 WezTerm。完成后新开 WezTerm 的 PowerShell 标签页，运行 `moyu play stick-slash`。

已有 Codex 或 Claude Code 时，可在对应系统中运行：

```sh
moyu -- codex
moyu -- claude
```

Windows 上使用 `moyu -- codex` 或 `moyu -- claude` 前，先安装相应 CLI 的 Windows 原生版。目前从 GitHub `main` 安装，尚未发布到 npm registry。

## 操作

包住 coding CLI 时，未进入游戏的按键仍属于 CLI。

| 按键 | 作用 |
| --- | --- |
| `Ctrl+]` | 进入或离开游戏；`F12` 是备用键 |
| `Esc` / `q` | 返回 CLI，不结束会话 |
| `E` | 展开或收起战场 |
| `?` | 暂停并查看剑谱、招式和解锁进度；`[` / `]` 翻页 |
| `A` / `D` | 左右移动 |
| `J` | 快斩；移动、蹲下和空中会变招 |
| 空格 / `K` | 跳跃 |
| `U` / `I` | 冲刺斩 / 旋斩 |
| `S` → `K` | 护体罡气：解控并原地防御，期间不能移动或出招，仍会受伤 |

组合键按顺序输入，无需同时按住。`Ctrl+C`、`Ctrl+G` 和 `Ctrl+Space` 始终交给 coding CLI。

## 玩法与成长

每关刷怪约 30 秒，之后要击败场上全部敌人与 Boss 才能结算。每三关有 Boss；螳螂、甲虫、冰晶与蛛王轮换出现，早期招式简单，后续逐步加入连击、击退或短暂控制。红色地线与蓝色冰阵是躲避提示。

攻击命中积累剑气，击破敌人积累阅历。阅历解锁剑法，并永久提升生命上限、缩短部分冷却；使用剑法提升熟练度与范围。剑谱、阅历、剑气和关卡结算点自动保存。

## 剑法谱

按顺序输入按键；解锁数字指**累计阅历**，不是出招次数。剑气列为第一档基础消耗。

| 按键 | 剑法 | 解锁阅历 | 基础剑气 |
| --- | --- | ---: | ---: |
| `S` → `U` | 独孤九剑 | 初始可用 | 10 |
| `S` → `I` | 六脉神剑 | 12 | 15 |
| `W` → `I` | 太极剑 | 36 | 15 |
| `W` → `D` → `J` | 月牙天冲（隐藏秘技） | 48 | 20 |
| `S` → `D` → `U` | 天外飞仙 | 60 | 20 |
| `W` → `A` → `J` | 日之呼吸（隐藏秘技） | 80 | 20 |
| `S` → `A` → `I` | 万剑归宗 | 100 | 20 |

剑气低于 60 时使用第一档，60～99 使用第二档，100 及以上使用第三档；后两档分别多消耗 3、6 气。各档招式分别轮换，最高档最后一式有收势。游戏内按 `?` 可查看每式和当前进度。`S` → `K` 是独立的护体罡气：主动解控并免疫击退、硬直，初始持续 0.8 秒、冷却 6 秒；防御时不能移动或出招，仍会受伤。

想免操作录制全部剑法，可在源码目录运行 `npm run showcase:zh` 或 `npm run showcase:en`。步骤见[录屏指南](./docs/showcase.md)。

## 终端与画质

Moyu 自动选择 Kitty Graphics 高清像素、彩色 Braille 或半块字符。目前已知支持高清游玩的终端：

| 终端 | 系统 |
| --- | --- |
| Kitty | macOS / Linux |
| Ghostty | macOS / Linux |
| WezTerm | macOS / Linux / Windows |
| iTerm2 | macOS |

运行 `moyu doctor --caps` 查看当前画质档位，`moyu doctor --gfx` 检查图片显示。欢迎通过 [Issues](https://github.com/PrometheusTT/moyu/issues) 补充其他终端的使用情况；可参考[终端验证指南](./docs/terminal-qa.md)提供信息。

## 任务联动

任务联动可选。启用后，agent 任务开始、完成或需要确认时，Moyu 会保存游戏并更新状态提示：

```sh
moyu setup                       # 安装检测到的 Codex / Claude Code hook
moyu install                     # 先预览将修改的配置
moyu install --write             # 写入配置并备份原文件
moyu install --uninstall --write # 移除 Moyu 添加的 hook
```

Codex 使用 `~/.codex/hooks.json`，Claude Code 使用 `~/.claude/settings.json`。安装器会合并现有配置；hook 仅记录事件和时间，不写 prompt、输出或错误文本。Codex 首次提示 `Hooks need review` 时，选择 `Trust all and continue` 才会启用新 hook。

## 更新

当前从 GitHub `main` 安装，同版本号也可能有新提交。先卸载 npm 包再重装，存档会保留。macOS / Linux：

```sh
npm uninstall --global moyu-game
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main'
```

Windows PowerShell：

```powershell
npm.cmd uninstall --global moyu-game
npm.cmd install --global "https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main"
```

更新后重启 Moyu，已运行的进程不会热更新。

## 语言

内置游戏的 HUD、帮助、章节和战斗提示跟随系统语言：中文系统显示中文，其他语言回退英文。可用 `MOYU_LANG=zh` 或 `MOYU_LANG=en` 覆盖。PowerShell 示例：`$env:MOYU_LANG='en'; moyu play stick-slash`。第三方 Cartridge 使用自己的文案。

## 共创与开发

欢迎报告 Bug、验证终端、翻译，或设计敌人和剑法。先搜索 [Issues](https://github.com/PrometheusTT/moyu/issues)，再提交 Issue 或 Pull Request；小修复可直接发 PR。也可以按 [Cartridge 开发指南](./docs/cartridge-api.md) 制作本地游戏。完整流程见[贡献指南](./CONTRIBUTING.md)。

源码开发需要 Node.js 22.6+：

```sh
git clone https://github.com/PrometheusTT/moyu.git
cd moyu
npm ci
npm run check
npm run compile
```

源码改动后请把生成的 `dist/` 一起提交。

## 卸载

如果启用了任务联动，先运行 `moyu install --uninstall --write` 移除 Moyu hook，再运行 `npm uninstall --global moyu-game`（Windows 用 `npm.cmd`）。存档和本地 Cartridge 留在 `~/.moyu`；确定不再需要时才手动删除该目录。Node 和 WezTerm 是独立软件，不会被卸载。

终端异常可运行 `moyu doctor --reset`，其他问题见[故障排查](./docs/troubleshooting.md)。项目采用 [MIT License](./LICENSE)；安全问题见[安全策略](./SECURITY.md)。
