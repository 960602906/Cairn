# Cairn Privacy Notice / Cairn 隐私说明

Version 2026-11-10 · Applies to Cairn 0.1.0 beta
版本 2026-11-10 · 适用于 Cairn 0.1.0 beta

Cairn is a local-first application. It has no accounts, no cloud sync and no telemetry.
This notice explains what stays on your computer, what is sent to services you configure,
and what happens when you install, update or uninstall Cairn.

Cairn 是本地优先的应用，没有账号、云同步或遥测。本说明解释哪些内容留在本机、哪些内容
会发送给你配置的服务，以及安装、更新和卸载时会发生什么。

## 1. Accounts and telemetry / 账号与遥测

Cairn does not require registration or sign-in. It does not collect usage statistics,
crash reports, device identifiers or advertising identifiers, and does not upload content
automatically in the background.

Cairn 不要求注册或登录，不收集使用统计、崩溃报告、设备标识或广告标识，也不会在后台
自动上传内容。

## 2. Data stored locally / 本机数据

Cairn stores project records, sessions, settings, checkpoints, logs, installed skills and
local caches in the application data folder. On Windows the default is `%APPDATA%\Cairn`
(`Cairn-dev` for development builds). Project files remain in the folders you choose.

Cairn 在应用数据目录保存项目记录、会话、设置、检查点、日志、已安装技能与本地缓存。
Windows 默认位置是 `%APPDATA%\Cairn`（开发版为 `Cairn-dev`）。项目文件仍留在你选择的
目录中。

Uninstalling Cairn does not delete the application data folder. To remove all local data,
quit Cairn and delete that folder manually. Export or back up anything you want to keep
first.

卸载 Cairn 不会删除应用数据目录。要删除全部本地数据，请先退出 Cairn，再手动删除该
目录；删除前请先导出或备份需要保留的内容。

## 3. Model requests / 模型请求

When you send a message or run a task, the context selected for that turn is sent to the
model provider you configured. The provider processes that content under its own privacy
policy and terms. Cairn does not proxy model traffic through a Cairn-operated service and
cannot control what a third-party provider retains.

当你发送消息或运行任务时，该轮选定的上下文会发送给你配置的模型提供方。提供方按其自身
隐私政策与条款处理这些内容。Cairn 不通过自营服务代理模型流量，也无法控制第三方提供方
保留哪些内容。

## 4. API keys and credentials / API Key 与凭据

API keys, MCP tokens and similar secrets are stored locally using the operating system's
credential protection (`safeStorage`). They are not written to project files, logs,
diagnostics bundles or update metadata, and are never uploaded to Cairn.

API Key、MCP 令牌等凭据使用操作系统的凭据保护能力（`safeStorage`）保存在本机，不写入
项目文件、日志、诊断包或更新元数据，也不会上传给 Cairn。

## 5. Update checks / 更新检查

Update checks contact a public, read-only static update source over HTTPS. Requests ask for
version manifests and installers and do not include project content, sessions, settings or
credentials. The update source may see standard network metadata such as your IP address.

更新检查通过 HTTPS 访问公开只读的静态更新源，请求版本清单与安装包，不包含项目内容、
会话、设置或凭据。更新源可能看到 IP 地址等常规网络元数据。

## 6. Diagnostics bundles / 诊断包

Diagnostics bundles are created only when you choose to export them. They contain system
information, redacted settings and logs. Session message bodies are excluded by default and
require an explicit opt-in. Bundles are not uploaded automatically; you decide whether and
where to share them.

诊断包只在你主动导出时生成，包含系统信息、脱敏后的设置与日志。会话消息正文默认不包含，
需要额外开启。诊断包不会自动上传；是否分享、分享到哪里由你决定。

## 7. Skills and MCP / 技能与 MCP

Skill marketplace searches and MCP connections contact the services you choose. Those
requests are governed by the relevant service's privacy policy. Installed skills, MCP
configuration and credentials remain on your computer unless you remove them.

技能市场搜索和 MCP 连接会访问你选择的服务，相关请求受对应服务的隐私政策约束。已安装
技能、MCP 配置与凭据保存在本机，除非你主动删除。

## 8. Retention and deletion / 保留与删除

Local data remains until you delete it. Update installation creates a backup of the
database, settings and credential metadata before replacing files. Backups are kept
locally and follow the same deletion rules as other application data.

本地数据会一直保留，直到你主动删除。安装更新前会备份数据库、设置与凭据元数据；备份
保存在本机，并适用与其他应用数据相同的删除规则。

## 9. Changes and contact / 变更与联系

This notice is an engineering draft for the beta and must be reviewed by the project owner
and legal counsel before a stable release. Material changes will ship with a new version.
For privacy questions, use the distribution channel through which you received Cairn.

本说明是 beta 阶段的工程草案，正式发布前仍需项目负责人与法务确认。重要变更会随新版本
发布。隐私相关问题请通过你获取 Cairn 的分发渠道联系发布者。
