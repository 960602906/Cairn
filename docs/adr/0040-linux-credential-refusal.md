# ADR-0040 Linux 无系统密钥环时的凭据策略：显式拒绝

- 状态：已接受（2026-11-16）
- 日期：2026-11-16
- 相关决策：ADR-0010（凭据提供方与加密存储）、ADR-0014（依赖与许可证）
- 实现：`apps/desktop/src/main/services/safe-storage-cipher.ts`、`credential-store.ts`；说明见
  [`docs/dev/credentials.md`](../dev/credentials.md)

## 背景

Cairn 的 API Key 经 Electron `safeStorage` 加密后保存在本机（ADR-0010），Windows 下由 DPAPI
保护，macOS 下由 Keychain 保护。Linux 上 `safeStorage` 依赖桌面环境的密钥环（libsecret 的
GNOME Keyring，或 KWallet）。没有可用密钥环时，Electron 会退化为后端 `basic_text`（固定密钥
的“加密”）或报告后端未知；在服务器、容器、精简桌面或未解锁的会话里都可能出现。

原实现把这类情况统一按“不可用”处理并拒绝保存，但界面只有一句“系统加密不可用”，用户无法
判断该装什么、为什么装。M6 要在 Linux 上分发（M6-03），必须把行为与说明一起定清楚。

## 决定

- **继续显式拒绝，不退化。** 不可用时拒绝保存与读取，错误码仍为 `credentials.unavailable`，
  不退化为 `basic_text`、不写明文、不要求用户“接受风险”。
- **区分原因并告知用户。** 把不可用分成三种，随 `credentials.status` 返回 `reason`：
  - `system-encryption-unavailable`：Electron 报告加密不可用；
  - `insecure-linux-backend`：后端为 `basic_text`（弱加密）；
  - `unknown-linux-backend`：后端缺失或为 `unknown`，无法确认安全性。
  设置页按原因给出具体说明：`insecure-linux-backend` 提示安装并解锁 GNOME Keyring 或 KWallet。
- **本轮不实现口令派生密钥。** 不用“用户口令 + KDF（如 scrypt/Argon2）+ AEAD”作为无密钥环
  时的替代方案；如后续需要，单独写 ADR 并设计解锁、忘记口令与重加密流程。
- **凭据拒绝不阻塞其它功能。** 会话、项目、工具、检查点等照常可用；只是不能保存 Key。

## 备选方案

- **接受 `basic_text`（弱加密）**：密钥由二进制里的固定密钥保护，任何能读文件的人都能解密，
  等于明文；不选。
- **明文保存并明确警告**：更差，且会被备份、日志与诊断包扩散；不选。
- **口令派生密钥（scrypt/Argon2 + AES-GCM）**：确实能在无密钥环时提供保护，但需要解锁界面、
  口令遗忘与重设、启动顺序、自动化场景（CI/无界面）与迁移路径；在密钥环之外再加一套密钥
  生命周期，风险与维护成本都高。M6 的首要目标是跨平台可用与仓库公开，本轮不做，留作后续 ADR。
- **只支持带密钥环的环境**：与决定一致的结果，但不区分原因、不告诉用户怎么修，体验差；不选。

## 后果

- 无密钥环的 Linux 用户不能在应用内保存 Key。界面说明原因，并在
  [`docs/dev/credentials.md`](../dev/credentials.md) 给出检查与安装步骤。
- `credentials.status` 新增可选的 `reason` 字段（向后兼容）；不支持原因的加密实现只需不提供
  `unavailableReason()`，界面回退到通用说明。
- 已有 Windows 凭据不受影响；`credentials.json` 仍是同一格式 v1。文件与 DPAPI 绑定到当前
  系统用户，复制到另一台机器或另一个用户无法解密，需重新输入 Key。
- 若后续决定做口令派生密钥，需要新的 ADR 修订本决定，并处理与现有 `credentials.json` 的
  格式区分（`version` 升级）。
