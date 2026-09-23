# Contributing to Moyu

[简体中文](./CONTRIBUTING.md) · [Back to README](./README.en.md)

Moyu shares a terminal with another program. A small change can swallow input or leave the terminal in raw mode, so please keep PRs focused and include evidence for behavior that users can see.

Before opening a PR, search existing [Issues](https://github.com/PrometheusTT/moyu/issues) and pull requests. Bug reports should include your OS, terminal and version, local/SSH/tmux setup, rendering tier from `moyu doctor --caps`, and steps to reproduce. Remove tokens, prompts, private paths, and hostnames from logs. For large changes to terminal protocols or the Cartridge API, open an Issue first.

## Local development

The distributed package runs on Node 20 or newer. Working with TypeScript source and tests requires Node 22.6 or newer.

```sh
git clone https://github.com/PrometheusTT/moyu.git
cd moyu
npm ci
npm run check
npm run compile
npm run smoke
git diff --check
```

Commit generated `dist/` alongside `src/`: GitHub installs do not compile on the user's machine. Do not add npm install-time scripts named `build`, `prepare`, `prepack`, `install`, `preinstall`, or `postinstall`; they break the Git URL installation path. Run `npm pack --dry-run` when changing package contents.

For terminal input, rendering, or teardown changes, test normal exit, signals, resize, alternate screens, paste, and focus handoff. Give the wrapped CLI priority: when in doubt, preserve its input and output. Tests live under `test/`; the [terminal QA matrix](./docs/terminal-qa.md) lists manual checks.

## Ways to contribute

- Fix a bug or improve a terminal fallback. Include the terminal/version and a regression test.
- Add a Chinese or English translation. Built-in game text lives in `src/i18n.ts` and the game HUD; `MOYU_LANG` selects a language for testing.
- Build a local game with the [English Cartridge quickstart](./docs/cartridge-quickstart.en.md). The full [API reference](./docs/cartridge-api.md) is currently in Chinese; the TypeScript types are in `src/platform/types.ts`. Cartridges are trusted JavaScript and run with the user's permissions.
- Propose a stage, enemy, boss move, or sword art in an Issue. Explain what the player sees, how they respond, and where it belongs in the difficulty curve.

PRs should describe the user-visible change, relevant tests, and any terminal or save-data impact. Visual changes benefit from a short capture with terminal, font, size, and theme noted. Follow the [Code of Conduct](./CODE_OF_CONDUCT.md) and report vulnerabilities through the [Security Policy](./SECURITY.md), not public Issues.
