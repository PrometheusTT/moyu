# Release Process

本文面向维护者。Moyu 发布到 npm registry，并同时创建对应的 GitHub tag/release；`dist/` 是发布物
的一部分，Git URL 安装继续作为默认分支验证和备用通道。

## 1. 准备版本

- 确认工作树只包含计划发布的改动；
- 更新 `package.json` 和 `package-lock.json` 中的版本；
- 将 `CHANGELOG.md` 的 Unreleased 内容移动到带日期的新版本；
- 检查 README、兼容矩阵和迁移说明；
- 对 Cartridge API 破坏性变化提供明确迁移路径。

## 2. 重建与验证

使用干净安装：

```sh
npm ci
npm run check
npm run compile
npm run smoke
npm pack --dry-run
npm publish --dry-run
git diff --check
```

必须确认：

- `git diff --exit-code -- dist` 在重新编译后没有额外漂移；
- package 清单包含 `bin/`、完整 `dist/`、README、LICENSE 和用户文档；
- package 清单不包含 `src/`、`test/`、`vendor/` 或本地配置；
- Node.js 20 dist smoke 与当前开发 Node 的 source/dist smoke 均通过；
- 新增模块能被发布物 import 跟踪测试发现。

涉及渲染或终端所有权时，还应运行对应人工终端矩阵，并将结果更新到
[terminal-qa.md](./terminal-qa.md)。

## 3. 提交发布候选

源码和 `dist/` 放在同一个 PR/commit 中。不要创建只更新源码、依赖安装时编译的发布候选。
合并前等待 CI 在所有 Node.js 矩阵上通过。

## 4. 验证 tarball

生成候选包，并从隔离 prefix 安装实际 tarball；不要用当前仓库的 `node_modules` 代替：

```sh
npm pack
npm install --global --prefix /tmp/moyu-release-check ./moyu-game-X.Y.Z.tgz
/tmp/moyu-release-check/bin/moyu --help
```

## 5. Tag、npm 与 GitHub Release

```sh
git tag -a vX.Y.Z -m "Moyu vX.Y.Z"
git push origin vX.Y.Z
npm publish --access public
npm view moyu-game@X.Y.Z version dist.integrity
```

根据 CHANGELOG 创建 GitHub Release，说明：

- 面向用户的新增与修复；
- 兼容性或配置变化；
- Cartridge API 迁移；
- 已知限制；
- 安装和升级命令。

不要从未经验证或包含额外本地文件的目录上传 tarball。npm 账户必须开启 2FA；优先为 GitHub
Actions 配置 npm Trusted Publishing 与 provenance，不在仓库或长期环境变量中保存个人 token。

## 6. 发布后

- 从全新临时 prefix 执行 `npm install --global moyu-game@X.Y.Z`；
- 运行 `moyu --help`、`moyu doctor`、`moyu play` 和一次 wrapped CLI smoke；
- 检查 release 链接、badge 与 CHANGELOG compare 链接；
- 将后续变化重新记录到新的 Unreleased 段落。
