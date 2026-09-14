# Security Policy

Moyu 直接处理终端输入输出、启动子进程，并可加载本地 JavaScript Cartridge。我们认真对待
命令执行、路径处理、配置写入、终端状态恢复和隐私边界相关的问题。

## 支持范围

| 版本 | 安全更新 |
| --- | --- |
| 默认分支与最新 `0.1.x` release | 支持 |
| 更早的 commit、fork 或修改版 | 不保证 |

在 `1.0` 之前，修复通常首先进入默认分支，并在确认影响后决定是否发布补丁版本。

## 私密报告漏洞

如果仓库 Security 页面显示 **Report a vulnerability**，请使用 GitHub 的
[Private vulnerability reporting](https://github.com/PrometheusTT/moyu/security/advisories/new)。如果该入口
尚未启用，请创建一条
[Private security channel request](https://github.com/PrometheusTT/moyu/issues/new?template=security_contact.yml)，
其中不要填写漏洞类型、受影响组件、复现方式或任何利用细节；维护者随后应创建 draft security
advisory 并邀请报告者进入私密讨论。

不要在公开 Issue、Pull Request 或 Discussion 中披露漏洞细节，也不要在复现材料中包含真实
token、私有仓库内容、prompt、agent 输出、用户名、主机名或公网 IP。

报告中请尽量包含：

- 受影响版本、commit 和安装方式；
- 操作系统、Node.js、终端和是否经过 SSH/tmux；
- 最小复现步骤和影响范围；
- 你确认过的攻击前提；
- 可安全共享的日志或 PoC；
- 是否已在其他地方披露。

如果上述两个入口都不可用，请通过维护者
[GitHub profile](https://github.com/PrometheusTT) 上公开的私密联系方式联系，并在标题中注明
`Moyu security`；在建立私密通道之前不要发送漏洞细节。

## 响应方式

维护者会尽快确认收到报告、验证影响，并在修复可用前避免公开利用细节。处理完成后，我们会
与报告者协调公告、CVE/GHSA 和致谢方式。响应速度取决于维护者可用时间，本项目目前不承诺
固定 SLA。

## 安全边界

以下行为属于安全问题的典型范围：

- 未经确认执行或安装非预期代码；
- Cartridge 路径逃逸、内置游戏覆盖或信任提示绕过；
- hook 安装器覆盖、删除或泄露用户已有配置；
- supervisor/worker 协议被非授权进程伪造；
- 终端输入被错误转发、敏感输出被写入事件文件；
- 恶意终端字节导致宿主越界、资源耗尽或不可恢复状态。

本地 Cartridge 被明确设计为**受信任代码**，拥有当前用户的文件和网络权限。一个已被用户明确
信任的 Cartridge 执行任意 JavaScript 本身不是漏洞；绕过确认、跨目录安装或影响其他 Cartridge
则可能是漏洞。

## 用户安全建议

- 只安装你阅读过或信任来源的 Cartridge。
- 使用 `moyu games add <dir>` 先查看安装计划，再决定是否加 `--yes`。
- 不要用管理员/root 身份运行 Moyu。
- 分享 `moyu doctor` 输出前删除身份、网络和路径信息。
- 终端状态异常时运行 `moyu doctor --reset`。
