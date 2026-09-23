# 摸鱼 Moyu · 火柴快斩

在终端里玩火柴人动作游戏。可以独立运行，也可以包住 Codex、Claude Code 等 coding CLI：平时只占底部一行，按 `Ctrl+]` 进入战斗，再按一次返回工作。游戏会暂停并保存进度。

[快速开始](#快速开始) · [操作](#操作) · [玩法与成长](#玩法与成长) · [故障排查](./docs/troubleshooting.md)

## 快速开始

需要 **Node ≥ 20** 和交互式终端，支持 macOS、Linux 与 Windows 10/11。

macOS / Linux：

```sh
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/feat/live-on-enter'
moyu play stick-slash
```

macOS 尚未安装 Node 时，可使用 [安装脚本](./install/macos.sh)。

Windows 无需 WSL。在 PowerShell 中运行：

```powershell
$file = Join-Path $env:TEMP 'moyu-native-install.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/PrometheusTT/moyu/feat/live-on-enter/install/windows-native.ps1 -OutFile $file; powershell -NoProfile -ExecutionPolicy Bypass -File $file
```

安装器会补齐 Node.js 和 WezTerm。完成后新开 WezTerm 的 PowerShell 标签页，运行 `moyu play stick-slash`。

已有 Codex 或 Claude Code 时，可在对应系统中运行：

```sh
moyu -- codex
moyu -- claude
```

当前从 GitHub 分支安装，`moyu-game` 尚未发布到 npm registry。升级时重跑安装命令；卸载用 `npm uninstall --global moyu-game`。

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

普通攻击和剑招命中会积累剑气。以下剑法按顺序输入；剑气决定招式档位，使用次数提升熟练度与招式范围。

| 按键 | 剑法 | 解锁条件 |
| --- | --- | --- |
| `S` → `U` | 独孤九剑 | 初始可用 |
| `S` → `I` | 六脉神剑 | 累计 12 击破 |
| `W` → `I` | 太极剑 | 累计 36 击破 |
| `S` → `D` → `U` | 天外飞仙 | 累计 60 击破 |
| `S` → `A` → `I` | 万剑归宗 | 累计 100 击破 |

`S` → `K` 的护体罡气可主动解除控制并免疫击退、硬直，初始持续 0.8 秒、冷却 6 秒；它不是无敌。累计阅历会提升修为，增加生命上限，并缩短护体和部分招式冷却。剑谱、阅历与剑气会自动保存，关卡从最近完成的结算点续跑。完整数值和招式说明在游戏内按 `?` 查看。

## 画面与任务联动

Moyu 自动选择终端支持的画质：Kitty Graphics 高清像素、彩色 Braille 或半块字符。Kitty、Ghostty、WezTerm 可尝试高清档；运行 `moyu doctor --caps` 查看当前档位，`moyu doctor --gfx` 检查图片显示。

任务联动可选。启用后，agent 任务开始、完成或需要确认时，Moyu 会保存游戏并更新状态提示：

```sh
moyu setup                       # 安装检测到的 Codex / Claude Code hook
moyu install                     # 先预览将修改的配置
moyu install --write             # 写入配置并备份原文件
moyu install --uninstall --write # 移除 Moyu 添加的 hook
```

Codex 使用 `~/.codex/hooks.json`，Claude Code 使用 `~/.claude/settings.json`。安装器会合并现有配置；hook 仅记录事件和时间，不写 prompt、输出或错误文本。Codex 首次提示 `Hooks need review` 时，选择 `Trust all and continue` 才会启用新 hook。

## 开发与帮助

源码开发需要 Node.js 22.6+：

```sh
git clone https://github.com/PrometheusTT/moyu.git
cd moyu
npm ci
npm run check
npm run compile
```

终端异常可运行 `moyu doctor --reset`，其他安装与显示问题见 [故障排查](./docs/troubleshooting.md)。贡献说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)，项目采用 [MIT License](./LICENSE)。
