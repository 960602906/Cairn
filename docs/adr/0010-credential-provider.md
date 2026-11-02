# ADR-0010 可扩展的凭据提供方与加密存储

- 状态：已接受
- 日期：2026-11-02

## 背景

第一版只支持用户自带 API Key。但以后可能需要中转服务、OAuth 登录等其他方式。如果模型调用处直接读取明文 key，后续扩展需要修改所有调用方。

## 决定

- 定义 `CredentialProvider` 接口，模型配置中只保存凭据引用（`credentialRef`），不保存明文。
- 第一版实现 `local-key`：使用 Electron `safeStorage` 加密保存，Windows 下基于 DPAPI。
- 密钥只在主进程解密，会话启动时通过 MessagePort 传给对应宿主进程。
- 密钥不写入环境变量、不进入日志、不传给渲染进程；渲染进程只能写入密钥和查询是否已配置。

## 备选方案

- **明文保存在配置文件**：最简单，但不安全。
- **keytar 等系统钥匙串库**：功能类似，但已停止维护；`safeStorage` 是 Electron 内置方案。

## 后果

- 增加中转或 OAuth 时，只需新增 `CredentialProvider` 实现。
- Linux 上 `safeStorage` 在没有系统密钥环时可能退化为弱加密，跨平台阶段需检测并提示用户。
