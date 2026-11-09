# M5-00 预研报告

> 状态：已完成（2026-11-10，Windows 本地实测）。
> 上级文档：[M5 计划](m5.md)。预研代码：[`spikes/m5`](../../spikes/m5/README.md)。

## 1. 结论

| 预研 | 结论 | 对计划的影响 |
|---|---|---|
| S1 沙箱兼容性 | **受限令牌回退 go；AppContainer no-go（不作为默认）**。受限令牌 + 低完整性 + Job Object + 工作区 ACL 可运行全部目标开发命令、阻断越界写与管理员操作，但网络无法隔离。AppContainer 可创建工作区并阻断越界写，但用户目录中的 Node、pnpm、Python、ripgrep、Git 工具无法启动。 | M5-04 默认实现 `restricted-workspace`；AppContainer 只保留实验/诊断能力。界面与 ADR 必须标注“网络未隔离”。 |
| S2 打包 | **go**。先用扁平生产依赖目录再交给 electron-builder，可避免把工作区 pnpm 虚拟 store 打进 `app.asar`；`--dir`、NSIS、资源与原生模块检查通过，已安装应用冒烟与卸载通过。 | M5-02 采用“构建产物 + 运行时依赖清单 → 独立 staging → electron-builder”流程；必须在安装后冒烟中验证依赖清单。 |
| S3 更新 | **go（本地已验证）**。generic HTTPS 静态源可完成检查与完整下载；404、断网、错误 SHA512、截断包、未签名包、无效代理均按预期失败。自签名证书只用于预研。 | M5-06 使用 `electron-updater` generic provider，下载后必须严格校验 SHA512、文件大小与 Authenticode；差分下载、磁盘不足和真实签名包在 M5-06/M5-08 补验。 |
| S4 MinGit | **go**。官方 MinGit 2.56.0.4 64 位 zip 校验通过；裁剪后约 27.5 MiB，`init/add/commit/status/rev-parse/cat-file/diff/checkout` 全部通过。 | M5-03 按本报告名单裁剪，固定 SHA256；以真实检查点流程而不是 `git --version` 作为验收。 |
| S5 签名 | **条件 go**。目标为 OV 云签名或 Azure Artifact Signing（受地区限制），必须使用 SHA-256 + RFC 3161 时间戳并 `signtool verify /pa`。未取得证书时只能发布明确标注的 unsigned beta。 | M5-08 前必须完成证书申请；`publisherName` 使用完整 DN，更新器注入失败关闭的自定义验证器。 |

## 2. 环境与边界

| 项目 | 值 |
|---|---|
| 系统 | Windows 11 24H2，`10.0.26100` |
| 账户 | 当前登录账户可提权但进程未提权；所有预研均在未请求 UAC 提升的令牌下运行 |
| Node | 26.13.0 |
| pnpm | 10.28.0 |
| Git | 2.47.0.windows.2 |
| Python | 3.12.10 |
| .NET SDK | 10.0.201 |
| ripgrep | 15.2.0 |
| Electron | 45.2.1 |
| electron-builder | 26.18.0 |
| electron-updater | 6.8.11 |

**未验证且不能外推的条件**：

- 真正的标准用户（非管理员、未经过滤的管理员令牌）。当前账户是过滤后的管理员令牌，只能证明“未提权可用”，不能证明“标准用户可用”。
- Windows 10 22H2。
- 干净虚拟机、首次登录用户、中文用户名、长路径与受控企业策略。
- 真实 OV/EV 证书签名后的更新安装。

这些条件由 M5-10 的干净 VM 验收补齐；在补齐前，文档不得声称已完成正式支持矩阵。

## 3. S1 沙箱兼容性

### 3.1 假设

在未提权的普通进程中，可以用 `koffi` 调用 Windows API 创建两种工作区沙箱：

1. `restricted-workspace`：`CreateRestrictedToken`（禁用最大权限与 LUA）+ 低完整性 + Job Object + 工作区 ACL。
2. `appcontainer-workspace`：AppContainer SID + 工作区 ACL；默认不授予网络能力，审批后授予 `internetClient` / `privateNetworkClientServer`。

目标是运行常见开发命令、阻止工作区外/系统目录写入与管理员操作、确保子进程继承沙箱并随超时结束。

### 3.2 方法

入口：`spikes/m5/src/s1-sandbox.mjs`，Windows API 封装在 `spikes/m5/src/windows-api.mjs`。

每种模式运行同一组真实命令：

- `node --version`、`pnpm --version`、`git --version`、`python --version`、`dotnet --version`、`rg --version`
- 工作区 `tsc`、`eslint`、`vitest`
- 中文输出
- 工作区写入、工作区外写入、`C:\Windows` 写入、`net session`
- 本机回环 HTTP
- `pnpm install --ignore-workspace --ignore-scripts`（工作区本地 store/cache，显式 npm registry）
- 启动子进程后 2 秒超时，检查父子 PID 是否都退出

AppContainer 额外测试默认网络、`internetClient` 能力与本地回环。

### 3.3 结果

**受限令牌**

- 9 个工具命令全部退出 0；中文输出正常。
- 工作区写入成功；工作区外与 `C:\Windows` 写入被拒绝。
- `net session` 失败，未获得管理员能力。
- 本机回环 HTTP 成功，说明网络未被隔离。
- `pnpm install` 成功，耗时约 1.8～3.0 秒。
- 2 秒超时后父进程与子进程均退出，`childInheritance=true`。

**AppContainer**

- AppContainer 配置创建、ACL 授予、进程启动均未请求提权。
- 工作区写入成功；工作区外与系统目录写入被拒绝；管理员操作失败。
- `dotnet --version` 与简单 `cmd` 命令可运行。
- 用户目录中的 `node`、`pnpm`、`python`、`rg`、Git 工具全部无法启动；`tsc`/`eslint`/`vitest` 也失败。Git 还因无法打开 `/dev/null` 失败。
- 默认网络：DNS 解析失败/连接超时；授予 `internetClient` 后 HTTPS 请求返回 HTTP 200。说明网络能力本身可用。
- 授予 `privateNetworkClientServer` 后本机回环仍超时；AppContainer 回环需要额外豁免，本次未实现，因此不作为已支持能力。
- 由于 `node` 无法启动，AppContainer 的长进程/子进程继承测试没有有效结果；“`childInheritance=false`”只表示测试命令未启动，不是进程泄漏证据。

### 3.4 结论

**AppContainer no-go 作为默认档。** 它满足写入隔离与网络默认拒绝，但不满足“node/pnpm/git/python/rg/tsc/vitest 必须可运行”的 go 门槛；在用户目录工具链普遍不可访问的情况下，日常开发命令会大面积失败。

**受限令牌 go。** 它满足命令兼容性、越界写阻断、管理员阻断与进程树清理，但网络可用且无法隔离。M5-04/05 必须：

- 默认使用 `restricted-workspace`，而不是把受限令牌描述成网络沙箱；
- 在设置、审批、命令卡片、事件与诊断中明确“工作区可写，网络未隔离”；
- 把 AppContainer 保留为实验档或诊断项，在满足兼容性门槛前不得设为默认；
- 沙箱创建失败时默认失败关闭，只有用户显式选择“本次不使用沙箱”才执行，并写事件；
- 只保护 `run_command` / `start_command` 启动的进程树，不宣称覆盖 MCP 服务、Agent 宿主或主进程。

## 4. S2 打包

### 4.1 假设

`electron-builder` 可以生成 Windows x64 按用户 NSIS 安装包；只要把生产依赖扁平化到独立目录，就不需要把 pnpm 工作区的符号链接与虚拟 store 带进 `app.asar`。

### 4.2 方法

入口：`spikes/m5/src/s2-package.mjs`，产物检查：`spikes/m5/src/check-package.mjs`。

1. 复制 `apps/desktop/out` 与 `resources` 到 `spikes/m5/work/s2-app`。
2. 从桌面包的依赖中只保留主进程/工作区包在运行时直接 `require` 的外部依赖：`better-sqlite3`、`koffi`、`yaml`、`fflate`、`diff`、`zod`、`i18next`。
3. 在该目录执行 `npm install --omit=dev`，得到扁平 `node_modules`。
4. 运行 `electron-builder --dir` 与 `--win nsis`。
5. 检查 `app.asar` 必需文件、`asarUnpack` 原生模块、`resources/skills`、安装包与 blockmap。
6. 静默安装到临时目录，用 `CAIRN_SMOKE=1` 与临时 `CAIRN_USER_DATA_DIR` 启动；随后静默卸载。

镜像环境变量：

```text
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
CSC_IDENTITY_AUTO_DISCOVERY=false
```

### 4.3 结果

- 直接把工作区交给 electron-builder：`app.asar` 约 144.9 MB，包含 20,777 个 `node_modules` 条目。
- 扁平化全部生产依赖：`app.asar` 约 78.1 MB，仍有 9,910 个条目。
- 只保留运行时外部依赖：`app.asar` 约 19.1 MiB，安装包约 134.3 MB（128.1 MiB），`app.asar.unpacked` 约 33.1 MiB。
- `check-package.mjs` 通过：`out/main/index.js`、`agent-host.js`、preload `.cjs`、renderer、`out/bin/rg.exe`、第三方声明、koffi/better-sqlite3 原生模块与 `resources/skills` 均在。
- NSIS 安装退出 0；已安装应用冒烟退出 0，渲染界面、IPC、数据库、凭据、ripgrep、假运行时对话全部通过。
- 卸载退出 0，安装目录删除，临时用户数据中的 `data/cairn.db` 保留。

### 4.4 结论

**go。** M5-02 采用独立 staging 目录，不直接打包工作区 `node_modules`。必须补强：

- 运行时依赖清单不能长期手工维护；M5-02 应从主进程构建产物的实际 import 自动生成或校验。
- 本轮 `npmRebuild=false`，只验证了现有预编译模块能被加载；M5-02 要验证 `better-sqlite3` 与 Electron ABI，并在需要时显式 rebuild。
- 本轮 `signAndEditExecutable=false` 会跳过图标、版本资源与签名；正式配置只应在未签名本地构建中关闭签名，不能关闭资源编辑。
- 本轮没有验证 Electron fuses、asar 完整性校验、中文用户名、长路径与真正干净用户账户。
- 安装包仍约 134 MB，主要来自 Electron 运行时；MinGit 加入后需重新记录体积。

## 5. S3 自动更新

### 5.1 假设

`electron-updater` 能从公开只读 generic HTTPS 静态源检查并下载新版本；元数据、blockmap、SHA512 与 Authenticode 校验失败时必须拒绝。

### 5.2 方法

入口：`spikes/m5/src/s3-update-source.mjs`。

1. 用自签名证书启动本地 HTTPS 静态源，生成 `latest.yml`、安装包与 blockmap。
2. 在 Electron 主进程中把当前版本固定为 `0.1.0`，检查 `0.1.1`。
3. 关闭差分下载，验证完整下载。
4. 分别测试正常源、404、断网、错误 SHA512、截断包、未签名包与无效代理。
5. 使用独立的 `LOCALAPPDATA`、`userData`、`cache`，不污染真实应用数据。

### 5.3 结果

| 用例 | 期望 | 结果 |
|---|---|---|
| 正常检查 | 发现 `0.1.1` | 通过 |
| 正常下载 | 下载成功 | 通过，文件位于临时 updater cache |
| 404 | 失败并报告 404 | 通过 |
| 断网 | 请求失败 | 通过，`ERR_CONNECTION_REFUSED` |
| 错误 SHA512 | 校验失败 | 通过，`sha512 checksum mismatch` |
| 截断/损坏包 | 校验失败 | 通过，`sha512 checksum mismatch` |
| 未签名包 + `publisherName` | 拒绝 | 通过，`ERR_UPDATER_INVALID_SIGNATURE` |
| 无效代理 | 连接失败 | 通过，`ERR_PROXY_CONNECTION_FAILED` |

### 5.4 结论

**go，但只验证了本地静态源与完整下载。** M5-06 必须：

- 正式源使用公开可信 CA 的 HTTPS；自签名证书只允许出现在测试。
- `autoDownload=false`、`autoInstallOnAppQuit=false`、`allowDowngrade=false`。
- 下载后校验 SHA512、文件大小与 Authenticode；配置完整 `publisherName` DN。
- `electron-updater` 6.8.11 的默认 Windows 验证器在 PowerShell 无法执行或输出异常时可能放行；必须注入自定义严格验证器，任何异常都返回失败。不要依赖默认验证器的 fail-open 行为。
- 在 M5-06 补验差分下载、磁盘不足、下载中断重试、真实签名包与真实安装升级。
- 运行中任务、待审批与检查点恢复期间禁止静默重启。

## 6. S4 MinGit

### 6.1 假设

官方 MinGit 2.56.0.4 64 位 zip 可以按固定 SHA256 获取；裁剪后仍能完成检查点所需全部 Git 命令。

### 6.2 方法

入口：`spikes/m5/src/s4-mingit.mjs`。

- 从 npmmirror 的 git-for-windows 镜像下载，固定官方 SHA256。
- 解压后删除文档、man、locale、gitweb、perl、MSYS 运行时与 GCM/Avalonia/Skia 等检查点不需要的文件。
- 在裁剪目录中设置 `GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR`、`PATH`，运行真实命令并验证 `diff` 与 `checkout` 恢复内容。

### 6.3 结果

- 压缩包：`MinGit-2.56.0.4-64-bit.zip`，39,846,926 字节。
- SHA256：`e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877`。
- 完整解压：96,237,338 字节；裁剪后：27,488,263 字节，225 个文件。
- `--version`、`init`、`config`、`add`、`commit`、`status --porcelain`、`rev-parse`、`cat-file`、`diff`、`checkout` 全部退出 0。
- `checkout -- a.txt` 能把修改恢复为提交内容；测试关闭 `core.autocrlf` 以按字节比较。
- 许可证文本包含 GPLv2；正式分发必须附全文并提供源码获取方式（ADR-0014）。

### 6.4 结论

**go。** M5-03 采用该版本与裁剪名单，但正式脚本必须：

- 校验固定 SHA256，失败立即终止；
- 不把二进制提交进仓库；
- 保留 `cmd/`、`ucrt64/bin`、`ucrt64/libexec/git-core`、模板与许可证等检查点必需内容；
- 在 PATH 完全没有 Git 的干净 Windows 上跑真实检查点创建、列表、预览与恢复；
- 若后续 Git 版本或镜像变化，重新验证裁剪名单与许可证。

## 7. S5 代码签名

### 7.1 可选方案

| 方案 | 适用性 | 代价/限制 |
|---|---|---|
| Azure Artifact Signing（原 Trusted Signing） | 组织在美国、加拿大、欧盟、英国；个人仅美国、加拿大 | 约 9.99 美元/月（Basic，5,000 次签名）；证书与时间戳由服务管理；地区不满足时不可用 |
| OV 代码签名证书（云签名或硬件令牌） | 全球 CA 可申请，适合无法使用 Azure 的个人/组织 | 约 150～300 美元/年起，实际以 CA 报价为准；私钥必须保存在硬件令牌或云 HSM；SmartScreen 信誉仍需积累 |
| EV 代码签名证书 | 客户或采购强制要求时 | 验证更严格、成本更高；EV 不再保证“立即”绕过 SmartScreen，仍取决于声誉 |
| 自签名证书 | 仅本地测试 | 不能用于公开分发；只能验证签名流程 |

### 7.2 决定与要求

- 目标优先使用云签名，避免把私钥导出到 CI 文件系统。
- 签名算法 SHA-256，时间戳使用 RFC 3161，安装包、主程序与卸载程序都要签名。
- CI 用 `signtool verify /pa /v` 或云服务等价验证；`publisherName` 使用证书的完整 DN，而不是只写 CN。
- 证书主题一旦确定，写入 `electron-builder` 配置与更新元数据；证书变更必须同步更新 `publisherName`，否则更新会被拒绝。
- 未取得证书时，只发布明确标注“unsigned beta”的版本，并在下载页与首次运行提示 SmartScreen 风险；不得声称已验证发布者。

### 7.3 结论

**条件 go。** 技术路径明确，但证书申请是外部阻塞。M5-08 前必须确定 CA/服务、地区资格、证书主题、时间戳 URL 与 CI secrets；否则按 unsigned beta 预案执行，stable 发布阻塞。

## 8. 复现

```powershell
cd spikes/m5
pnpm install --ignore-workspace --registry=https://registry.npmjs.org/
node src/s1-sandbox.mjs
node src/s2-package.mjs
node src/s3-update-source.mjs
node src/s4-mingit.mjs
```

`spikes/m5` 不进入根 pnpm workspace；`work/`、`out/`、`downloads/` 与 `result-*.json` 均被忽略。S2 需要先构建 `apps/desktop/out`。

## 9. 剩余风险

| 风险 | 处理 |
|---|---|
| 受限令牌网络未隔离 | 界面、设置、事件与诊断明确标注；需要网络隔离时使用实验 AppContainer 或未来 WFP 方案 |
| AppContainer 对用户目录工具链不兼容 | 不作为默认；M5-04 保留能力探测与诊断，不承诺可用 |
| 真正标准用户与 Windows 10 未验证 | M5-10 用干净 VM/标准账户验收；未通过前不宣称正式支持 |
| 运行时依赖清单遗漏 | M5-02 自动校验主进程实际 import；已安装应用冒烟失败即阻塞发布 |
| 原生模块 ABI 与 Electron 不匹配 | M5-02 显式 rebuild 并在安装后冒烟加载 SQLite/koffi |
| 更新器默认签名验证 fail-open | M5-06 注入严格验证器，异常即拒绝；M5-08 用真实证书演练 |
| 差分下载与磁盘不足未测 | M5-06 用真实 blockmap 与受控磁盘/配额补验 |
| MinGit 裁剪过度 | M5-03 以真实检查点流程验收；保留可回退的目录清单 |
