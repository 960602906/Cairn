# M5 发布前置条件

> 状态：草案（M5-00 产出；项目负责人确认后生效）。M5-08 的签名/发布流水线已实现并自带
> unsigned stable 阻塞与公开下载复验；M5-09 已落地中英文 EULA/隐私/安装/故障排查工程文本，
> 但第 12 项仍需项目负责人与法务确认。第 1～7、14 项仍需发布负责人确认后才能签发 stable。
> 上级文档：[M5 计划](m5.md)、[M5-00 预研报告](m5-spikes.md)。

## 1. 使用规则

- 负责人按**角色**指定；具体人员由项目负责人在 M5 启动会上填写。
- 截止日期是建议日期，允许调整，但不得晚于对应任务开始。
- 标记为“阻塞”的事项未完成时，对应发布门禁不得绕过；不能用 unsigned beta 之外的临时方案静默降级。
- 任何证书、令牌、更新源凭据只放在 CI secrets，不写入仓库、日志、PR 描述或诊断包。

## 2. 清单

| # | 事项 | 负责人（角色） | 建议截止 | 阻塞任务 | 完成标准 |
|---|---|---|---|---|---|
| 1 | 选择签名方案：Azure Artifact Signing、OV 云签名或其他 CA | 发布负责人 + 项目负责人 | 2026-11-14 | M5-08 | 方案、地区资格、费用与审批周期已确认 |
| 2 | 确定证书完整主题 DN 与 `publisherName` | 发布负责人 | 2026-11-17 | M5-06、M5-08 | 完整 DN 写入发布配置；证书变更流程已记录 |
| 3 | 提交证书申请并完成身份验证 | 项目负责人 | 2026-11-17 | M5-08 | CA/服务已受理，预计签发日期明确 |
| 4 | 确定 RFC 3161 时间戳服务 | 发布负责人 | 2026-11-17 | M5-08 | URL 可访问；签名脚本使用该 URL |
| 5 | 配置 CI 签名 secrets 与最小权限 | 发布负责人 + CI 维护者 | 2026-11-20 | M5-08 | release workflow 可读取；普通 PR 不可读取 |
| 6 | 确定公开只读更新源（域名、对象存储或 public release-only 仓库） | 发布负责人 | 2026-11-14 | M5-06 | 匿名可下载 `latest.yml` 与安装包；上传凭据只在 CI |
| 7 | 准备更新源上传权限与回滚步骤 | 发布负责人 | 2026-11-20 | M5-08 | 能在 10 分钟内撤包并指回上一版 |
| 8 | 准备干净 Windows 11 24H2 标准用户测试机/VM | QA | 2026-11-20 | M5-10 | 无开发工具、无 Git、无旧版 Cairn、非管理员账户 |
| 9 | 准备 Windows 10 22H2 best-effort 测试机/VM | QA | 2026-11-20 | M5-10 | 同上；记录 EOL 与安全更新限制 |
| 10 | 准备中文用户名/长路径/无 Git 场景 | QA | 2026-11-20 | M5-10 | 至少一个中文用户名或长路径环境 |
| 11 | 决定 unsigned beta 预案是否接受 | 项目负责人 + 发布负责人 | 2026-11-17 | M5-08、M5-10 | 明确下载页/SmartScreen 提示与 stable 阻塞规则 |
| 12 | 准备 EULA 与隐私说明 | 产品负责人 + 法务/合规 | 2026-11-28 | M5-09 | 中英文文本、安装包与关于页入口齐全 |
| 13 | 准备 GPLv2 全文、MinGit 源码获取说明与源码归档 | 发布负责人 | 2026-11-14 | M5-03 | `bundled-binaries.json`、`license-exceptions.json`、`THIRD_PARTY_NOTICES` 可查 |
| 14 | 确认 SmartScreen 预期与发布说明措辞 | 发布负责人 | 2026-11-17 | M5-08 | 未签名/OV/EV 的状态分别写清楚，不承诺“签名即无警告” |
| 15 | 确认安装包体积预算 | 项目负责人 + 发布负责人 | 2026-11-20 | M5-03 | 记录 Electron 基线、MinGit 增量与最终体积 |

## 3. 证书方案备注

- **Azure Artifact Signing（原 Trusted Signing）**：服务支持组织位于美国、加拿大、欧盟、英国；个人账户仅美国、加拿大。Basic 约 9.99 美元/月，包含 5,000 次签名；证书与时间戳由服务管理。地区不满足时不能作为主方案。
- **OV 云签名/硬件令牌**：适合无法使用 Azure 的个人或组织；私钥必须在硬件令牌或云 HSM 中，不能导出到 CI 文件；费用与周期以 CA 报价为准，通常高于 150 美元/年。
- **EV**：仅在客户/采购强制要求时选择；不保证立即消除 SmartScreen 警告。
- **自签名**：仅限本地测试，不能用于公开分发。

## 4. 门禁规则

- M5-08 开始前，第 1～5 项必须完成；否则只能停在 unsigned beta 构建，不得发布 stable。
- M5-06 开始前，第 6 项必须完成；否则更新功能只能用测试源开发，不能进入发布验收。
- M5-10 开始前，第 8～10 项必须完成；没有干净 VM/标准用户证据时，不得标记 M5 完成。
- M5-03 合并前，第 13 项必须完成；GPL 登记不完整时不得把 MinGit 纳入安装包。
- 第 11、14 项未确认时，发布说明不得使用“已验证发布者”“无 SmartScreen 警告”等表述。

## 5. 参考

- Microsoft Learn：[Artifact Signing signing integrations](https://learn.microsoft.com/en-us/azure/trusted-signing/how-to-signing-integrations)
- Microsoft Learn：[Artifact Signing pricing](https://azure.microsoft.com/en-us/pricing/details/trusted-signing/)
- Microsoft Learn：[Code signing options](https://learn.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools)
- CA/Browser Forum：[Code Signing Baseline Requirements](https://cabforum.org/working-groups/code-signing/requirements/)
