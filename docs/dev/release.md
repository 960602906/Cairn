# 发布运行手册（代码签名与发布）

> 适用：M5-08 起的 Windows x64、按用户安装的 NSIS 发布。
> 上级文档：[M5 计划](../plan/m5.md)、[ADR-0036](../adr/0036-auto-update-signing-and-rollback.md)、
> [发布前置条件](../plan/m5-release-prerequisites.md)。

本手册覆盖 `.github/workflows/release.yml` 的配置、dry-run、正式发布、证书轮换与紧急撤包。
任何一步失败都必须停止发布；不得手工上传未通过门禁的安装包。

## 1. 发布产物

`pnpm release:artifacts` 在 `apps/desktop/dist/release/` 生成并校验：

| 文件 | 用途 |
|---|---|
| `Cairn-<version>-x64-setup.exe` | 安装包 |
| `Cairn-<version>-x64-setup.exe.blockmap` | 差分下载元数据 |
| `latest.yml`（stable）或 `beta.yml`（beta） | `electron-updater` generic provider 元数据 |
| `SHA256SUMS` | 所有发布文件的 SHA-256 |
| `THIRD_PARTY_NOTICES.txt` | 随包第三方许可声明 |
| `dependencies.json` | 实际随包分发的 npm 包与外部二进制 |
| `release-notes.md` | 由 `CHANGELOG.md` 对应版本小节生成 |
| `provenance.json` | 版本、通道、提交、工作流、签名摘要与产物哈希 |

`release:artifacts` 会拒绝：版本与 `apps/desktop/package.json` 不一致、通道与
`out/build-info.json` 不一致、缺少安装包/blockmap/`latest.yml`、`latest.yml` 的
版本/路径/SHA-512/大小与安装包不一致、stable 未签名。发布说明直接读取 `CHANGELOG.md`
对应版本的小节，不手工复制。

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

- `CAIRN_UPDATE_URL` 在构建时写入 `out/build-info.json`，客户端按目录读取
  `latest.yml`（stable）或 `beta.yml`（beta）。
- `scripts/build-info.mjs` 只接受 HTTPS，拒绝用户名/密码、查询串与片段，并补尾部斜杠；
  更新源不能携带令牌，必须允许匿名只读。
- 静态源目录至少需要：通道元数据、对应版本安装包、blockmap。`release:publish`
  会把 `dist/release/` 下的全部文件一起上传。
- 建议给 `*.yml` 设置较短缓存（例如 1–5 分钟），安装包与 blockmap 可以长缓存；
  撤包后必须刷新 CDN。
- GitHub Releases 只作为过渡方案：客户端需要固定目录，正式更新源仍应是对象存储。
  使用 `--method github` 时，发布后从 `https://github.com/<repo>/releases/download/<tag>/`
  匿名重下并核对 SHA-256。

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

流水线会执行版本检查、类型检查、lint、格式、i18n、许可证、覆盖率、构建、打包、
签名校验、安装冒烟、产物整理与 `release:publish --dry-run`，但不会上传。

### 5.3 正式发布

- tag push：仅当 `CAIRN_PUBLISH_METHOD` 为 `github` 或 `rclone` 时自动发布；
- 手动 dispatch：勾选 `publish`，选择 `publish_method`。

发布 job 会重新下载公开文件并核对 SHA-256；任一文件不可匿名下载或哈希不一致即失败。
失败时先排查，不要手工补传后跳过校验。

### 5.4 发布门禁

以下任一失败都会阻止上传：

- 标签与版本不一致、stable 使用 prerelease 标签；
- 类型检查、lint、格式、i18n、许可证、覆盖率、构建、打包、安装冒烟失败；
- 签名缺失、`signtool`/Authenticode 校验失败、证书主题不匹配、无时间戳；
- `latest.yml`/`beta.yml` 与安装包不一致、产物缺失、公开下载或哈希校验失败；
- unsigned 构建尝试进入 stable。

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
- 干净 VM 的安装、升级、卸载与回滚演练由 M5-10 完成；本手册不能替代真机证据。
