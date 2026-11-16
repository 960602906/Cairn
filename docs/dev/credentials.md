# 凭据存储 / Credential storage

Cairn 只保存用户自己输入的 API Key（ADR-0010）。明文只在主进程解密后交给对应的 Agent 宿主，
不写入 SQLite、`settings.json`、日志或诊断包，也不返回给界面（界面只看到末 4 位与是否已配置）。

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

- `ciphertext` 由 Electron `safeStorage` 加密，密钥来自操作系统的凭据保护机制；文件本身不含明文。
- POSIX 上文件权限为 `0600`；写入先写临时文件再改名，避免半写。
- 文件无法解析或版本不支持时视为没有凭据：下次写入前把原文件改名为
  `credentials.json.bak-<时间戳>`，不会覆盖掉新版本应用写入的数据。
- 解密时若系统提示密钥已轮换（`shouldReEncrypt`），会立即用新密钥重新加密保存；失败只记录，
  不影响本次解析。

## 2. 各平台的加密后端

| 平台 | 后端 | 说明 |
|---|---|---|
| Windows | DPAPI | 绑定当前 Windows 用户；重装系统或换用户后无法解密 |
| macOS | Keychain | 绑定当前登录用户 |
| Linux | libsecret（GNOME Keyring）、KWallet 5/6 | 需要桌面会话中已解锁的密钥环 |

Linux 上 Electron `safeStorage` 在没有可用密钥环时会给出 `basic_text`（固定密钥的弱加密）
或 `unknown`。Cairn 把这两种情况都按**不可用**处理，拒绝保存（ADR-0040）。

## 3. Linux：检查与准备密钥环

在桌面会话里运行 Cairn 时，密钥环通常随登录自动解锁。以下情况容易没有密钥环：

- 通过 SSH 或纯终端启动，没有 `DBUS_SESSION_BUS_ADDRESS`；
- 精简桌面/窗口管理器没有启动 gnome-keyring 或 KWallet；
- 密钥环存在但处于锁定状态（登录时输入的口令与密钥环口令不一致）。

检查与准备：

```bash
# 1. 当前会话是否有 D-Bus（空值表示没有桌面会话总线）
echo "$DBUS_SESSION_BUS_ADDRESS"

# 2. 安装密钥环（Debian/Ubuntu 示例；Fedora 用 dnf，Arch 用 pacman）
sudo apt install gnome-keyring libsecret-1-0

# 3. 在桌面会话中解锁：GNOME 打开“密码和密钥”（seahorse），KDE 打开 KWallet 管理器
```

准备好后重启 Cairn，设置页的 Key 输入框会恢复可用。若仍不可用，界面会给出三种原因之一：

| `reason` | 含义 | 处理 |
|---|---|---|
| `insecure-linux-backend` | 只有 `basic_text` 弱加密 | 安装并解锁密钥环后重启 |
| `unknown-linux-backend` | 无法确认后端 | 确认在桌面会话中启动，且密钥环服务在运行 |
| `system-encryption-unavailable` | 系统加密不可用 | 检查系统凭据服务（Windows：凭据管理器；macOS：钥匙串访问） |

不可用只影响保存 Key：会话、项目、工具、检查点等功能照常使用。Cairn 不会退化为弱加密或
明文，也不支持“忽略风险继续保存”。

## 4. 换机器、换用户与备份

- 加密密钥绑定操作系统的当前用户，**`credentials.json` 不能直接复制到另一台机器或另一个
  用户**；复制过去会解密失败（`credentials.decrypt_failed`），重新输入 Key 即可。
- 备份整个数据目录时，`credentials.json` 也在其中；它离开本机后无法解密，但仍建议按敏感文件
  对待。
- 删除某个供应商的 Key：在设置页点“删除”，或退出 Cairn 后从 `credentials.json` 中移除对应
  条目（不要手工修改 `ciphertext`）。

## 5. 为什么不提供口令派生密钥

无密钥环时用“用户口令 + KDF”加密是可行方案，但需要解锁界面、忘记口令与重设、启动顺序与
自动化场景的完整设计。M6 选择显式拒绝并说明原因，把复杂度与风险留到单独决策（ADR-0040）。
