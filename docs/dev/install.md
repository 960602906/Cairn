# 安装、升级与卸载

> 适用于 Cairn 0.1.0 公开 beta（Windows x64）。安装包按用户安装，不需要管理员权限。
> 未签名 beta 可能触发 Windows SmartScreen；stable 发布前必须完成签名与法务确认。

## 1. 系统要求

- Windows 11 24H2 或更新的受支持版本（正式支持基线）。
- Windows 10 22H2（best-effort；微软已结束主流支持）。
- x64 处理器；按用户安装，不需要管理员权限。
- 磁盘空间以安装包与数据目录实际占用为准；更新前建议预留至少 2 GB。
- 不需要预先安装 Git：Cairn 优先使用本机 Git ≥ 2.32，否则使用随包 MinGit；两者都不可用时
  检查点降级，但写文件类改动仍可撤销。
- 不需要 Node.js、pnpm 或其他开发工具。

## 2. 下载与校验

1. 只从发布者公布的下载页或更新源获取 `Cairn-<version>-x64-setup.exe`。
2. 下载 `SHA256SUMS` 或对应的 `.sha256` 文件。
3. 在 PowerShell 中校验：

```powershell
Get-FileHash -Algorithm SHA256 .\Cairn-0.1.0-x64-setup.exe
Get-Content .\SHA256SUMS
```

两个 SHA-256 值必须一致。不一致时不要安装，删除文件并重新下载。

未签名 beta 在首次运行安装程序时可能显示“Windows 已保护你的电脑”。只有在确认下载来源
与哈希后才选择“更多信息 → 仍要运行”。Cairn 不会要求关闭 Windows Defender，也不会要求
管理员权限。

## 3. 安装

1. 运行安装程序；默认安装到当前用户目录。
2. 可以选择安装目录、是否创建桌面与开始菜单快捷方式。
3. 安装完成后启动 Cairn；不需要登录或创建账号。
4. 首次启动会显示一次欢迎说明：产品用途、数据位置、API Key 保存方式、更新检查、诊断包与
   安全边界。可以关闭后继续浏览已有数据，也可以在“设置 → 关于”重新查看。

如果还没有配置模型供应商，欢迎页和新建对话页都会引导到“设置 → 模型供应商”。配置并测试
连接后即可创建项目并开始对话。

## 4. 数据位置

正式版默认使用 `%APPDATA%\Cairn`，开发版使用 `%APPDATA%\Cairn-dev`。主要目录：

| 路径 | 内容 |
|---|---|
| `data/cairn.db` | 项目、会话、事件与配置元数据 |
| `data/blobs` | 文件改动内容 |
| `checkpoints` | 检查点影子仓库 |
| `worktrees` | 隔离工作区 |
| `logs` | 主进程与 Agent 宿主日志 |
| `settings.json` | 界面、模型、沙箱与更新设置 |
| `credentials.json` | 加密后的凭据 |
| `backups` | 更新前备份 |

项目文件始终留在你选择的项目目录中，不会被复制到应用数据目录。

## 5. 升级

- 默认自动检查更新；也可以在“设置 → 更新”手动检查。
- 更新只从公开只读的 HTTPS 更新源下载，并在安装前校验哈希与签名（配置了签名时）。
- 有任务运行、待审批或检查点恢复时不会静默重启；完成或停止任务后再安装。
- 安装前会备份数据库、设置与凭据元数据到 `backups`。
- 更新失败或签名不匹配时不会安装；可以根据错误状态重试或导出诊断包。

## 6. 卸载与数据保留

在 Windows“设置 → 应用”中卸载 Cairn，或运行安装目录中的 `Uninstall Cairn.exe`。卸载：

- 删除程序文件、快捷方式与卸载注册表项；
- **保留** `%APPDATA%\Cairn` 中的用户数据；
- 不会删除你的项目目录。

重新安装同一版本或更新版本后，已有项目、会话与设置会继续可用。

需要彻底清理时：

1. 退出 Cairn，确认任务栏与任务管理器中不再有 `Cairn.exe`。
2. 备份需要保留的内容（项目目录、会话导出、数据库）。
3. 手动删除 `%APPDATA%\Cairn`（开发版为 `%APPDATA%\Cairn-dev`）。
4. 如需清理临时文件，再检查 `%TEMP%` 下以 `cairn-` 开头的目录。

删除应用数据目录会永久丢失会话、设置、凭据与检查点，且无法由卸载程序恢复。

## 7. 静默安装（测试与自动化）

NSIS 支持按用户静默安装与卸载：

```powershell
.\Cairn-0.1.0-x64-setup.exe /S /D=C:\Temp\Cairn
& 'C:\Temp\Cairn\Uninstall Cairn.exe' /S /currentuser
```

`/D=` 必须是绝对路径且放在最后。自动化测试应使用临时数据目录（`CAIRN_USER_DATA_DIR`），
不要触碰真实 `%APPDATA%\Cairn`。

---

## English summary

Cairn 0.1.0 beta targets Windows x64 and installs per user without administrator rights.
Verify the installer SHA-256 before running it. Unsigned beta builds may trigger
SmartScreen; continue only if you trust the source and the hash matches. The first launch
shows a one-time notice that can be reopened from Settings → About. A model provider must
be configured before starting a conversation. User data lives in `%APPDATA%\Cairn`
(`Cairn-dev` for development) and is preserved on uninstall; delete that folder manually
to remove it. See `docs/dev/troubleshooting.md` for common failures.
