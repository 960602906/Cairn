# ADR-0051 本机持久化凭据：不再依赖系统密钥环

- 状态：已接受
- 日期：2026-11-27
- 相关决策：ADR-0010（凭据提供方与加密存储）、ADR-0040（已被本决定取代）
- 实现：`apps/desktop/src/main/services/safe-storage-cipher.ts`、`credential-store.ts`；说明见
  [`docs/dev/credentials.md`](../dev/credentials.md)

## 背景

ADR-0040 在 Linux 无 GNOME Keyring / KWallet（或密钥环未解锁、`safeStorage` 后端为
`basic_text` / `unknown`）时**显式拒绝**保存 API Key。实际桌面使用中，这会让「添加供应商」
在测试连接已成功后仍无法保存 Key，界面出现「未保存 Key」，随后聊天被误报成「模型服务拒绝了
Key」。用户期望与会话、项目一样：Key 保存在本机应用数据里即可，不要求额外的系统密钥环。

## 决定

- **取代 ADR-0040 的拒绝策略。** 粘贴的供应商 API Key（及同类本机密钥）必须能写入本机应用
  数据并在重启后仍可解析，不要求安装或解锁系统密钥环。
- **优先系统加密，回退本机文件。** 当 Electron `safeStorage` 可用时（含 Linux 的
  `basic_text` / `unknown` 后端）仍用它写入 `credentials.json`；完全不可用时回退到带魔数前缀的
  本机文件编码，仅靠数据目录的文件系统权限（POSIX `0600`）保护。
- **文案如实描述。** 设置页、引导与隐私说明不再声称 Key「在系统钥匙串里」或笼统的「已在本机
  加密」，而说明保存在本机应用数据；有系统保护时顺带说明，没有时不伪装。
- **缺少已存 Key 时给出明确错误。** 配置了 `credentialRef` 但本地没有对应条目时，报
  `credentials.missing`，不得再让宿主用占位 Key 请求后落成 `model.auth_failed`。

## 备选方案

- **继续 ADR-0040 拒绝**：安全边界更清晰，但阻断无密钥环的 Linux 桌面用户；已证实误导聊天错误。
  不选。
- **口令派生密钥（KDF + AEAD）**：保护强于本机文件回退，但需要解锁 UI、遗忘与重设、启动顺序与
  自动化场景；本轮不做，若需要另开 ADR。
- **一律明文 JSON**：更简单，但连对文件的无意浏览都无遮挡；本机回退仍做编码并保留
  `credentials.json` 既有字段，不选纯明文。

## 后果

- ADR-0040 状态改为「已取代」；`credentials.status` 的 `reason` 字段保留协议兼容，默认 cipher
  不再据此返回 `available: false`。
- **安全权衡**：无系统密钥环时，能读应用数据目录的本机进程/用户可取得 Key（与能读会话数据库、
  设置的权限同级）。有 DPAPI / Keychain / 已解锁 libsecret 时仍享受系统保护。
- 冒烟与 e2e：Linux CI 亦须能完成存取；不再把「无密钥环」记为可接受的凭据失败。
- 界面与 `docs/dev/credentials.md`、README / PRIVACY 中关于钥匙串的表述需与本决定一致。
