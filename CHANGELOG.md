# Changelog

本文件记录 Moyu 面向用户的重要变化。版本格式遵循 [Semantic Versioning](https://semver.org/)，
结构参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

## [0.2.0] - 2026-09-15

### Added

- 十个确定性 30 秒章节、章节检查点和跨章节 RNG 恢复。
- 独立 supervisor 与认证 terminal lease，用于 worker 崩溃后的终端恢复。
- Source/dist 启动 smoke、完整章节视觉基线和更严格的发布物一致性检查。
- Cartridge 微型/展开视图声明、原生设备像素渲染接口和宿主事件生命周期。

### Changed

- 候场状态缩减为右下安全边缘的单个 `·` / `•`，稳定状态不再产生周期输出。
- Codex 游戏视图优先覆盖在 composer 正上方两行，无法确认位置时安全回退到底部区域。
- stdout 背压优先保证内层 CLI 字节，并暂停 PTY 直到 drain。
- `MOYU_TIER=graphics` 改为安全尝试；仅 `MOYU_FORCE_GRAPHICS=1` 跳过保护。

### Fixed

- 修复退出竞态、PTY listener 泄漏、信号退出码和 supervisor 完成握手。
- 修复 `doctor --gfx` 非 TTY lease 错误，并在正常完成后保留诊断图片。
- 修复坏 Cartridge 阻止 wrapped CLI 启动、章节存档漂移和多项窄终端渲染问题。

## [0.1.0] - 2026-09-05

### Added

- 首个公开版本：终端内火柴人游戏、Codex/Claude Code 外壳和可选任务 hook。
- Kitty Graphics、Braille 与半块字符三档渲染。
- Git URL 全局安装所需的预编译 `dist/` 与 PTY 依赖。

[Unreleased]: https://github.com/PrometheusTT/moyu/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PrometheusTT/moyu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PrometheusTT/moyu/releases/tag/v0.1.0
