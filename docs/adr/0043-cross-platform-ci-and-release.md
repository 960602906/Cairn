# ADR-0043 跨平台 CI 与发布流水线

- 状态：已接受（M6-07 实施）
- 日期：2026-11-16
- 相关决策：ADR-0035、ADR-0036、ADR-0039、ADR-0041、ADR-0042
- 相关文档：[发布运行手册](../dev/release.md)、[M6 计划](../plan/m6.md)

## 背景

M5 的 CI 与发布只覆盖 Windows：PR 在 `windows-latest` 与 `ubuntu-latest` 上跑测试，
`release.yml` 在 Windows 上构建、签名并发布 NSIS。M6-02 与 M6-03 分别补齐了 macOS
DMG/ZIP 与 Linux AppImage/deb 的打包脚本，但还没有：

- macOS 的 CI 回归（构建、冒烟、打包校验）；
- 按平台生成的更新元数据（`latest-mac.yml`、`latest-linux.yml` 与 beta 变体）；
- 一次发布汇总三个平台产物的流程；
- DCO 的 CI 强制校验（M6-06 留给 M6-07 决定）。

如果继续只在 Windows 发布，macOS/Linux 安装包只能手工构建，更新源与发布说明也没有
可重复的证据；这与“三个平台可用”的完成标准不一致。

## 决定

- **CI 使用三平台矩阵。** `check` job 在 `windows-latest`、`ubuntu-latest`、
  `macos-latest` 上运行 format、typecheck、lint、i18n、单测与覆盖率、build、smoke，并在
  三个平台都执行 `package:dir`、`package:verify`、`smoke:packaged`。Playwright e2e 在
  Windows 与 Linux 上运行；macOS 以打包冒烟 + 手工矩阵覆盖（M6 计划 §2.1），避免把
  runner 的窗口限制当成产品回归。
- **DCO 在 PR 上强制。** 新增 `dco` job，用完整克隆对 `base..head` 的非合并提交运行
  `scripts/check-dco.mjs`；每个提交都必须有与作者一致的 `Signed-off-by` 行。合并提交
  跳过，避免 base 分支的历史阻塞贡献者。
- **发布拆成 prepare → 三个平台构建 → assemble → publish。**
  - `prepare` 校验标签、版本与通道，并把 `tag` / `version` / `channel` 传给后续 job；
  - `build-windows`、`build-macos`、`build-linux` 各自在原生 runner 上构建、校验并整理
    本平台产物；`release-artifacts.mjs --platform <platform>` 生成该平台的更新元数据、
    校验和、发布说明与 `platform-notes.json`；
  - `assemble` 下载三个平台包，`merge-release.mjs` 合并为一次发布所需的目录，并生成
    合并的 `release-notes.md`、`provenance.json` 与 `SHA256SUMS`；
  - `publish` 只上传一次，避免 GitHub Release 被三个 job 并发改写。
- **更新元数据按平台命名。** Windows 使用 `latest.yml` / `beta.yml`，macOS 使用
  `latest-mac.yml` / `beta-mac.yml`，Linux 使用 `latest-linux.yml` / `beta-linux.yml`。
  macOS 的 ZIP 是更新载体，DMG 只用于安装；Linux 的 AppImage 是更新载体，deb 由包管理器
  升级。`release-artifacts` 校验 electron-builder 写出的元数据与实际上传文件逐项一致。
- **签名门禁按平台执行。** Windows 与 macOS 的 stable 版本必须有签名；Linux 没有统一
  代码签名，stable 允许 unsigned，但发布说明必须写明完整性依赖 SHA-256 与 HTTPS 更新源
  （ADR-0042）。beta 的 Windows/macOS 构建在签名失败时明确降级为 unsigned，并在发布说明
  中标注；stable 不允许降级。
- **macOS 双架构保留两份 better-sqlite3 预编译。** 同一个 macOS job 产出 arm64 与 x64
  应用；staging 只保留 `darwin-arm64.node` 与 `darwin-x64.node`，避免 x64 应用加载 arm64
  原生模块。koffi 只用于 Windows Job Object，macOS/Linux 不会加载它。
- **产物命名固定。** `mac.artifactName` 显式设为 `Cairn-${version}-${arch}.${ext}`，
  避免 electron-builder 给 ZIP 默认加 `-mac` 后缀而与校验脚本、更新元数据不一致。

## 备选方案

- **继续只在 Windows 构建全部平台**：需要交叉编译原生模块与签名工具链，且 macOS
  公证必须在 macOS 上完成，否决。
- **三个平台各自发布一个 GitHub Release**：更新源需要单一目录，客户端也会看到重复版本，
  否决。
- **用 electron-builder 的 publish 直接上传**：无法在发布前汇总三平台、统一校验和与
  provenance，也绕过了现有的失败关闭门禁，否决。
- **macOS 只发当前 runner 架构**：会让 Apple Silicon 或 Intel 用户无包可用，与平台矩阵
  不符；改为同一 job 双架构并保留两份预编译。
- **DCO 用第三方 action**：引入额外供应链依赖；脚本只依赖 Node 内置模块，便于审计与
  本地复现。

## 实施结果（M6-07，2026-11-16）

- CI：`.github/workflows/ci.yml` 增加 `macos-latest`、三平台打包校验与 `dco` job。
- 发布：`.github/workflows/release.yml` 拆为 `prepare`、`build-windows`、`build-macos`、
  `build-linux`、`assemble`、`publish`；每个平台独立上传
  `cairn-release-<version>-<platform>`，汇总后统一发布。
- 脚本：`scripts/release-artifacts.mjs` 支持 `--platform`；新增
  `scripts/merge-release.mjs`、`scripts/check-dco.mjs` 及单元测试。
- 打包：`pruneStagedDependencies` 在 macOS 保留两份预编译；`smoke:packaged` 只在
  Windows 校验随包 MinGit；`packaged-app` 按 `process.arch` 定位应用目录。
- macOS 打包冒烟使用独立钥匙串：safeStorage 的主密钥条目只信任创建它的二进制，而
  前一步 `pnpm smoke` 已用未打包的 Electron 在登录钥匙串创建了同名条目；打包应用读取时
  需要用户授权，无桌面的 runner 上以 `errSecAuthFailed` 失败。CI 在冒烟前把空的自建
  钥匙串设为搜索列表与默认钥匙串，让打包应用自己创建条目，仍然校验真实的 safeStorage。
- 文档：本 ADR、`docs/dev/release.md` §12、M6 计划与架构同步。

## 后果

- PR 的 CI 时长增加（macOS 安装、构建与打包），但三个平台的构建与打包路径都有回归。
- 发布需要三个 runner 全部成功；任一平台失败都会阻止上传，失败报告按平台保留。
- `latest*.yml` 的命名与平台绑定，客户端只能读取自己平台的文件；新增平台必须同时扩展
  `release-artifacts` 与合并脚本。
- DCO 会拒绝未签署的提交；贡献者需要 `git commit -s`，维护者在合并前修正历史。

## 未验证

真实标签发布、macOS Developer ID 签名/公证、Windows 签名降级路径、三平台更新下载与
`latest*.yml` 在客户端生效，都需要配置 secrets、证书与更新源后在真实 runner/真机上执行。
本 ADR 只记录流水线结构与单元测试证据；没有这些外部条件时，相关结论保持“未验证”。
