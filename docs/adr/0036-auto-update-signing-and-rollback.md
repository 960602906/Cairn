# ADR-0036 自动更新、代码签名与回滚

- 状态：已接受（M5-00 起草，M5-06 实现更新服务，M5-07 实现设置与状态界面；签名与发布流水线由 M5-08 完成）
- 日期：2026-11-10
- 相关决策：ADR-0006、ADR-0010、ADR-0035
- 预研证据：[M5-00 预研报告](../plan/m5-spikes.md) §5、§7

## 背景

M5 需要让已安装的 `0.1.0` beta 能收到 `0.1.1`，同时满足：

- 更新源公开只读，客户端不携带仓库令牌或私有源凭据；
- 下载包必须校验完整性、大小与发布者；
- 任务运行中不能静默重启；
- 失败、断网、代理、损坏包、签名不符与磁盘不足要有明确状态；
- 不提供二进制自动降级，但保留可恢复路径。

候选方案：

1. 客户端直连 GitHub API 下载 release；
2. generic HTTPS 静态源；
3. 自建带鉴权的更新服务。

方案 1 会把仓库/令牌与平台 API 语义带进客户端；方案 3 增加服务端与凭据管理，不符合“公开只读、客户端无令牌”的目标。

## 决定

- **更新源为 generic HTTPS 静态源。** 客户端只读取公开只读的 `latest.yml` / `beta.yml`、安装包与 blockmap；发布流水线用 CI secrets 上传，客户端不携带令牌。对象存储未就绪时，可用公开 release-only 仓库过渡，但不能把私有仓库令牌打进客户端。
- **使用 `electron-updater` 6.8.11 generic provider。** `autoDownload=false`、`autoInstallOnAppQuit=false`、`allowDowngrade=false`；启动后延迟检查，手动检查立即执行；失败只更新状态，不弹错误风暴。
- **下载后严格校验。** 校验 SHA512 与文件大小；配置完整 `publisherName` DN 并验证 Authenticode。`electron-updater` 6.8.11 的默认 Windows 验证器在 PowerShell 无法执行或输出异常时可能放行，M5-06 必须注入自定义严格验证器：任何执行失败、解析失败、证书缺失、主题不匹配或时间戳/信任链无效都返回失败，删除临时包并记录状态。
- **签名目标。** 安装包、主程序与卸载程序都使用 SHA-256 与 RFC 3161 时间戳签名；CI 用 `signtool verify /pa /v` 或云签名等价验证。优先云签名（私钥不落到 CI 文件系统）；Azure Artifact Signing 仅适用于服务支持的地区，其他地区选 OV 云签名或硬件令牌。证书未就绪时只发 unsigned beta，不得宣称已验证发布者。
- **不自动降级。** `allowDowngrade=false`，数据库 `SchemaTooNew` 作为第二道防线。更新前备份数据库、`settings.json` 与凭据文件元数据（不复制明文密钥），保留最近两份；备份路径写入日志与诊断包。
- **运行中禁止静默重启。** 有运行中会话、待审批或检查点恢复时，必须阻止安装；提示“任务结束后更新”或让用户显式取消任务。
- **差分下载是优化，不是信任边界。** 支持 blockmap 差量；差分失败可回退完整下载，仍必须执行完整 SHA512、大小与签名校验。
- **回滚是人工恢复，不是二进制自动降级。** 保留上一版安装包、blockmap 与更新元数据；数据损坏时用升级前备份恢复。紧急撤包把更新源指回上一版，并发布说明。
- **更新源与证书配置只经构建注入。** `CAIRN_UPDATE_URL`、通道、`publisherName` 与签名配置不写入日志、诊断包或客户端明文；开发模式与 `CAIRN_UPDATE_DISABLE=1` 时禁用更新。

## S3 预研结论

本地自签名 HTTPS 静态源验证了：

- 从 `0.1.0` 检查并下载 `0.1.1`；
- 404、断网、错误 SHA512、截断包、未签名包与无效代理均失败；
- 未签名包在配置 `publisherName` 时被拒绝，错误为 `ERR_UPDATER_INVALID_SIGNATURE`；
- 自签名证书只用于预研，正式源必须使用公开可信 CA。

未验证：差分下载、磁盘不足、下载中断重试、真实 OV/EV 签名包、真实安装升级与运行中任务阻塞。这些由 M5-06/M5-08 补验，不能用本地假包结果代替。

## 备选方案

- **GitHub API + 客户端令牌**：泄露风险高，否决。
- **自建鉴权更新服务**：需要服务端、账号与凭据管理，M5 不需要，否决。
- **关闭签名校验以简化开发**：不可接受；unsigned beta 也必须明确提示，stable 必须签名。
- **自动回滚旧版本**：数据库迁移通常不可逆，`electron-updater` 不提供降级；改用备份与人工恢复。

## 实施结果（M5-06，2026-11-10）

- `apps/desktop/src/main/services/update-service.ts`：可注入的更新状态机，覆盖检查、下载、校验、安装、取消与状态推送；更新源、通道、发布者配置失败关闭；禁止降级；`stagingPercentage` 只接受 0 或 100；下载前检查磁盘余量；取消或迟到结果清理临时包；安装前要求没有运行中会话、待审批或检查点恢复。
- `update-signature.ts`：注入严格 Authenticode 验证器。PowerShell 通过 `CAIRN_UPDATE_FILE` 环境变量读取文件，Node 侧校验 `Valid`、签名者、可信时间戳、完整 DN 与读取路径；执行失败、stderr、空输出、无法解析或字段缺失都拒绝并删除临时包。
- `update-backup.ts`：安装前创建 `<userData>/backups/update-<from>-to-<to>-<timestamp>`，包含数据库快照、`settings.json` 与凭据元数据（只含引用、类型与更新时间，不含密文），保留最近两份。
- 接线：协议新增 `update.status|check|download|install|cancel` 与 `update.status` 推送；设置增加自动检查、通道、上次检查时间与跳过版本；诊断 zip 增加 `update.json`；`app-paths` 增加 `backups` 目录；启动时延迟检查、退出时停止定时器。
- 真实本地 HTTPS 静态源 e2e（Windows）完成 `0.1.0 → 0.1.1` 检查与完整下载，并在会话等待审批时阻止安装。该用例发现并修复了打包后 ESM 下 `electron-updater` 的 `autoUpdater` 只经默认导出暴露的问题。
- 验证：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm check:i18n`、`pnpm check:licenses`、`pnpm check:version` 通过；全量 `pnpm test:coverage` 四项覆盖率均不低于 95%；桌面端 `pnpm build`、更新 e2e、打包与已安装应用冒烟通过。
- 与计划的差异：M5-06 只实现服务与 RPC，更新设置/提示界面和重启确认留给 M5-07；灰度只支持 0 或 100，不做随机抽样；差分下载沿用 `electron-updater` 默认能力，本次 e2e 走完整下载，未把差分当作已验证证据。
- 未验证/留给后续：真实 OV/EV 签名安装包与真实安装重启由 M5-08/M5-10 验证；真实断网、代理、磁盘不足与下载中断由单元测试的注入错误覆盖，未做真实网络/配额演练；干净 VM、标准用户、Windows 10、中文用户名与长路径由 M5-10 覆盖。

## 实施结果（M5-07，2026-11-10）

- 设置页新增“更新”分区：当前版本与阶段、通道（构建固定时只读）、自动检查开关、上次检查时间、检查/重试/下载/取消、下载进度与速度、跳过/取消跳过、已下载状态与签名结论、错误翻译与技术细节；错误状态可直接重试。
- 非模态提示：主界面标题栏下方一条提示“发现更新 / 下载中 / 已下载”；只有“重启安装”确认是模态对话框。有运行中会话、待审批或检查点恢复时，重启按钮禁用并显示延迟原因，主进程仍会二次拒绝。
- 重启确认：明确说明会先备份数据库与设置、关闭并重启；unsigned beta 提示没有可验证发布者签名；不提供静默重启。
- 关于页新增更新源与第三方许可入口；许可声明由主进程读取随包的 `THIRD_PARTY_NOTICES.txt`（超长截断）后在应用内展示，不暴露路径。
- 协议与主进程：`UpdateStatus` 增加 `channelPinned`（构建固定通道时界面只读）；新增 `app.licenses` 请求与 `licenses-service`，读取失败返回 `available: false`；网络错误分类补充 Chromium 的 `net::ERR_CONNECTION_*` / `ERR_NAME_NOT_RESOLVED` 文本。
- 测试：更新模型纯函数、设置页各阶段、非模态提示与重启确认、许可对话框、store 动作与推送、许可读取、gateway 与 i18n 全覆盖；e2e 用本地静态源完成界面检查→下载→重启提示，任务运行中阻止重启，并在同一端口先失败后重试成功；设置页视觉验收扩展到八个分类。
- 截图：e2e 输出 `design/redesign-v8/update/update-settings-{light,dark}.png` 与 `update-restart-dialog-light.png`（`design/` 不入库）。
- 与计划的差异：关于页的通道沿用“构建信息”一行，不重复展示；第三方许可在应用内展示而不是打开外部文件；真实安装重启仍不在 e2e 中执行。
- 未验证/留给后续：真实签名包的安装与重启由 M5-08/M5-10 验证；`electron-updater` 的真实代理行为与差分下载仍只按 M5-06 的边界声明。

## 后果

- 证书申请是外部阻塞；未取得证书时只能发布 unsigned beta，SmartScreen 可能警告，且 OV 证书也不保证立即消除警告。
- 严格签名验证可能因系统 PowerShell/证书链/时间戳服务异常拒绝更新；这是失败关闭的有意取舍，错误状态必须可诊断。
- 更新源必须匿名可访问；发布后要从公网重新下载并校验，不以 CI 内网成功为准。
- 备份与人工恢复增加磁盘占用与操作步骤，但避免自动降级造成数据损坏。
