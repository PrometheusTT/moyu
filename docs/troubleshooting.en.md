# Troubleshooting

[简体中文](./troubleshooting.md) · [Back to README](../README.md)

First run `node --version`, `moyu doctor`, and `moyu doctor --caps`. When reporting an issue, include your OS, terminal/version, local or SSH/tmux path, and whether it happens in `moyu play` or `moyu -- <cli>`. Remove tokens, prompts, hostnames, and private paths from logs.

## Windows install or update

Use the [native PowerShell installer](../README.md#quick-start); WSL is not required. If an older WSL installer gets HTTP 403, switch to the native installer instead of retrying the blocked Ubuntu download. Open a new WezTerm PowerShell tab after installation so PATH updates take effect.

To update an existing installation, follow the [remove-and-reinstall commands](../README.md#update). The package is installed from GitHub, not the npm registry, and running Moyu processes must be restarted.

## No `moyu` command

Check `npm prefix --global` and `npm list --global --depth=0`. Ensure the global npm command directory is on PATH, then open a fresh terminal tab. On Windows, run `npm.cmd` in PowerShell.

## `Ctrl+]` does not switch to the game

Update Moyu and restart `moyu -- <cli>`. Some terminals encode modified keys differently: iTerm2 can use xterm `modifyOtherKeys`, and Windows WezTerm can use Win32 Input Mode. Moyu supports both. `F12` is an alternate shortcut; if it works but `Ctrl+]` does not, check custom terminal key assignments.

## Graphics are missing or blurry

Run `moyu doctor --caps` to see the chosen tier and `moyu doctor --gfx` to test Kitty Graphics directly. Kitty, Ghostty, and WezTerm are high-resolution candidates; iTerm2 high-resolution play has also been reported by the project author. The capability probe decides your actual tier. SSH, tmux, and screen commonly select text. For Braille, use a monospaced font and check line height. Force a text tier for diagnosis with `MOYU_TIER=braille` or `MOYU_TIER=half` (PowerShell: `$env:MOYU_TIER='braille'`).

If a crash leaves the cursor or terminal state wrong, run `moyu doctor --reset`.
