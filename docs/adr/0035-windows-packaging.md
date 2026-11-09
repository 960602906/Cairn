# ADR-0035 Windows 打包与分发

- 状态：已接受（M5-00 起草，M5-02 实施并定稿；M5-03 只追加 MinGit 布局）
- 日期：2026-11-10
- 相关决策：ADR-0002、ADR-0008、ADR-0014、ADR-0034、ADR-0036
- 预研证据：[M5-00 预研报告](../plan/m5-spikes.md) §4；[`spikes/m5`](../../spikes/m5/README.md)

## 背景

现有 `electron-vite` 构建只产出 `out/main`、`out/preload`、`out/renderer`、`out/bin` 与第三方声明，没有安装包配置。直接把 `apps/desktop` 交给 `electron-builder` 会把 pnpm 工作区的符号链接与虚拟 store 一起带进 `app.asar`，导致体积膨胀、路径脆弱，并可能把开发依赖或工作区源码带进发布物。

候选方案：

1. 直接打包工作区；
2. 使用 `pnpm deploy` 产物直接打包；
3. 先生成只含构建产物、资源与运行时外部依赖的独立 staging，再打包；
4. 使用其他打包器。

方案 1 已在预研中产生约 144.9 MB 的 `app.asar` 与 20,777 个 `node_modules` 条目；方案 2 仍会复制虚拟 store（约 237 MB），不能解决 asar 膨胀；方案 4 需要重新验证 NSIS、签名、更新元数据与原生模块，收益不足。

## 决定

- **打包器使用 `electron-builder` 26.18.0，目标 Windows x64 按用户 NSIS。** 不要求管理员，`perMachine=false`，默认安装到用户目录，支持修改安装目录，保留用户数据，创建开始菜单与桌面快捷方式。
- **先 staging，再打包。** 构建流程复制 `apps/desktop/out` 与 `resources` 到独立目录，写入只包含运行时外部依赖的 `package.json`，执行扁平安装，然后由 `electron-builder` 打包。工作区 `node_modules`、测试、e2e、spikes、源码与 source map 不进入安装包。
- **运行时依赖以主进程实际加载为准。** 预研中的候选集合为 `better-sqlite3`、`koffi`、`yaml`、`fflate`、`diff`、`zod`、`i18next`；M5-02 必须从构建产物与工作区包的运行时 import 自动校验，不能长期手工维护。渲染进程依赖已由 Vite 打进 renderer；`@vscode/ripgrep` 的二进制已复制到 `out/bin/rg.exe`，不需要再分发 npm 包。
- **原生模块与二进制显式解包。** `asarUnpack` 至少包含 `out/bin/**`、`koffi`/`@koromix/**` 与 `better-sqlite3` 的原生 `.node`；`resources/skills` 通过 `extraResources` 放到 `resources/skills`。MinGit 后续也通过 `extraResources` 放入独立目录，不写入 asar。
- **安装器安全默认值。** `requestedExecutionLevel=asInvoker`，不请求提权；本地与普通 CI 设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，避免误用开发机证书。正式发布只由 release workflow 显式签名。
- **不要在生产配置中使用 `signAndEditExecutable=false`。** 预研为了跳过无证书签名使用了该开关，代价是同时跳过图标、版本资源与可执行文件元数据。M5-02 应保留资源编辑，只关闭签名（例如使用 `signExecutable=false`），正式签名时再打开。
- **保留 `grantFileProtocolExtraPrivileges`。** 生产界面通过 `file://` 加载 asar 内的 `out/renderer/index.html`；关闭该 fuse 会让 Chromium 拒绝加载本地页面。asar 完整性校验与 `onlyLoadAppFromAsar` 仍然开启，导航策略只允许应用自己的 `file:` 入口。这是有意保留的例外，不能为了“全部关闭”而破坏本地界面加载。
- **稳定产物命名。** 安装包使用 `Cairn-${version}-x64-setup.exe`，同时生成 blockmap 与校验和；发布元数据与更新源使用同一版本号。
- **已安装应用冒烟是硬门禁。** 构建通过不等于安装后可用；必须用临时 `CAIRN_USER_DATA_DIR` 在安装目录启动，验证 SQLite、koffi、ripgrep、skills、preload、renderer 与 Agent 宿主。
- **应用身份与版本由 M5-01 定稿。** `appId`、`productName`、`AppUserModelID`、单实例锁、构建信息与 `publisherName` 不在本 ADR 中重复；`publisherName` 必须与 M5-08 的证书主题一致。

## 备选方案

- **直接打包工作区**：已验证会带入工作区依赖与虚拟 store，否决。
- **`pnpm deploy` 直接打包**：仍复制虚拟 store，无法控制 asar 体积，否决为默认路径。
- **只打包 `out`，不安装运行时依赖**：主进程外部依赖会缺失，否决。
- **便携版/MSIX**：不在 M5 范围，后续评估。

## 实施结果（M5-02，2026-11-10）

- 打包链路为：`electron-vite` 产物 → staging（复制 `out`/`resources`、生成运行时 `package.json`、扁平安装、裁剪非目标平台 SQLite 预编译）→ `electron-builder`。运行时依赖由构建产物 import 自动探测，共 7 个：`better-sqlite3`、`diff`、`fflate`、`i18next`、`koffi`、`yaml`、`zod`。
- 实测体积：`app.asar` 18,167,736 字节（约 17.3 MiB），解包应用目录 401,726,853 字节，未签名安装包约 126.3 MB（约 120.4 MiB），blockmap 约 132 KB。安装包含构建时间戳，字节级不可复现，校验和以每次构建生成的 `.sha256` 为准。预研中的 144.9 MB asar 与 20,777 个 `node_modules` 条目没有进入最终安装包。
- fuses 实际配置：关闭 `runAsNode`、`enableNodeOptionsEnvironmentVariable`、`enableNodeCliInspectArguments`；启用 `onlyLoadAppFromAsar` 与 asar 完整性校验；按本 ADR 保留 `grantFileProtocolExtraPrivileges`。已验证安装版可加载 renderer、preload、IPC、SQLite、koffi（`native: "job-object"`）、ripgrep 与内置 `example` 技能。
- 打包回归：`files` 的源码排除必须写成根目录限定的 `!src/**`。写成 `!**/src/**` 会同时删除 `koffi/src/koffi/index.js`，安装后启动即 `Cannot find module`；`verify-package.mjs` 已加入 koffi 入口文件断言，避免同类回归。
- 安装/卸载验证：`smoke:installed` 在临时目录静默安装，断言主程序、卸载器、asar、`rg.exe`、skills、桌面/开始菜单快捷方式与 HKCU 卸载项；启动已安装程序跑完整冒烟；用安装版 `rg.exe` 执行一次真实命令；静默卸载后断言程序、快捷方式与注册表项消失，且 `CAIRN_USER_DATA_DIR` 保留。全程不触碰真实 `%APPDATA%\Cairn`。
- 未验证：干净 VM、Windows 10、真正的标准用户账户、中文用户名与长路径；未签名安装包的 SmartScreen 行为也未验证。这些留到 M5-10 的干净环境验收。

## 后果

- 打包流程多一个 staging 步骤，但产物可预测、可审计，安装包体积显著下降（预研中 `app.asar` 从 144.9 MB 降至约 19.1 MiB，安装包约 134.3 MB）。
- 运行时依赖清单错误会在安装后冒烟中暴露；这是发布阻塞项，不能用开发模式通过代替。
- 原生模块 ABI、Electron fuses 与 asar 完整性已由 M5-02 的打包/安装冒烟覆盖；中文用户名与长路径仍需 M5-10 在干净环境验证。
- MinGit 加入后安装包与安装目录体积会增加，具体增量记录到 ADR-0008 与 M5-03 实施记录。
