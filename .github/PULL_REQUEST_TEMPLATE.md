## Summary / 变更摘要

<!-- In 2–5 sentences, explain what changed and what users will notice. / 简述用户可见变化。 -->

## Context / 背景与动机

<!-- Link an Issue or describe the current behavior and impact. / 链接 Issue 或描述现状与影响。 -->

Closes #

## Implementation / 实现说明

<!-- Explain key boundaries and tradeoffs. / 说明边界与取舍。 -->

## Validation / 验证

<!-- List commands and manual environments actually checked. / 列出实际验证。 -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run compile`
- [ ] `npm run smoke`
- [ ] `npm pack --dry-run`
- [ ] `git diff --check`

## Terminal and compatibility impact / 终端与兼容性影响

<!-- Use N/A if not applicable; otherwise note terminal, OS, Node, SSH/tmux, theme, font, and size. / 不适用写 N/A。 -->

## Screenshots or recording / 截图或录屏

<!-- Include captures for visual changes and their environment. Remove prompts, tokens, and private data. / 视觉变化请附脱敏截图。 -->

## Checklist

- [ ] Changes are focused; unrelated files are untouched. / 改动聚焦。
- [ ] Bugs have regression tests; new behavior covers failure and fallback paths. / 测试覆盖回退。
- [ ] Published `src/` changes include regenerated `dist/`. / 已更新发布物。
- [ ] No install-time npm scripts or Node 20 compatibility breaks. / 保持安装兼容。
- [ ] Terminal changes cover exit, signals, and recovery. / 已验证终端恢复。
- [ ] User-facing changes update README, docs, or CHANGELOG. / 已更新文档。
- [ ] I read CONTRIBUTING, SECURITY, and the Code of Conduct. / 已阅读贡献与安全说明。
