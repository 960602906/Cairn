# Cairn {{version}} 发布说明模板

> 用法：复制到发布草稿，替换占位符；不得删除“签名状态”“已知问题”“验证范围”三节。

## 版本与通道

- 版本：`{{version}}`
- 通道：`stable` / `beta`
- 构建提交：`{{commit}}`
- 构建时间：`{{buildTime}}`
- 支持系统：Windows 11（至少 24H2，正式支持）；Windows 10 22H2（best-effort）
- 安装形态：Windows x64、NSIS、按用户安装、无需管理员

## 本次变化

### Added

- {{added}}

### Changed

- {{changed}}

### Fixed

- {{fixed}}

### Security

- {{security}}

## 签名状态

- 安装包、主程序与卸载程序：已签名 / **unsigned beta**
- 证书主题与 `publisherName`：{{publisher}}
- 时间戳服务：{{timestampUrl}}
- 未签名时必须提示 SmartScreen 可能警告；不得宣称“已验证发布者”或“无警告”。

## 已知问题

- 沙箱默认档位限制工作区外写入与管理员权限，但网络尚未隔离；需要联网的命令按审批执行。
- 自动更新不做二进制降级；数据库版本过新时拒绝启动。
- Windows 10 22H2 已结束微软支持，仅尽力兼容。
- {{knownIssues}}

## 验证范围

- 单元、集成与覆盖率门禁：`pnpm test:coverage`
- 构建与冒烟：`pnpm build`、`pnpm smoke`
- 端到端：`pnpm e2e`
- 安装、启动、卸载与保留用户数据：{{installVerification}}
- 自动更新：{{updateVerification}}
- 未覆盖或未验证的环境：{{unverified}}

## 下载与校验

- 安装包：`Cairn-{{version}}-x64-setup.exe`
- 校验和：`{{sha256}}`
- 更新元数据：`latest.yml` / `beta.yml` 与 blockmap
- 第三方声明与 GPL 源码获取方式：安装目录 `THIRD_PARTY_NOTICES.txt`、应用内关于页
