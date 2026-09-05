# 摸鱼 · moyu

**谁不想在 Claude Code 干活的时候酣畅淋漓地砍一顿火柴小人。**

`moyu -- claude` 把你的 coding CLI 原样包起来：CLI 照常用，输入框上方多出 1–2 行，
里面有一个像素火柴人在跑、跳、挥刀。任务跑完的那一刻，游戏里放一发清屏技，然后停住等你。

```
  ▁▂▃  <- 就这两行，在输入框上面
> 帮我把这个测试修绿
```

不是截图工具，不是状态栏 —— 是个真的能玩的东西，跑在真终端里，用 kitty graphics 直接送 RGB 像素
（Ghostty / kitty / WezTerm），送不了的终端自动退回半块字符。

## 装

```sh
npm i -g github:PrometheusTT/moyu      # 或者不装：npx github:PrometheusTT/moyu -- claude
```

需要 **Node ≥ 20**、macOS 或 Linux、以及 `git`（npm 要克隆这个仓库）。**不需要编译器** ——
PTY 走的是预编译产物（darwin/linux/win32 × x64/arm64 都有）。

装的时候 npm 会克隆仓库、跑一次 `prepare` 把 TypeScript 编成 `dist/`，所以第一次会多花十几秒。
**别加 `--ignore-scripts`** —— 那会跳过这次编译，装出来是个跑不起来的空壳。

想装某个特定版本（tag 或 commit）：

```sh
npm i -g github:PrometheusTT/moyu#v0.1.0
```

还没发到 npm registry 上，所以 `npm i -g moyu-game` 现在装不到东西。升级就是把上面那条重跑一遍。

## 玩

```sh
moyu -- claude          # 包住 Claude Code
moyu -- codex           # 包住 Codex
moyu demo               # 不包任何东西，整屏玩（调手感用）
```

| 按键 | |
|---|---|
| `A` / `D` | 走 |
| 空格 | 跳 |
| `J` | 砍 |
| `t` / `y` | 手动假装「任务完成」/「下一个任务开始」（不装 hook 也能玩） |

外壳热键都以 **`Ctrl+G`** 开头（按一下 `^G`，HUD 会立刻列出能按什么）：

| | |
|---|---|
| `^G g`（或 `^G Tab`） | 焦点在 CLI ↔ 游戏之间切。**焦点默认在 CLI**，所以打字永远不会被游戏吃掉 |
| `^G h` | 收起 / 展开游戏区 |
| `^G k` / `^G j` | 游戏区加高 / 变矮 |
| `^G r` | 重画（内层 TUI 花了的时候） |
| `^G q` | 退出 |

## 让它知道任务什么时候跑完

游戏靠一条 hook 拿到「任务开始 / 任务结束」的信号。装法：

```sh
moyu install            # 干跑：只打印会改哪个文件、加哪几条，什么都不写
moyu install --write    # 真的写（改之前会留一份带时间戳的备份）
moyu install --uninstall --write   # 摘掉
```

默认只动这台机器上真的存在的那个 CLI（`~/.claude` / `~/.codex`）。要点名：`--claude` / `--codex`。

| | 写到哪 | 装哪几个事件 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` 的 `hooks` | `UserPromptSubmit` → start，`Stop` → done，`Notification` → notify |
| Codex | `~/.codex/hooks.json` | `UserPromptSubmit` → start，`Stop` → done |

**Codex 还要多一步**：装完之后下次启动 codex 会问 `Hooks need review`，
必须选 **`Trust all and continue`**，否则 hook 不会跑（Codex 对没信任过的 hook 一律不执行）。
Claude Code 没有这一步。

不想让任何程序碰你的配置文件的话，用手动路径 —— 它永远可用：

```sh
moyu install --print          # 打印配置片段，自己复制粘贴
moyu install --print --codex
```

别的 CLI（Gemini CLI、aider、自己的脚本……）没有 hook 也能接：在任务前后各调一次

```sh
moyu signal start
moyu signal done
```

### 这条 hook 到底往外写什么

一行，两个字段：**时间戳 + 三个词之一**（`start` / `done` / `notify`），追加到 `~/.moyu/events.log`。

```
1788610271 done
```

**不写**：命令内容、命令输出、错误文本、文件路径、仓库名、你的 prompt。也不发任何网络请求，
不读你的凭据文件。游戏画面是会被截图发出去的，所以这条边界是设计出来的，不是省事省出来的。

hook 本身就是一行 shell（`mkdir -p … && printf … >> …`），声明成 `async` 所以不阻塞工具调用，
也不会为了写一行字去启动一个 Node 进程。想看它长什么样：`moyu install --print`。

## 出问题了

```sh
moyu doctor            # 体检：node 版本、PTY、事件文件、两个 CLI 装没装（只读，不改任何东西）
moyu doctor --caps     # 这个终端支持哪一档渲染（必须在真终端里跑）
moyu doctor --reset    # 终端被搞坏了（花屏、光标没了、残留图）—— 无条件还原
```

几个已知情况：

- **tmux 里退到半块字符档。** tmux 默认不透传 kitty graphics 的 APC 序列，赌不划算。
- **SSH 下自动降到 15fps。** 像素档 30fps 约 59 KB/s，SSH 上减半更稳。
- **游戏区看不见了？** `^G h` 再按一次；或者终端太窄/太矮时它会自己让位。
- **退出后屏幕上还有残影？** `moyu doctor --reset`。被 `kill -9` 掉时 `bin/moyu` 那层 sh 会自己补一次还原。

## 开发

```sh
npm test          # 266 个测试，不需要终端（PTY-in-PTY + 像素回读）
npm run typecheck # tsc --noEmit
npm run build     # 产出 dist/
npm run bench     # 无头跑渲染，报字节/帧和毫秒/帧
```

结构上分三块，风险和测法完全不同：`src/shell/`（字节级透传，最高风险，PTY-in-PTY 测）、
`src/core/`（纯函数模拟，零 I/O，无头单测）、`src/render/`（像素/半块两档，解码回读断言）。

## License

MIT
