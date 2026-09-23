# Scripted showcase / 自动演示录屏

The showcase plays seven sword arts in a fixed order, with two casts per art and a final boss shot. It uses the game's combat simulation and high-resolution renderer directly; it does not send fake keystrokes to your terminal. The English and Chinese runs use the same choreography and last about 26 seconds.

在支持高清的终端（Kitty、Ghostty、WezTerm 或 iTerm2）打开源码目录。源码脚本需要 Node.js 22.6+：

```sh
git clone https://github.com/PrometheusTT/moyu.git
cd moyu
npm ci
npm run showcase:zh
```

英文版运行 `npm run showcase:en`。放大终端窗口后用你习惯的录屏工具录制该窗口。脚本会自动切换七套剑法与中英文标题；播完停在片尾，按 `R` 可重播，空格暂停或继续，按 `Q`、`Esc` 或 `Ctrl+C` 退出。建议先录一遍，再裁掉开头调整窗口和片尾退出的操作。

For X, record `npm run showcase:en`; for Bilibili, record `npm run showcase:zh`. The script starts with maximum qi and unlocked arts so every move is visible in one short take; this is a staged showcase, not a normal progression run. Run `npm run showcase:en -- --dry-run` to check all seven casts without opening a terminal UI. If graphics do not start, run `npm run dev -- doctor --caps` in the same terminal and check its selected tier.
