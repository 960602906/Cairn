# Changelog

本文件记录 Cairn 的用户可见变化，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- M5 发布硬化：应用身份、单实例、构建信息与关于页（M5-01）。
- 代码签名与发布流水线：PFX/Azure 签名、RFC 3161 时间戳、`signtool` 与
  Authenticode 双重校验、`latest.yml`/`beta.yml`、`SHA256SUMS`、依赖清单、
  构建来源证明与公开下载复验（M5-08）。
- 发布运行手册：证书轮换、更新源配置、dry-run、紧急撤包与恢复步骤
  （`docs/dev/release.md`）。

## [0.1.0] - 2026-11-10

首个公开 beta。Windows x64，按用户安装。

### Added

- 本地优先的桌面 Agent：会话、项目、文件改动、检查点与撤销。
- 模型供应商配置、凭据加密保存、权限规则与审批。
- 技能、MCP 服务、自定义 Agent、委派与隔离工作区。
- 活动中心、后台命令、运行检查器与脱敏诊断包。
- 中英文界面、四套内置主题与跟随系统。

### Changed

- 应用版本统一由根 `package.json` 提供，构建时写入版本、通道与提交信息。

### Security

- 单实例锁在打开数据库之前获取，避免两个实例同时写入。
- 诊断包导出前统一脱敏用户目录、API Key 与令牌。

[Unreleased]: https://github.com/960602906/Cairn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/960602906/Cairn/releases/tag/v0.1.0
