# 发布运行手册（代码签名与发布）

> 适用：M5-08 起的 Windows x64、按用户安装的 NSIS 发布；M6-02 起的 macOS DMG/ZIP；
> M6-03 起的 Linux x64 AppImage/deb；M6-07 起三平台在同一标签下汇总发布。
> 上级文档：[M5 计划](../plan/m5.md)、[ADR-0036](../adr/0036-auto-update-signing-and-rollback.md)、
> [ADR-0041](../adr/0041-macos-packaging-and-notarization.md)、
> [ADR-0042](../adr/0042-linux-packaging.md)、
> [ADR-0043](../adr/0043-cross-platform-ci-and-release.md)、
> [发布前置条件](../plan/m5-release-prerequisites.md)。

本手册覆盖 `.github/workflows/release.yml` 的配置、dry-run、正式发布、证书轮换与紧急撤包。
任何一步失败都必须停止发布；不得手工上传未通过门禁的安装包。

## 1. 发布产物

`pnpm release:artifacts -- --platform <windows|mac|linux>` 在每个平台 job 的
`apps/desktop/dist/release/` 生成并校验：

| 文件 | Windows | macOS | Linux |
|---|---|---|---|
| 安装包 | `Cairn-<version>-x64-setup.exe` | `Cairn-<version>-{arm64,x64}.dmg` | `Cairn-<version>-x64.deb` |
| 更新载体 | 同一安装包 | `Cairn-<version>-{arm64,x64}.zip` | `Cairn-<version>-x64.AppImage` |
| blockmap | `.exe.blockmap` | `.zip.blockmap` | 无 |
| 更新元数据 | `latest.yml` / `beta.yml` | `latest-mac.yml` / `beta-mac.yml` | `latest-linux.yml` / `beta-linux.yml` |

每个平台目录还包含 `SHA256SUMS`、`THIRD_PARTY_NOTICES.txt`、`dependencies.json`、
`release-notes.md`、`platform-notes.json` 与 `provenance.json`。`assemble` job 用
`pnpm release:merge` 把三个平台目录合并成一次发布：同名产物必须字节一致，否则失败；
`THIRD_PARTY_NOTICES` 与 `dependencies` 按平台改名；合并后的 `release-notes.md` 汇总
三个平台的签名状态、下载列表、安装方式与已知问题。

`release:artifacts` 会拒绝：版本与 `apps/desktop/package.json` 不一致、通道与
`out/build-info.json` 不一致、缺少本平台安装包/blockmap/更新元数据、更新元数据中的
版本/路径/SHA-512/大小与产物不一致、Windows/macOS 的 stable 未签名。发布说明直接读取
`CHANGELOG.md` 对应版本的小节，不手工复制。

## 2. 一次性配置

### 2.1 Repository variables（公开配置）

| 变量 | 取值 | 说明 |
|---|---|---|
| `CAIRN_SIGN_MODE` | `none` / `pfx` / `azure` | 未设置按 `none`；`none` 只能发 beta |
| `CAIRN_UPDATE_URL` | `https://updates.example/cairn/` | 构建时写入客户端；必须是 HTTPS、无凭据/查询串/片段 |
| `CAIRN_UPDATE_PUBLISHER` | 证书完整 DN，如 `CN=Cairn, O=Cairn, C=CN` | stable 必填；必须与证书主题逐字一致 |
| `CAIRN_TIMESTAMP_URL` | RFC 3161 时间戳服务 | 默认 `https://timestamp.digicert.com`；必须 HTTPS |
| `CAIRN_PUBLISH_METHOD` | `none` / `github` / `rclone` | tag push 自动发布时使用；`none` 或未设置只构建、不发布 |

### 2.2 Secrets（只进 release workflow）

| Secret | 签名模式 | 说明 |
|---|---|---|
| `WINDOWS_CERTIFICATE` | `pfx` | PFX 的 Base64；不要提交到仓库 |
| `WINDOWS_CERTIFICATE_PASSWORD` | `pfx` | PFX 密码 |
| `AZURE_SIGN_ENDPOINT` | `azure` | Trusted Signing 账号终结点 |
| `AZURE_SIGN_ACCOUNT` | `azure` | Code Signing Account 名称 |
| `AZURE_SIGN_PROFILE` | `azure` | Certificate Profile 名称 |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | `azure` | 服务主体凭据，供 `DefaultAzureCredential` 使用 |
| `CAIRN_UPLOAD_REMOTE` | `rclone` | 形如 `r2:cairn/` 的 rclone 目标 |

签名 secret 只注入打包、签名校验、安装冒烟与产物整理四个步骤，不进入单元测试。
更新源与证书都不是仓库令牌；客户端只访问公开只读的 HTTPS 地址。

PowerShell 生成 PFX 的 Base64（只写入 GitHub secret，不要粘贴到日志）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\secure\cairn.pfx')) | Set-Clipboard
```

## 3. 签名模式

### 3.1 `none`：unsigned beta

- `release:artifacts` 与 workflow 都会拒绝 stable；只能发布明确标注 `unsigned beta` 的版本。
- 发布说明强制包含 SmartScreen 警告，不宣称“已验证发布者”或“无警告”。
- 安装包、主程序与卸载程序都没有可验证的 Authenticode 签名，更新服务在配置
  `publisherName` 时会拒绝这类更新。

### 3.2 `pfx`：PFX + 密码

- 证书与密码只经 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 传给 electron-builder 子进程，
  不进入命令行、日志或 `build-info.json`。
- 使用 SHA-256 与 RFC 3161 时间戳；打包后用 `signtool verify /pa /all /v` 和
  PowerShell `Get-AuthenticodeSignature` 双重校验：状态 `Valid`、主题与
  `CAIRN_UPDATE_PUBLISHER` 逐字相等、带时间戳。
- 本机或 CI 必须能定位 `signtool.exe`（Windows SDK）；也可用 `SIGNTOOL_PATH` 显式指定。

### 3.3 `azure`：Azure Trusted Signing

- 私钥不落到 CI 文件系统；electron-builder 使用 Trusted Signing 配置与
  `AZURE_*` 服务主体凭据。
- `CAIRN_UPDATE_PUBLISHER` 仍必须是证书完整 DN；Azure 门户里显示的主题可能省略空格，
  以实际证书主题为准，否则 `electron-updater` 会拒绝更新。
- 服务地区资格见[发布前置条件](../plan/m5-release-prerequisites.md) §3。

### 3.4 证书轮换

1. 续签时优先保持证书主题 DN 不变，只更新 `WINDOWS_CERTIFICATE` /
   `WINDOWS_CERTIFICATE_PASSWORD` 或 Azure 配置。
2. 若 CA 变更主题 DN：旧版客户端把旧 DN 写死在 `build-info.json`，会拒绝新证书。
   必须先用**旧证书**发布一个桥接版本，把新的 `CAIRN_UPDATE_PUBLISHER` 带给用户，
   再切换到新证书；不能在用户仍停留在旧版本时直接更换 DN。
3. 轮换后先跑 `pnpm sign:verify` 或一次 dry-run，确认签名、主题与时间戳都通过。
4. 时间戳服务不可用时签名会失败；不要改用无时间戳签名发布 stable。

## 4. 更新源配置

- `CAIRN_UPDATE_URL` 在构建时写入 `out/build-info.json`，客户端读取
  `latest.yml`（stable）或 `beta.yml`（beta）。
- `scripts/build-info.mjs` 只接受 HTTPS，拒绝用户名/密码、查询串与片段，并补尾部斜杠；
  更新源不能携带令牌，必须允许匿名只读。
- 两种源二选一：
  - **静态目录**（对象存储/CDN）：形如 `https://updates.example/cairn/`，客户端用 generic
    provider 按目录拼接文件名；至少需要通道元数据、对应版本安装包与 blockmap。
  - **公开仓库的 GitHub Releases**：形如 `https://github.com/<owner>/<repo>`，客户端用
    GitHub provider 读取 `releases.atom` 与 `releases/download/<tag>/`，**不需要也禁止**
    携带令牌（私有仓库不支持）。发布一律创建正式 release：GitHub 的 Latest 与仓库侧栏
    不展示预发布，标成 prerelease 会让 Releases 页面看起来没有可下载版本；版本选择靠
    通道元数据（`beta.yml` / `latest.yml`），客户端在 beta 通道仍打开 `allowPrerelease`
    从 Atom feed 取最新版本。
- `release:publish` 会把 `dist/release/` 下的全部文件一起上传；GitHub 方式使用
  `--method github`，发布后从 `https://github.com/<repo>/releases/download/<tag>/`
  匿名重下并核对 SHA-256。
- 静态目录建议给 `*.yml` 设置较短缓存（例如 1–5 分钟），安装包与 blockmap 可以长缓存；
  撤包后必须刷新 CDN。GitHub Releases 无法自定义缓存与可用性，适合没有对象存储时直接
  发布；对下载速度、CDN 或可用性有要求时仍应使用静态目录。

## 5. 发布流程

### 5.1 准备

1. 更新 `CHANGELOG.md`，新增与版本一致的小节（`## [x.y.z] - YYYY-MM-DD`）。
2. 用 `pnpm sync:version` 同步根包与桌面包版本，提交到 `main` 并推送。
3. 确认 `CAIRN_SIGN_MODE`、`CAIRN_UPDATE_URL`、签名 secrets 与上传凭据已配置。
4. 打标签 `vX.Y.Z`；标签必须与 `package.json` 完全一致。stable 不允许 prerelease 标签。

### 5.2 dry-run（不发布）

在 Actions 中手动运行 `Release`：

- `tag` 填已存在的标签（例如 `v0.1.1`），或在该标签上直接 dispatch；
- `channel` 选 `auto`；
- `publish` 不勾选。

流水线会在三个 runner 上构建并校验各自平台，`assemble` 汇总后执行
`release:publish --dry-run`，但不会上传。Windows job 另外执行类型检查、lint、格式、
i18n、许可证、覆盖率与安装冒烟。

### 5.3 正式发布

- tag push：仅当 `CAIRN_PUBLISH_METHOD` 为 `github` 或 `rclone` 时自动发布；
- 手动 dispatch：勾选 `publish`，选择 `publish_method`。

发布 job 会重新下载公开文件并核对 SHA-256；任一文件不可匿名下载或哈希不一致即失败。
失败时先排查，不要手工补传后跳过校验。

### 5.4 发布门禁

以下任一失败都会阻止上传：

- 标签与版本不一致、stable 使用 prerelease 标签；
- 任一平台的构建、打包、`package:verify` 或打包冒烟失败；
- Windows 的类型检查、lint、格式、i18n、许可证、覆盖率或安装冒烟失败；
- 签名缺失、`signtool`/Authenticode 校验失败、证书主题不匹配、无时间戳；
- macOS 的 `codesign`/`spctl`/`stapler` 校验失败；
- `latest*.yml` / `beta*.yml` 与产物不一致、产物缺失、公开下载或哈希校验失败；
- Windows/macOS 的 unsigned 构建尝试进入 stable。

## 6. 回滚与紧急撤包

### 6.1 保留上一版

每次发布至少保留上一版的安装包、blockmap 与通道元数据。客户端禁止二进制降级，
因此“回滚更新源”只阻止尚未升级的客户端继续升级，**不会**把已升级客户端降级。

### 6.2 紧急撤包（目标 10 分钟内）

1. 立即把更新源里的 `latest.yml` / `beta.yml` 替换为上一版内容（或移除该通道文件），
   保留上一版安装包与 blockmap 的可下载性。
2. 刷新 CDN 缓存，确认 `https://<update-source>/beta.yml` 在一分钟内返回上一版。
3. 在 GitHub Release 与发布页标注撤回原因、影响版本与手动恢复步骤。
4. 不删除仍被旧客户端引用的安装包与 blockmap。
5. 若数据可能受损，指引用户用升级前备份恢复；备份位于
   `<userData>/backups/update-<from>-to-<to>-<timestamp>`。

### 6.3 已升级用户的恢复

`electron-updater` 不提供降级。恢复旧版需要卸载后重装旧安装包，并按需恢复数据库与
设置备份；不要通过修改 `latest.yml` 指向更低版本尝试自动降级。

## 7. 故障排查

| 现象 | 检查 | 处理 |
|---|---|---|
| `signtool verify failed` | `SIGNTOOL_PATH`、Windows SDK、证书链、时间戳服务 | 修复环境后重跑；不得跳过校验 |
| `publisher is "...", expected "..."` | `CAIRN_UPDATE_PUBLISHER` 与证书 `Subject` | 改成完整且逐字一致的 DN |
| 无 RFC 3161 时间戳 | `CAIRN_TIMESTAMP_URL` 可访问性、代理 | 换可用时间戳服务，重新签名 |
| `latest.yml ... does not match` | 安装包是否被替换、dist 是否混入旧文件 | 清理 `dist` 后重新打包 |
| 公开下载 404/403 | 静态源权限、文件名、CDN 缓存 | 修正公开读权限或上传路径 |
| GitHub Release 已存在导致失败 | 发布 job 会改为编辑说明并 `--clobber` 上传 | 确认旧资产已被覆盖 |
| SmartScreen 仍警告 | 证书声誉、OV/EV 差异 | 只解释声誉机制，不承诺签名等于无警告 |
| unsigned stable 被拒绝 | `CAIRN_SIGN_MODE=none` | 这是预期门禁；配置证书或发 beta |

## 8. 本地演练

无证书时验证 `none` 分支与全部参数构造：

```powershell
$env:CAIRN_SIGN_MODE = 'none'
pnpm build
pnpm package:nsis
pnpm package:verify -- --nsis
pnpm release:artifacts -- --channel beta
pnpm release:publish -- --dry-run --tag v0.1.0 --dir apps/desktop/dist/release
```

有证书时（不要把密码写进命令历史）：

```powershell
$env:CAIRN_SIGN_MODE = 'pfx'
$env:CAIRN_UPDATE_PUBLISHER = 'CN=Cairn, O=Cairn, C=CN'
$env:WINDOWS_CERTIFICATE = '<base64>'
$env:WINDOWS_CERTIFICATE_PASSWORD = '<password>'
pnpm package:nsis
pnpm sign:verify -- --dist apps/desktop/dist --version 0.1.0
```

## 9. 验证边界

- 单元测试覆盖签名参数构造、PFX 环境隔离、`latest.yml` 校验、产物整理、上传命令与
  公开下载校验；真实 `signtool`、真实证书、Azure Trusted Signing 与 artifact
  attestation 只能在配置了 secrets 的 Windows runner 上验证。
- 未取得证书时只能声明 “unsigned beta”：SmartScreen 可能警告，且更新服务无法验证发布者。
- 安装级自动化验收（M5-10）：`pnpm smoke:installed` 覆盖安装/卸载与数据保留；
  `pnpm acceptance:installed` 覆盖中文长路径、仅系统 `PATH`（无 Git）与卸载→重装→设置恢复。
  已打包应用全流程由 `pnpm e2e:packaged`（含 `acceptance.spec.ts`）覆盖。
- 干净 VM、标准用户、Windows 10、SmartScreen 与真实 0.1.0→0.1.1 安装升级仍未执行；
  状态与阻塞项见 [M5 发布验收报告](../plan/m5-report.md)。本手册不能替代真机证据。

## 10. macOS：签名、公证与打包（M6-02）

macOS 产物按架构分别构建，只能在 macOS 上执行；Windows runner 会直接拒绝。

### 10.1 本机（unsigned，仅内部使用）

```bash
pnpm build
pnpm package:mac
pnpm package:verify -- --mac
```

产物位于 `apps/desktop/dist/`：`Cairn-<version>-{arm64,x64}.{dmg,zip}` 与各自的
`.sha256`。未签名包不能作为公开 beta 分发：Gatekeeper 会拦截，更新服务也无法验证签名。
本地首次打开时按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”中放行；
这不适用于对外发布。

### 10.2 Developer ID 签名与公证

| 变量 | 必填 | 说明 |
|---|---|---|
| `CAIRN_MAC_SIGN_MODE` | 是 | `none`（默认）或 `developer-id` |
| `CAIRN_MAC_IDENTITY` | `developer-id` | 完整的 `Developer ID Application: ...` 身份 |
| `MAC_CERTIFICATE` 或 `CSC_LINK` | `developer-id` | 导出为 `.p12` 后的 Base64 |
| `MAC_CERTIFICATE_PASSWORD` 或 `CSC_KEY_PASSWORD` | `developer-id` | `.p12` 密码 |
| `APPLE_ID` | `developer-id` | Apple 开发者账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | `developer-id` | 应用专用密码，不是账号密码 |
| `APPLE_TEAM_ID` | `developer-id` | Team ID |

证书与密码只通过子进程环境传给 electron-builder，不会出现在命令行或日志。`developer-id`
模式同时启用 hardened runtime（`build/entitlements.mac.plist`）与公证；缺少任一凭据都会
直接失败，不产出无法通过 Gatekeeper 的安装包。

在 CI secrets 或当前进程环境中设置上表变量后运行：

```bash
pnpm package:mac
pnpm sign:verify:mac -- --dist apps/desktop/dist --version 0.1.0
```

不要把证书内容或密码写进命令行、脚本或 shell 历史；electron-builder 只从环境读取。

`sign:verify:mac` 对两个 `.app` 运行 `codesign --verify --deep --strict --verbose=2` 与
`spctl --assess --type execute`，对已公证的 DMG 运行 `xcrun stapler validate`。ZIP 不能
stapling，更新包以 `.app` 的签名与公证结果为准。只有全部通过才允许进入发布清单。

### 10.3 公证与 stapling 的门禁

- 公证失败、票据未 stapled 或 Gatekeeper 评估失败都视为发布阻塞项。
- `APPLE_APP_SPECIFIC_PASSWORD` 泄漏后必须立即在 Apple ID 页面吊销并重新生成。
- 证书轮换时保持 Team ID 与签名身份名称稳定；更新清单与签名摘要只记录身份，不记录凭据。

### 10.4 发布流水线（M6-07）

`release.yml` 的 `build-macos` job 在 `macos-latest` 上构建两个架构，产出
`latest-mac.yml` / `beta-mac.yml` 与 `platform-notes.json`，再由 `assemble` 合并进同一
次发布。stable 要求 `CAIRN_MAC_SIGN_MODE=developer-id`；beta 的签名失败会显式降级为
unsigned，并在发布说明中标注。真实 Apple Silicon/Intel 安装、公证与更新下载仍需在配置
好账号的 macOS 环境执行并记录证据。

## 11. Linux：AppImage 与 deb（M6-03）

Linux 产物只在 Linux 上构建；Windows/macOS runner 会直接拒绝。目标为 x64，以 Ubuntu LTS
为基线。

### 11.1 构建与校验

```bash
pnpm build
pnpm package:linux
pnpm package:verify -- --linux
```

产物位于 `apps/desktop/dist/`：`Cairn-<version>-x64.AppImage` 与
`Cairn-<version>-x64.deb`，以及各自的 `.sha256`。`verify-package` 会检查
`linux-unpacked/cairn`、asar、skills、`out/bin/rg`、`linux-x64.node` 与两个安装包。
deb 使用 electron-builder 的默认运行库依赖（含 `libsecret-1-0`、`libnss3`、`libxss1`）。

### 11.2 更新边界

- AppImage：`electron-updater` 通过 generic 源更新，需要 `latest-linux.yml` /
  `beta-linux.yml` 与对应 AppImage；该元数据由 `build-linux` job 生成并由 `assemble`
  合并进发布。
- deb：不自动更新；由系统包管理器或手动安装新版本。发布说明必须写清两条升级路径。
- Linux 的 stable 允许 unsigned；发布说明写明完整性由 SHA-256 与 HTTPS 更新源保证。

### 11.3 Chromium 沙箱与 `--no-sandbox`

- 默认不关闭 Chromium 沙箱。Ubuntu 24.04 等限制非特权用户命名空间的环境可能无法启动
  AppImage；排障时可显式加 `--no-sandbox`。
- `--no-sandbox` 只影响 Chromium 进程沙箱，不改变 Cairn 的命令执行权限模型；Linux 尚未
  实现命令沙箱（ADR-0034 / M6-05），界面与事件继续标注“未沙箱化”。
- 不得把 `--no-sandbox` 写进桌面项或发布脚本作为默认值；发布说明中说明风险与替代修复
  （启用用户命名空间或改用 deb）。

### 11.4 未验证

真实 AppImage/deb 构建、Ubuntu LTS 安装/启动/卸载/重装、`xdg-open`、无用户命名空间时的
启动与 AppImage 更新仍需 Linux runner/真机验证；流水线已能生成并校验
`latest-linux.yml`，但客户端更新下载尚未在真机记录。

## 12. 跨平台 CI 与发布（M6-07）

### 12.1 CI 矩阵

`.github/workflows/ci.yml` 在 `windows-latest`、`ubuntu-latest`、`macos-latest` 上运行：

- format、typecheck、lint、i18n、单测与覆盖率、build、smoke；
- 三平台都执行 `package:dir`、`package:verify` 与 `smoke:packaged`；
- Playwright e2e 在 Windows 与 Linux 上运行，macOS 以打包冒烟 + 手工矩阵覆盖；
- `dco` job 对 PR 的每个非合并提交运行 `pnpm check:dco -- --base <base sha>`。

贡献者本地提交必须使用 `git commit -s`；DCO 失败时用 `git rebase --signoff` 修正历史，
不要用空提交绕过。

macOS runner 上，冒烟前会创建一个空的临时钥匙串并设为搜索列表与默认钥匙串。safeStorage
的主密钥条目只信任创建它的二进制：前面的未打包冒烟已用 Electron 在登录钥匙串写入了同名
条目，打包应用读取时需要用户授权，而无桌面的 runner 会以 `errSecAuthFailed` 失败。独立
钥匙串让打包应用自己创建条目，冒烟仍然校验真实的系统加密。

### 12.2 发布 job 结构

| job | runner | 作用 |
|---|---|---|
| `prepare` | ubuntu | 校验标签、版本与通道，输出 `tag`/`version`/`channel` |
| `build-windows` | windows | 全量质量门禁、NSIS、签名、安装冒烟、产物整理 |
| `build-macos` | macos | DMG/ZIP、Developer ID 签名与公证、打包冒烟、产物整理 |
| `build-linux` | ubuntu | AppImage/deb、打包冒烟、产物整理 |
| `assemble` | ubuntu | 下载三个平台包、`release:merge`、dry-run、provenance |
| `publish` | ubuntu | 一次性上传到 GitHub Releases 或静态更新源并回读校验 |

每个构建 job 上传 `cairn-release-<version>-<platform>`；`assemble` 用
`node scripts/merge-release.mjs --root release --out release/merged` 合并，任何平台失败
都会阻止上传。

### 12.3 签名降级

- Windows：beta 的 `pnpm package:nsis` 失败时，job 用 `CAIRN_SIGN_MODE=none` 重试一次；
  发布说明标注 unsigned。stable 不重试。
- macOS：同上，重试使用 `CAIRN_MAC_SIGN_MODE=none`；stable 要求
  `CAIRN_MAC_SIGN_MODE=developer-id`。
- Linux：没有统一代码签名，stable 允许 unsigned，发布说明写明完整性模型。

### 12.4 macOS 双架构

同一个 macOS job 产出 arm64 与 x64。staging 保留
`better-sqlite3/prebuilds/darwin-{arm64,x64}.node`，避免 x64 应用加载 arm64 原生模块；
koffi 只用于 Windows Job Object，macOS/Linux 不会加载。`mac.artifactName` 固定为
`Cairn-${version}-${arch}.${ext}`，ZIP 不再带 `-mac` 后缀。

### 12.5 未验证

真实标签发布、macOS 签名/公证、Windows 签名降级、三平台更新下载与客户端读取
`latest*.yml` 仍需配置 secrets、证书与更新源后在真实 runner/真机执行。流水线结构、
合并逻辑与 DCO 由单元测试覆盖；没有外部条件时不得把上述结论记为已通过。
