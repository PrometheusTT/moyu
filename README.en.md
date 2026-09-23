# Moyu · Stick Slash

[简体中文](./README.md) · [Troubleshooting](./docs/troubleshooting.en.md) · [Contribute](./CONTRIBUTING.en.md)

A stick-figure action game inside your terminal. Play on its own or wrap Codex, Claude Code, or another coding CLI. While you work, Moyu occupies one quiet row. Press `Ctrl+]` to play and press it again to return; progress is saved automatically.

![A straw-hatted stick fighter slashing through a bamboo grove](./cover-stick-slash.png)

## Play

`J` slashes, `A/D` moves, Space or `K` jumps, `U` dash-slashes, and `I` spin-slashes. Press `S`, then `K`, to break control and guard with super armor. You cannot move or attack while guarding, and you still take damage. `?` opens the sword-art guide; `Esc` or `q` returns to your CLI. `F12` is an alternate focus shortcut.

Each stage spawns enemies for about 30 seconds and ends after you clear the field. A boss appears every three stages. Boss moves and control effects grow gradually; kills earn qi, insight, and sword-art mastery. Your health cap and some cooldowns improve as you progress. Saves include sword arts, growth, and completed stages.

## Terminals and graphics

Requires **Node >= 20** and an interactive terminal. Moyu probes the terminal and selects Kitty Graphics, color Braille, or half-block rendering. Run `moyu doctor --caps` to see the selected tier.

| Terminal | Platform | Expected output |
| --- | --- | --- |
| Kitty, Ghostty, WezTerm | macOS / Linux; WezTerm also on native Windows | Can use high-resolution Kitty Graphics; falls back to text when unavailable |
| iTerm2, macOS Terminal, VS Code terminal | macOS / Linux | Text rendering; iTerm2's image protocol is not implemented |
| Windows Terminal / PowerShell | Native Windows or WSL | Text rendering; use WezTerm for the high-resolution path |
| SSH, tmux, screen | Cross-platform | Usually text rendering |

These are supported paths with automated coverage, not a visual certification of every terminal version, font, or remote setup. See the [manual QA matrix](./docs/terminal-qa.md).

## Install

On macOS / Linux with Node installed:

```sh
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main'
moyu play stick-slash
```

On macOS without Node, use the [installer](./install/macos.sh). On Windows 10/11, **WSL is not required**. Run in PowerShell:

```powershell
$file = Join-Path $env:TEMP 'moyu-native-install.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/PrometheusTT/moyu/main/install/windows-native.ps1 -OutFile $file
powershell -NoProfile -ExecutionPolicy Bypass -File $file
```

The installer sets up Node and WezTerm if missing. Open a new WezTerm PowerShell tab and run `moyu play stick-slash`. To wrap an installed coding CLI, run `moyu -- codex` or `moyu -- claude`. On Windows, install the native Windows version of that CLI first.

## Update

Moyu currently installs from GitHub `main`; it is not published to the npm registry. To guarantee the latest commit even when the package version is unchanged, remove and reinstall the npm package. Your saves are kept. macOS / Linux:

```sh
npm uninstall --global moyu-game
npm install --global 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main'
```

Windows PowerShell:

```powershell
npm.cmd uninstall --global moyu-game
npm.cmd install --global "https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/main"
```

Restart Moyu after updating; running processes do not reload themselves.

## Language

Built-in game HUDs, help, chapters, and combat messages follow the system locale: Chinese for Chinese locales, English otherwise. Set `MOYU_LANG=zh` or `MOYU_LANG=en` to override. PowerShell example: `$env:MOYU_LANG='en'; moyu play stick-slash`. Third-party Cartridges provide their own text.

## Create with us

Report bugs, improve terminal compatibility, translate, or propose enemies and sword arts. Search [Issues](https://github.com/PrometheusTT/moyu/issues), then open an Issue or Pull Request; small fixes can go straight to a PR. For code changes, run `npm ci`, `npm run check`, and `npm run compile`, and commit `dist/` with the source. You can also build a local game with the [English Cartridge quickstart](./docs/cartridge-quickstart.en.md). See the [English contribution guide](./CONTRIBUTING.en.md).

Optional task integration: `moyu setup` installs Codex / Claude Code hooks. `moyu install` previews changes; `moyu install --write` applies them. If Codex asks `Hooks need review`, choose `Trust all and continue`. The hook files are `~/.codex/hooks.json` and `~/.claude/settings.json`; hooks never record prompts, output, or error text.

## Uninstall

If you enabled task integration, run `moyu install --uninstall --write` first, then `npm uninstall --global moyu-game` (`npm.cmd` on Windows). Saves and local Cartridges remain in `~/.moyu`; delete that directory manually only if you no longer want them. Node and WezTerm are separate applications and remain installed.

For help, see [Troubleshooting](./docs/troubleshooting.en.md). Report security issues through the [security policy](./SECURITY.md).
