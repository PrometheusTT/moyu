<div align="center">

<h1>摸鱼 Moyu</h1>

<p><strong>Agent 在干活，你在掌机里。任务一结束，一键回到工作。</strong></p>

<p>
  <a href="https://github.com/PrometheusTT/moyu/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/PrometheusTT/moyu/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/PrometheusTT/moyu/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/PrometheusTT/moyu?display_name=tag&sort=semver"></a>
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<img src="./pic.png" width="760" alt="Moyu 的终端像素掌机插画">

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#它如何工作">工作方式</a> ·
  <a href="#cartridge-游戏生态">Cartridge</a> ·
  <a href="./CONTRIBUTING.md">参与贡献</a> ·
  <a href="./docs/troubleshooting.md">故障排查</a>
</p>

</div>

Moyu 是一个轻量、local-first 的终端游戏宿主。它把 Codex、Claude Code 或其他 coding CLI
放进真实 PTY，平时只在终端右下安全边缘显示一个安静的 `·`。按一次 `Ctrl+]`，即可在不
结束 agent 会话的前提下打开掌机；任务完成后，Moyu 保存游戏、把输入交还 CLI，并用 `•`
提示有未查看事件。

> [!IMPORTANT]
> Moyu 当前处于 `0.x` 阶段。核心终端安全边界有完整自动化测试，但 Cartridge API 在 `1.0`
> 之前仍可能调整。生产工作流中请先运行 `moyu doctor`，并保留常用终端的正常恢复手段。

## 为什么是 Moyu

- **工作优先**：CLI 的输入、输出、信号、退出码和终端状态始终优先于游戏。
- **一键往返**：`Ctrl+]` 进入或离开游戏；不会结束正在运行的 Codex/Claude 会话。
- **两行也能玩**：Codex 中可将 80×8 的微型构图放在输入框正上方两行。
- **多档渲染**：Kitty Graphics、彩色 Braille、半块字符逐级降级。
- **本地优先**：无需账户、daemon 或运行时服务端；存档保存在本机。
- **可扩展**：内置动作、网格和落块三类游戏，也支持本地 JavaScript Cartridge。
- **为终端失败而设计**：resize、备用屏、背压、信号退出和 worker 崩溃都有恢复路径。

```text
┌──────────────────── coding CLI ────────────────────┐
│  agent 正在运行；输入、滚屏与快捷键仍属于 CLI       │
│  ⠈⠙⠦ 火柴快斩 / 贪吃蛇 / 落块（两行微型模式）     │
├──────────────────── Codex 输入框 ──────────────────┤
└────────────────────────────────────────────────────┘
```

## 快速开始

### 环境要求

- Node ≥ 20（Node.js 20 或更高版本）
- macOS、Linux，或 Windows 10/11 + WSL（Windows 原生 PowerShell 暂不运行游戏）
- 一个交互式终端；普通 UTF-8 + ANSI 终端即可使用字符渲染

### macOS：安装与开玩

```sh
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/feat/live-on-enter'
moyu play
```

已有 Node 20+ 时只需这两条命令；没有 Node、但已装 Homebrew 时，可运行
`curl -fsSL https://raw.githubusercontent.com/PrometheusTT/moyu/feat/live-on-enter/install/macos.sh -o /tmp/moyu-install.sh && sh /tmp/moyu-install.sh`
自动安装 Node 和 Moyu。脚本见 [`install/macos.sh`](./install/macos.sh)。需要高清图形档，请在
Kitty、Ghostty 或 WezTerm 中运行；系统自带 Terminal.app 会退回字符档。

### Windows：一次设置，以后直接玩

在**管理员 PowerShell** 中运行以下命令。安装器会安装 WezTerm 和 WSL Ubuntu，
再在 WSL 内安装 Node 与 Moyu；已有的组件会跳过。若 Windows 要求重启，重启并完成
Ubuntu 首次创建用户名后，**再运行同一条命令**即可继续。

```powershell
$file = Join-Path $env:TEMP 'moyu-install.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/PrometheusTT/moyu/feat/live-on-enter/install/windows.ps1 -OutFile $file; powershell -NoProfile -ExecutionPolicy Bypass -File $file
```

完成后打开 WezTerm 的 `WSL:Ubuntu` 标签页，输入 `moyu play`。Windows 本机只负责显示，
Moyu 和 Node 运行在 WSL 内；无需安装 Linux 图形桌面。安装器是可检查、可重复运行的
[`install/windows.ps1`](./install/windows.ps1)，不会覆盖现有 WezTerm 配置。

两端都可运行 `moyu doctor --caps` 查看自动选档，或运行 `moyu doctor --gfx` 检查高清图片链路。
`moyu play` 现在也会自动使用终端支持的最高清晰度，不能显示图片时自动退回字符档。

当前从 GitHub 的 `feat/live-on-enter` 分支压缩包安装，无需 Git 或 SSH 密钥；`moyu-game` 尚未发布到 npm registry。
安装包包含编译后的 `dist/`，安装过程不需要 TypeScript、不执行构建脚本，也不会启动后台服务。

升级或卸载：

```sh
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/feat/live-on-enter'  # 升级
npm uninstall --global moyu-game                              # 卸载
```

### 开始玩

```sh
moyu -- codex          # 包住 Codex
moyu -- claude         # 包住 Claude Code
moyu play              # 独立打开掌机
moyu play snake        # 直接进入指定游戏
moyu games list        # 查看可用 Cartridge
```

第一次建议先运行 `moyu play` 熟悉按键，再包裹正在使用的 coding CLI。

## 操作

外壳默认把输入完整交给 coding CLI，只有明确进入游戏后，游戏键才由 Moyu 接管。

| 按键 | 行为 |
| --- | --- |
| `Ctrl+]` | 进入或离开游戏；SSH 下也可直接透传 |
| `F12` | `Ctrl+]` 的兼容备用键 |
| `Esc` / `q` | 从游戏返回 CLI，不结束 agent 会话 |
| `Tab` | 切换 Cartridge |
| `E` | 在两行微型视图与展开视图之间切换 |
| `?` | 显示或关闭帮助；帮助打开时暂停游戏 |
| `WASD` / 方向键 | 移动；不同 Cartridge 会使用其中一部分 |
| `J` / 空格 | 主动作、攻击、跳跃或直落，取决于当前游戏 |
| `Ctrl+C` / `Ctrl+G` / `Ctrl+Space` | 始终交给 coding CLI，不被 Moyu 占用 |

内置游戏：

- **Stick Slash / 火柴快斩·无尽江湖**：快斩、多足妖物、武侠剑谱；每关出怪 30 秒，此后停止刷怪，必须消灭全部敌人和 Boss 才结算。无关数上限，结算 1.4 秒后自动继续，也可按 J 立即出发。
- **Snake / 贪吃蛇**：方向键或 WASD 转向。
- **Blocks / 落块**：方向键或 WASD 移动，空格直落。

存档默认位于 `~/.moyu/state/`。收起游戏、查看帮助或隐藏画面时模拟会暂停，不会在恢复后
突然追帧。

### 无尽江湖：操作与养成

`A/D` 移动，`J` 快斩，空格跳跃，`U` 冲刺斩，`I` 旋斩；蹲下、移动或空中挥刀有不同变招。
`S` → `K` 护体罡气：340ms内顺序输入，立即解控并举剑定身防御，初始持续0.8秒、冷却6秒，不耗剑气；随修为提升至1.04秒、冷却4.5秒。受控、攻击收招和空中均可释放；防御期间不能移动、跳跃或出招，免疫控制、击退与受击打断，但仍正常扣血。金色护盾和固定防御姿态提示生效。单按K仍跳跃，护体冷却中按组合键只提示未就绪，不会误跳。
玩家步行移速提升20%（不联动提高敌速或冲刺距离），普通快斩260ms收招；移动起步更快，出招仍可走位。
普通击破获得 12 点剑气；普攻、冲刺斩、旋斩每次有效命中 Boss 同样获得 12 气（空挥和无敌期不算）。
储气上限 300；剑招击杀提升阅历，但不为自己补充剑气，演出期间的普通攻击仍可回气。
同一组按键根据当前剑气选择三档：起手（低于60）/ 中档（60～99）/ 高档（100以上）。
每档三式固定轮换，六脉每档两式；每次只扣单式费用，不清空剑气。各剑法、各档位独立记住进度，掉档、换剑法、气不足均不重置。
高档轮完一轮，最后一式自动带简短奥义收势，不另加按键，也不把整套剑招堆在一起。

| 组合键 | 剑法 | 低/中/高档单式消耗 | 解锁 |
| --- | --- | --- | --- |
| `S` → `U` | 独孤九剑 | 10/13/16 气 | 初始可用 |
| `S` → `I` | 六脉神剑 | 15/18/21 气 | 累计 12 击破 |
| `W` → `I` | 太极剑 | 15/18/21 气 | 累计 36 击破 |
| `S` → `D` → `U` | 天外飞仙 | 20/23/26 气 | 累计 60 击破 |
| `S` → `A` → `I` | 万剑归宗 | 20/23/26 气 | 累计 100 击破 |

独孤低档：总诀、破剑、破刀；中档：破枪、破鞭、破索；高档：破掌、破箭、破气。
六脉低档：少商、商阳；中档：中冲、关冲；高档：少冲、少泽。
例如60气出破枪后剩47气，下次按键进入低档；回到60气后继续破鞭，而非重出破枪。
所有演出、衍生招式与动漫彩蛋均为游戏化编排，完整招式见 `?` 剑谱，不声称复刻原作招式设定。
普通式约0.65秒，末式收势约1.2秒，仍可移动、跳跃与闪避；一次只增加一次熟练度，对同一Boss最多造成3次收势伤害。
尾光消散与接招分开：普通式420ms、末式900ms后可接下一剑法；收招前140ms内可缓存一次组合键，不会排成长串自动连发。

三键大招在 650ms 内按顺序输入，方向键也可替代 WASD；现有两键剑招不变。
剑谱另藏两份动漫彩蛋秘卷，按提示探索，第一次成功释放后会显示真名并永久记录熟练度。
战场位于左侧，宽度为此前版本约一半，并随窗口自适应：80/120/200列窗口分别为26/39/66列战场。
实际可走距离同步缩短；人物身高与移速保持稳定，背景等比例续接。右侧 HUD 最宽28列，不铺满剩余空间。
剑招采用收尖实心剑光：交错斩、错落指劲、阴阳双弧、飞仙斜斩、分批落剑、厚刃月牙、火焰横扫。
起势、爆发和消散有独立节奏；移除通用亮环、气浪与密集线框。
独孤破剑以交错剑痕截击，破枪以细长一线穿刺，不再叠加巨型菱形飞剑；六脉少商保留直线光波，商阳点射、中冲贯穿、关冲扇射、少冲回旋脉冲、少泽光剑落阵。
太极九式分别以引流、展翼、托月、双涡回雪、游龙、阴阳合璧、云瀑、双环两仪、归元表现，不套飞剑模板。
飞仙用羽锋与凌空斜落，万剑用带护手的实体剑阵，月牙用深蓝内核的厚刃月波，日轮用橙红火舌与金色余烬；各门派收势保持本门笔触。
按 `?` 打开暂停帮助查看完整剑谱，`[` / `]` 翻页；战斗中按方括号也会先打开帮助。
Boss 有生命刻度、受击闪白和击退；红色地线提示冲撞/地裂落点，地裂可跳跃或移开躲避。
竹林的螳螂与甲虫、石桥的蟹与鳗、沙漠的蝎、雪山的狼与冰晶、古塔的蝠与石像各有轮廓。

终端组合键可按顺序输入：两键招式约 0.34 秒、三键招式约 0.65 秒内完成，无需同时按住。三键招式按开始输入时的朝向释放，左右朝向使用同一组键位；例如先朝左，再输入 W>D>J，月牙就向左释放。
按 `E` 展开战场，按 `?` 查看各招等级、消耗和解锁进度。成功出招积累熟练度，第 6 / 24 / 54 / 96 次使用分别升至二 / 三 / 四 / 五重，多数剑招范围随之扩大。
累计阅历在20/60/120/220/360/540时提升修为，最高七重。每重使冲刺/旋斩冷却再缩短3%（最高18%），护体冷却缩短0.25秒、持续时间增加0.04秒；60/220/540阅历时生命上限依次升至5/6/7格，只补新增的一格血。成长由已有阅历自动恢复，旧存档保留收益；普攻伤害、移动与冲刺速度不随修为改变。HUD显示修为、下一重阅历和真实生命上限。
剑谱、阅历和剑气每 5 秒及收起时自动保存；关卡从最近完成的结算点续跑。旧版存档自动迁移，保留累计击破。
竹海、石桥、山门、大漠、雪岭、古塔循环出现；每三关有Boss，每九关出现高阶剑宗，其余Boss关轮换螳螂王、金甲虫王、冰晶王与蛛王；非Boss的第五关倍数出现剑客精英，同屏上限在第1/10/19/28关为3/4/5/6只；刷怪频率每三关提高一档，第22关封顶。
怪物Boss每三关增加一格生命：第3/6/12关为5/6/8格，第63关达到25格上限。剑宗只比同关怪物Boss多一格，第9/18关为8/11格，最高26格；剑客精英3～8格，分青锋突刺型与玄衣守反型。
头目技能逐步开放：第3关螳螂只用单斩，第21关再遇时双斩，第39关再遇时第二斩带0.3秒硬直；第6关甲虫先用短冲撞，第24关再遇时增加强击退。第12关冰晶只放一处冰阵，减速20%、持续0.4秒；第30关再遇时增至三处，减速40%、持续0.8秒，跳跃或离开蓝线可躲。硬直结束后1秒免疫再次硬控。新头目第39关起才在蓄势末尾0.2秒抗打断，以金色轮廓提示，仍正常受伤。前期蓄势更长，随关卡缓慢缩短，收招窗口由1.6秒缓降至1.1秒。
剑客共享主角的持剑骨架与剑谱；第5关精英与第9关剑宗先教一式、不自动格挡，第12关起允许两式与守势，第27关起剑宗开放第三式。前期追击较慢、蓄势较长；红色剑气表示敌方攻击。
正面普通攻击被架住时拼剑回4气，准确挥刀或旋斩截住近身剑招回6气；剑招、冲刺、旋斩和绕背可破守，普通有效命中回12气。
30秒仅结束出怪日程，战斗不限时；满场时Boss等待空位，不删怪腾位，必须全部击败才结算。玩家重生不恢复敌人血量。
追击速度最多提升 40%，攻击间隔最多缩短 35%，蛛王/剑客蓄势前摇最低 650ms；第39关起蛛王地裂增至五处落点。
蛛王阶段按剩余生命比例切换，新头目的技能解锁按关卡判断、不会因残血越级；场景循环不会重置成长；伤害仍为每击一格，保留跳跃/走位躲避窗口。

## 它如何工作

Moyu 不模拟 shell。它启动一个真实 PTY，并在终端、宿主与内层 CLI 之间维护清晰的所有权：

1. `bin/moyu` 选择源码或编译入口，并启动独立 supervisor。
2. worker 在接管 raw mode、滚动区或 Kitty 图片前先提交 terminal lease。
3. 内层 CLI 输出经过字节级透传，只重写必须限制在安全区域内的终端坐标。
4. 游戏帧是可丢弃工作；stdout 拥塞时优先暂停游戏并保证 CLI 字节有序。
5. worker 异常退出或被 `SIGKILL` 后，supervisor 使用最后确认的状态恢复终端。

更完整的模块边界、生命周期和测试层级见 [架构说明](./docs/architecture.md)。不可协商的产品
约束记录在 [PRODUCT.md](./PRODUCT.md)。

## 渲染与兼容性

| 档位 | 适用环境 | 特点 |
| --- | --- | --- |
| Kitty Graphics | Kitty、Ghostty、WezTerm 等兼容终端 | 原生 RGB 设备像素、最高画质 |
| 彩色 Braille | 主流 UTF-8/ANSI 终端、SSH、Termius | 每字符 2×4 逻辑像素，通用默认回退 |
| 半块字符 | 字形或协议能力受限的终端 | 每字符 1×2 逻辑像素，最低兼容档 |

Moyu 会主动探测能力。探测明确失败时不会盲发图片协议；在 `tmux`/`screen` 中默认使用字符档。
SSH 将宿主帧率降为 15 fps，本地默认为 30 fps。

调试覆盖：

```sh
MOYU_TIER=graphics moyu -- codex      # 优先尝试图片档，失败时安全回退
MOYU_TIER=braille moyu -- codex       # 强制通用字符档
MOYU_TIER=half moyu -- codex          # 强制最低兼容档
MOYU_CELL=16x34 moyu -- codex         # 手动指定终端格像素
MOYU_THEME=light moyu -- codex        # 原生像素浅色主题
MOYU_REDUCE_MOTION=1 moyu -- codex    # 关闭震屏与闪白
MOYU_OVERLAY=1 moyu -- my-codex       # 为自定义 Codex 启动器启用输入框识别
```

客户端实测状态、性能基线和人工验收步骤见 [终端兼容与视觉 QA](./docs/terminal-qa.md)。

## 可选的任务联动

不安装 hook 也能完整游玩。启用后，任务开始、完成或需要确认时，Moyu 可以保存状态、交还
输入焦点并更新候场标记。

```sh
moyu setup                         # 为检测到的 Codex / Claude Code 安装 hook
moyu install                       # 只预览计划，不写文件
moyu install --write               # 写入，并先备份原配置
moyu install --uninstall --write   # 卸载 Moyu 自己添加的部分
```

Codex 配置位于 `~/.codex/hooks.json`，Claude Code 配置位于 `~/.claude/settings.json`。
安装器会合并而不是覆盖已有配置。hook 只追加时间戳和 `start` / `done` / `notify` 事件，不写入
prompt、命令、输出、错误文本、文件路径或仓库名。

Codex 首次加载新 hook 时会显示 `Hooks need review`；需要选择 `Trust all and continue` 才会生效。

## Cartridge 游戏生态

本地 Cartridge 是一个包含 `moyu.game.json` 和 ESM 入口的目录：

```sh
moyu games add ./my-game          # 预览权限警告
moyu games add ./my-game --yes    # 明确信任后安装
moyu games remove my-game --yes
```

> [!WARNING]
> Cartridge 是受信任的本地 JavaScript 代码，不是沙箱。它拥有与 Moyu 进程相同的文件和网络
> 权限。只安装你阅读过或信任来源的 Cartridge。

API v1 的 manifest、生命周期、画布接口、像素渲染和最小示例见
[Cartridge 开发指南](./docs/cartridge-api.md)。

## 诊断与恢复

```sh
moyu doctor             # Node、PTY、hook 与事件文件状态
moyu doctor --caps      # 显示 graphics / braille / half 选择结果
moyu doctor --gfx       # 绕开探测，直接验证 Kitty 图片链路
moyu doctor --visual    # 交互式原生像素动作对比
moyu doctor --reset     # 无条件恢复常见终端模式并删除 Moyu 图片
```

遇到花屏、乱码、图片不显示、hook 不触发或 PTY 模块加载失败时，请查看
[故障排查指南](./docs/troubleshooting.md)。提交终端兼容问题前，建议附上 `moyu doctor --caps`
输出，并移除用户名、主机名、IP 和本地路径。

## 开发

开发源码需要 Node.js 22.6 或更高版本；发布后的 `dist/` 仍支持 Node.js 20。

```sh
git clone https://github.com/PrometheusTT/moyu.git
cd moyu
npm ci
npm run check       # 类型检查 + 完整测试套件
npm run compile     # 更新必须随仓库提交的 dist/
npm run smoke       # source/dist PTY 启动检查
npm pack --dry-run
```

贡献前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。项目使用 MIT License，并要求所有社区互动
遵守 [行为准则](./CODE_OF_CONDUCT.md)。安全问题请不要公开提交，参见
[SECURITY.md](./SECURITY.md)。

## 项目状态与路线

已经完成：

- 真实 PTY 外壳、终端 supervisor 与崩溃恢复
- 三档渲染、原生 Kitty 像素路径和确定性视觉/性能基线
- 三个内置 Cartridge 与本地 Cartridge API v1
- Codex / Claude Code 可选任务事件联动

仍在探索：

- 更多终端图片协议（例如 Sixel、iTerm2 inline images）
- 更广泛的真实终端、SSH 和 WSL 人工兼容矩阵
- Cartridge API 稳定化、示例模板与社区分发方式

版本变化记录见 [CHANGELOG.md](./CHANGELOG.md)。功能建议请使用
[Feature request](https://github.com/PrometheusTT/moyu/issues/new?template=feature_request.yml)。

## License

[MIT](./LICENSE) © 2026 Moyu contributors.
