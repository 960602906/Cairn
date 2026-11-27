# 凭据存储 / Credential storage

Cairn 只保存用户自己输入的 API Key（ADR-0010、ADR-0051）。明文只在主进程解密后交给对应的
Agent 宿主，不写入 SQLite、`settings.json`、日志或诊断包，也不返回给界面（界面只看到末 4 位与
是否已配置）。

## 1. 存储位置与格式

| 平台 | 文件 | 位置 |
|---|---|---|
| Windows | `credentials.json` | `%APPDATA%\Cairn\`（开发版为 `Cairn-dev`） |
| macOS | `credentials.json` | `~/Library/Application Support/Cairn/` |
| Linux | `credentials.json` | `~/.config/Cairn/`（遵循 XDG，见安装文档） |

文件格式（`version` 1，与平台无关）：

```json
{
  "version": 1,
  "credentials": {
    "deepseek": {
      "kind": "local-key",
      "ciphertext": "<base64>",
      "updatedAt": 1767225600000
    }
  }
}
```

- `ciphertext` 优先由 Electron `safeStorage` 加密；系统加密不可用时为带魔数前缀的本机编码
  （ADR-0051）。文件权限在 POSIX 上为 `0600`；写入先写临时文件再改名，避免半写。
- 文件无法解析或版本不支持时视为没有凭据：下次写入前把原文件改名为
  `credentials.json.bak-<时间戳>`，不会覆盖掉新版本应用写入的数据。
- 解密时若系统提示密钥已轮换（`shouldReEncrypt`），会立即用新密钥重新加密保存；失败只记录，
  不影响本次解析。无系统加密时，旧的系统密文会在成功解密后改写成本机编码。

## 2. 各平台的保护方式

| 平台 | 优先后端 | 说明 |
|---|---|---|
| Windows | DPAPI（`safeStorage`） | 绑定当前 Windows 用户；重装系统或换用户后无法解密 |
| macOS | Keychain（`safeStorage`） | 绑定当前登录用户 |
| Linux | libsecret / KWallet，或 `basic_text` | 有解锁的密钥环时用它；否则 Electron 弱加密或本机文件回退 |
| 任意平台（系统加密不可用） | 本机文件编码 | 仅靠应用数据目录权限；能读该目录的本机用户/进程可以取得 Key |

**不再要求**安装或解锁 GNOME Keyring / KWallet 才能保存 Key（ADR-0051 取代 ADR-0040）。

## 3. 安全权衡

- 与会话数据库、设置文件一样，凭据在本机应用数据目录中。无 OS 密钥环保护时，保护强度等于
  「能登录你的系统用户并读该目录」。
- 有 DPAPI / Keychain / 已解锁 libsecret 时，密文离开当前用户环境通常无法解密。
- Cairn 不会把 Key 上传到 Cairn 自身服务；模型请求只会把 Key 发给你配置的模型提供方。

## 4. 换机器、换用户与备份

- 经系统加密保存的条目绑定操作系统当前用户，**不能直接复制到另一台机器或另一个用户**；复制
  过去会解密失败（`credentials.decrypt_failed`），重新输入 Key 即可。本机文件回退的条目随
  `credentials.json` 复制后仍可读，请按敏感文件对待备份。
- 删除某个供应商的 Key：在设置页点「删除」，或退出 Cairn 后从 `credentials.json` 中移除对应
  条目（不要手工修改 `ciphertext`）。

## 5. 缺少已存 Key

配置里有 `credentialRef` 但本地没有对应条目时，聊天会报 `credentials.missing`（请到设置重新
粘贴 Key），而不会再伪装成 `model.auth_failed`（模型服务拒绝了 Key）。

## 6. 为什么不做口令派生密钥

无系统保护时用「用户口令 + KDF」加密是可行方案，但需要解锁界面、忘记口令与重设、启动顺序与
自动化场景的完整设计。ADR-0051 选择本机持久化并如实说明权衡；若以后要做口令方案，另开 ADR。
