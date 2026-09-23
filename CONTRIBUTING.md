# Contributing to Moyu

[English](./CONTRIBUTING.en.md) · [返回首页](./README.md)

感谢你愿意改进 Moyu。终端程序的失败半径比普通 CLI 更大：一个小错误可能吞掉用户输入、打乱
coding CLI 输出，或让终端退出后仍停留在 raw mode。因此，本项目欢迎小而清晰、带验证证据的
改动，并把终端所有权与向后兼容视为第一优先级。

参与社区即表示你同意遵守 [行为准则](./CODE_OF_CONDUCT.md)。安全问题请遵循
[安全策略](./SECURITY.md)，不要创建公开 Issue。

## 开始之前

- 搜索现有 [Issues](https://github.com/PrometheusTT/moyu/issues) 和 Pull Requests，避免重复工作。
- Bug 请使用结构化 Bug Report；功能建议请说明真实使用场景，而不只是实现方案。
- 大型重构、新终端协议、Cartridge API 破坏性变化，建议先开 Issue 对齐边界。
- 小型修复、测试、文档与兼容性补充可以直接提交 PR。

## 本地开发

运行发布包只需要 Node.js 20；直接执行 TypeScript 源码和测试需要 Node.js 22.6 或更高版本。

```sh
git clone https://github.com/PrometheusTT/moyu.git
cd moyu
npm ci
npm run check
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 严格 TypeScript 检查，不写文件 |
| `npm test` | 运行组件、协议和 PTY-in-PTY 测试 |
| `npm run compile` | 将 `src/` 编译到必须提交的 `dist/` |
| `npm run smoke` | 验证源码与发布物在正常、零尺寸和极小终端中启动 |
| `npm run bench` | 运行无头渲染基准 |
| `npm pack --dry-run` | 检查最终发布文件清单 |

如果本机 npm 缓存权限异常，可临时使用：

```sh
npm pack --dry-run --cache /tmp/moyu-npm-cache
```

## 目录与边界

- `src/shell/`：PTY、字节透传、焦点、终端区域和恢复。这里的改动必须优先保护内层 CLI。
- `src/platform/`：Cartridge 加载、隔离、输入、存档和宿主生命周期。
- `src/render/`：字符与 Kitty Graphics 渲染，不拥有游戏规则。
- `src/core/`：内置游戏的确定性模拟。
- `src/app/`：命令入口和宿主编排。
- `test/`：目录结构尽量与 `src/` 对应；终端集成测试集中在 `test/shell/`。

详细设计见 [架构说明](./docs/architecture.md)。

## 项目特有的发布约束

### `dist/` 必须提交

Moyu 支持通过 Git URL 全局安装，并刻意不在安装阶段编译。因此源码变化后必须运行
`npm run compile`，并将对应的 `dist/` 一起提交。测试会重新编译并逐字节检查漂移。

### 不要新增安装期脚本

不要在 `package.json` 中新增 `build`、`prepare`、`prepack`、`install`、`preinstall` 或
`postinstall`。npm/pacote 会因此改变 Git 依赖安装路径，可能导致缺少 TypeScript、死软链或
在用户机器上执行不必要代码。发布检查脚本应使用 `check`、`verify`、`compile` 等安全名称。

### 保持 Node.js 20 发布兼容

源码可利用 Node.js 22.6 的类型剥离进行开发，但 `dist/` 必须能在 Node.js 20 启动。不要让
发布物依赖仅存在于新版本 Node 的 API，除非同时提高 `engines.node` 并更新兼容矩阵。

### 终端状态必须可恢复

涉及 raw mode、备用屏、滚动区、光标、Kitty 键盘协议或图片的改动必须覆盖：

- 正常退出与内层非零退出码；
- `SIGINT`、`SIGTERM`、`SIGHUP`、`SIGQUIT`；
- worker `SIGKILL` 后的 supervisor 恢复；
- stdout 背压、resize、备用屏切换与重复 teardown；
- 半块字符终端不接收 Kitty APC 删除序列。

## 编写测试

- 修复 Bug 时，先添加能稳定复现问题的最小测试。
- 纯状态逻辑优先写快速单元测试；真实启动、信号和终端恢复使用 PTY-in-PTY 测试。
- 随机游戏逻辑必须使用显式 seed，并断言可复现结果。
- 性能或视觉变化应更新 `docs/terminal-qa.md` 中的基线和复现方式。
- 不以延长 timeout 掩盖生命周期竞态；先证明等待的事件确实会发生。

提交 PR 前至少运行：

```sh
npm run check
npm run compile
npm run smoke
npm pack --dry-run
git diff --check
```

## Pull Request 要求

一个易于评审的 PR 应包含：

- 问题背景和用户可观察到的变化；
- 实现边界与没有选择其他方案的原因；
- 新增或更新的测试；
- 对终端、SSH、Cartridge API 或发布物的影响；
- 如有视觉变化，附终端、主题、字体、尺寸和截图/录屏；
- 更新后的 `dist/`、README、CHANGELOG 或相关文档。

保持提交聚焦；不要顺手格式化无关文件。维护者可能要求拆分过大的 PR。

## Commit 建议

项目不强制特定 commit 规范，但建议使用简洁的祈使式标题，例如：

```text
fix: restore the terminal after worker SIGKILL
feat: add a Sixel capability probe
docs: document Cartridge persistence boundaries
test: cover split Kitty keyboard sequences
```

## 文档与语言

面向用户的说明提供[中文](./README.md)和[英文](./README.en.md)版本；API 名称、命令和协议术语保留英文。
新增游戏文案须覆盖 `MOYU_LANG=zh` 和 `MOYU_LANG=en`，不要提交未经校对的大段机器翻译。

## 获得帮助

开发问题可以通过 [Support](./SUPPORT.md) 中的渠道提出。请勿在 Issue 中粘贴 token、完整环境
变量、私有路径、IP、prompt 或 agent 输出。
