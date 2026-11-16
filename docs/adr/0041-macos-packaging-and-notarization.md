# ADR-0041 macOS 打包、签名与公证

- 状态：已接受（M6-02 实施）
- 日期：2026-11-16
- 相关决策：ADR-0002、ADR-0014、ADR-0035、ADR-0036、ADR-0040
- 预研证据：[M6-00 预研](../plan/m6-spikes.md) §2、§3

## 背景

M6 之前只有 Windows 安装包。macOS 需要独立的分发格式与安全模型：

- 应用必须放进 `.app` 包，用户通过 DMG 拖拽安装；自动更新使用 ZIP。
- Apple Silicon 与 Intel 都是受支持的目标，二者原生模块与可执行文件不同，不能混装。
- macOS 13 起 Gatekeeper 要求签名并使用 hardened runtime；对外分发还必须公证，
  否则用户需要手工绕过系统保护。
- Electron 依赖 JIT 与未签名可执行内存；启用 hardened runtime 后必须给出最小权限的
  entitlements，否则渲染进程或 V8 无法启动。
- 系统级依赖与 Windows 不同：没有 MinGit 需求（macOS 通常自带 Git），ripgrep 的二进制名
  不带 `.exe`，未打包目录名与资源位置也不同。
- 打包脚本与 `verify-package` 此前把 Windows 的路径、文件名与安装包结构写死。

## 决定

- **只使用 electron-builder，目标 DMG + ZIP。** 两个架构分别产出
  `Cairn-<version>-arm64.dmg|zip` 与 `Cairn-<version>-x64.dmg|zip`，统一写入
  `<file>.sha256`。DMG 负责首次安装，ZIP 供 `electron-updater` 更新；不生成 Universal
  包，避免把两份原生模块与可执行文件叠加。
- **macOS 打包只在 macOS 上执行。** `package:mac` 在非 darwin 平台直接失败并提示
  ADR-0041；与 NSIS 只能在 Windows 构建（ADR-0035）对称。staging 步骤继续复用，只按平台
  选择 ripgrep 文件名与资源目录，不在 Windows 上伪造 `.app`。
- **签名由 electron-builder 完成，材料只走环境变量。** `CAIRN_MAC_SIGN_MODE=none` 是默认值，
  用于本机与无证书 CI；`developer-id` 要求 `CAIRN_MAC_IDENTITY`（必须是
  `Developer ID Application:` 前缀）、`MAC_CERTIFICATE`/`CSC_LINK`、
  `MAC_CERTIFICATE_PASSWORD`/`CSC_KEY_PASSWORD`，以及 `APPLE_ID`、
  `APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。证书与密码只注入子进程环境，不出现在
  命令行、日志或 `build-info.json`；`CSC_IDENTITY_AUTO_DISCOVERY=false` 防止构建机自动挑错
  身份。
- **签名即公证。** `developer-id` 模式同时设置 `--config.mac.notarize=true`，由
  electron-builder 调用 `@electron/notarize`。缺少公证凭据时直接失败，不产出一个 Gatekeeper
  会拒绝的“已签名但未公证”DMG。`none` 模式明确产出 unsigned 内部包，不得进入 stable
  （发布门禁由 M6-07 接入）。
- **最小 entitlements。** `build/entitlements.mac.plist` 只包含
  `com.apple.security.cs.allow-jit`、`allow-unsigned-executable-memory` 与
  `disable-library-validation`：前两项是 Electron/V8 的硬要求，第三项用于加载随包原生模块。
  不申请摄像头、麦克风、网络客户端等不需要的权限。
- **应用菜单只装在 macOS。** 启动时用 `appMenu`、`editMenu`、`windowMenu` 三个 `role`
  组装菜单栏，标签与快捷键交给系统本地化；Windows/Linux 保持自绘标题栏，不设置应用菜单。
- **产物校验按平台分支。** `verify-package` 在 darwin 下检查
  `mac-arm64/Cairn.app/Contents/MacOS/Cairn` 或 `mac/Cairn.app/...`、`Contents/Resources`
  内的 asar/skills/app-update.yml、`out/bin/rg` 与 `darwin-<arch>.node`，不要求 MinGit；
  `--mac` 还校验四个安装包及其校验和。`sign:verify:mac` 在 macOS 上运行
  `codesign --verify --deep --strict`、`spctl --assess`，并对已公证的 DMG 运行
  `xcrun stapler validate`（ZIP 无法 stapling，以包内 `.app` 的签名与公证结果为准）。

## 备选方案

- **Universal 包**：单文件体验更好，但体积接近两份，且 `electron-builder` 仍需为两个架构
  准备原生模块；分架构产物更容易校验与回滚，否决。
- **只发 ZIP**：更新可用，但没有标准安装体验与 DMG 布局，否决。
- **关闭签名并跳过应用元数据编辑**：会与 ADR-0035 记录的问题相同——同时丢失图标与版本
  资源；这里用 `identity: null` 只关闭签名，保留 `.app` 的元数据，签名时显式覆盖。
- **自建 `codesign` 流程**：需要自己处理嵌套 helper、entitlements 继承、公证与 stapling，
  维护成本高；electron-builder 已覆盖这些步骤，否决。
- **无公证的 Developer ID 分发**：用户首次启动会被 Gatekeeper 拦截，不能作为公开 beta 的
  默认路径，否决。

## 实施结果（M6-02，2026-11-16）

- 配置：`apps/desktop/electron-builder.yml` 新增 `mac`（DMG + ZIP、arm64/x64、hardened
  runtime、entitlements、`notarize: false` 默认）与 `dmg` 布局；Windows 的 MinGit
  `extraResources` 移入 `win` 段，macOS/Linux 不再携带。
- 命令：`pnpm package:mac`（`packaging.mjs --mac`）、`pnpm sign:verify:mac -- --dist <dir>
  --version <version>`；签名配置与校验实现在 `@cairn/release-tools` 的 `mac-signing.mjs`。
- 校验：`verify-package -- --mac` 检查 `.app` 布局、平台原生模块、ripgrep、四个安装包与
  `.sha256`；`after-pack` 按平台把 `app-update.yml` 写进 `Contents/Resources`。
- 测试：`packaging.test.ts`、`verify-package.test.ts`、`after-pack.test.ts`、
  `mac-signing.test.ts`、`app-menu.test.ts` 用注入的平台标识覆盖 darwin 分支，不需要
  macOS 主机。
- **未验证（本机为 Windows）**：真实 DMG/ZIP 构建、Apple Silicon 与 Intel 实机安装、
  Developer ID 签名、公证、stapling 与 Gatekeeper 放行。它们需要在 macOS runner/真机上
  配置 Apple 开发者账号后执行；`latest-mac.yml`、跨平台 release workflow 与更新源分支属于
  M6-07，不在此处伪造验证结论。

## 后果

- 发布 macOS 版本需要 Apple Developer Program 账号、Developer ID 证书与应用专用密码；
  没有凭据时只能内部使用 unsigned 包。
- 两个架构各自构建与校验，发布清单从 1 个安装包变为 4 个文件 + 4 个校验和；更新源必须
  同时提供 ZIP 与 `latest-mac.yml`（M6-07）。
- macOS 打包无法在 Windows CI 上回归，需要 macOS runner；在此之前由单元测试保证参数、
  路径与校验逻辑，真机结论保持“未验证”。
- 应用菜单只在 macOS 安装，Windows/Linux 的自绘标题栏行为不变。
