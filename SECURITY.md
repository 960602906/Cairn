# 安全策略 / Security Policy

## 支持范围 / Supported versions

Cairn 目前是 0.1.x beta。安全修复只进入最新发布的次版本；更早的版本请先升级。

Cairn is currently 0.1.x beta. Security fixes land in the latest minor release only; please
upgrade before reporting an issue against an older build.

## 报告漏洞 / Reporting a vulnerability

**请不要公开发 issue、PR 或讨论区帖子。** 请使用 GitHub 的私有漏洞报告：

1. 打开仓库的 **Security** 标签页；
2. 选择 **Report a vulnerability**（GitHub Security Advisories）；
3. 说明受影响的版本、复现步骤、影响范围；如果有 PoC，请一并提供。

**Do not open a public issue, pull request or discussion.** Use GitHub's private vulnerability
reporting (repository **Security** tab → **Report a vulnerability**) instead, and include the
affected version, reproduction steps, impact, and a PoC if you have one.

如果无法使用 GitHub 私有报告，请通过仓库所有者在 GitHub 主页上公开的联系方式私下联系，
不要公开细节。

## 我们如何处理 / What to expect

- 我们会在 7 天内确认收到，并在评估后给出初步结论与修复计划。
- 在修复发布前，我们不会公开漏洞细节；发布后会在发布说明中致谢（除非你要求匿名）。
- 修复会以补丁版本发布，并在 [CHANGELOG](CHANGELOG.md) 中记录。

We aim to acknowledge reports within 7 days, agree on a disclosure timeline with you, and credit
you in the release notes unless you ask to stay anonymous.

## 范围 / Scope

在范围内：

- 渲染进程突破隔离、绕过 IPC 校验；
- 权限规则、审批或沙箱被绕过（例如工具在未批准时写入工作区外文件）；
- 凭据泄漏（API Key 写入日志、诊断包、SQLite 明文等）；
- 路径校验被绕过（符号链接、大小写、`..`、UNC/设备路径）；
- 更新流程被劫持或校验被绕过；
- 依赖或随包二进制（MinGit、ripgrep）中的已知高危漏洞。

在范围外：

- 需要在本机已具备同等权限的攻击（例如已能读写用户目录）；
- 社会工程、垃圾信息；
- 未配置 API Key 时模型服务自身的报错；
- 第三方模型服务、操作系统或 Electron 自身的漏洞（请报告给对应上游，我们会在可行时跟进）。

## 安全设计 / Security model

边界与威胁模型见[架构设计](docs/architecture.md)、[ADR-0007 规则化权限](docs/adr/0007-rule-based-permissions.md)
与 [ADR-0034 Windows 命令沙箱](docs/adr/0034-windows-command-sandbox.md)。
报告前建议先阅读，避免与已知的、有意的降级行为（例如非 Windows 平台上沙箱不生效）重复。
