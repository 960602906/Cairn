# 故障排查

> 先导出诊断包（“设置 → 通用与外观 → 诊断包”或“设置 → 关于 → 导出诊断包”）。诊断包会
> 脱敏 API Key、令牌与主目录路径；默认不包含会话消息正文，需要时再显式开启。

## 1. 应用无法启动或窗口空白

- 确认从安装目录启动的是 `Cairn.exe`，而不是残留的旧快捷方式。
- 检查任务管理器：如果已有 `Cairn.exe` 在运行，Cairn 会复用单实例，不会打开第二个窗口。
- 查看 `%APPDATA%\Cairn\logs` 中最新的主进程日志。
- 删除 `%APPDATA%\Cairn\session`（Chromium 缓存）后重启；不要先删除 `data`。
- 如果最近安装过更新，检查 `backups` 中是否有更新前备份。

## 2. SmartScreen 或“未知发布者”

未签名 beta 没有可验证的发布者签名，Windows 可能显示警告。确认下载来源和 SHA-256 后再
继续；不要为了让警告消失而关闭 Defender。配置签名后，更新页与安装包会显示发布者签名
状态；签名不匹配时更新会被拒绝。

## 3. 没有可用的模型

1. 打开“设置 → 模型供应商”，添加官方 API 或自定义中转。
2. 填写 Base URL、API Key 和至少一个模型。
3. 使用“测试连接”确认网络与 Key；失败时检查地址是否包含正确的版本路径。
4. 回到新建对话页，选择项目目录与默认模型。

API Key 只保存在本机系统凭据中；如果系统加密不可用，Cairn 会拒绝保存 Key。

## 4. 网络与代理

- 模型请求、技能市场与 MCP 连接使用系统代理设置。
- 更新检查只访问公开只读的静态 HTTPS 源；代理拦截或证书替换会导致校验失败。
- 断网时应用仍可浏览本地会话；更新与市场会显示失败状态，可以重试。
- 企业代理需要额外的根证书时，应由系统管理员配置；Cairn 不提供绕过证书校验的开关。

## 5. 更新失败

- 确认更新源可匿名访问，且 `latest.yml`/`beta.yml` 指向当前通道。
- 哈希或签名不匹配时不会安装；删除下载缓存后重试。
- 磁盘空间不足会中止下载或安装；清理空间后重试。
- 有任务运行、待审批或检查点恢复时，重启安装会被阻止；完成或停止任务后再试。
- 更新安装前会备份数据库、设置与凭据元数据到 `backups`；不要手动删除该目录。

## 6. 命令被拒绝或沙箱不可用

- 默认档位是“工作区可写”，工作区外不可写；读取与命令仍需经过权限规则和审批。
- 受限令牌回退时网络无法隔离，界面会明确标注；AppContainer 仅用于实验/诊断。
- 沙箱不可用时默认失败关闭；可以在设置中改为“每次询问”，但每次仍需要显式批准。
- 沙箱不是虚拟机，不能防御同一用户权限下的所有攻击；不要把不可信项目当作完全隔离环境。
- 需要脱离沙箱时，必须逐次审批；不会生成跨会话的永久放行规则。

## 7. Git 与检查点

- 优先使用本机 Git ≥ 2.32；没有时使用随包 MinGit；两者都不可用时检查点降级。
- 检查点降级后，写文件类改动仍可通过改动记录撤销。
- 如果项目目录位于网络盘、权限受限目录或超长路径，Git 可能失败；先尝试本地磁盘路径。
- 不要手动修改 `checkpoints` 中的影子仓库；恢复失败时先导出诊断包。

## 8. 设置或数据异常

- 设置文件损坏时应用会按默认值启动，并保留未知字段；重新保存设置即可修复。
- 不要同时运行两个应用实例写同一个数据目录；单实例锁会阻止第二个实例。
- 需要重置界面设置时，先退出应用，把 `settings.json` 备份为 `settings.json.bak`，再删除
  原文件；重新启动后语言、主题与模型设置会回到默认值。
- 不要直接编辑 `credentials.json`；删除它会导致已保存的 Key 与令牌不可用。

## 9. 卸载后仍有数据

这是预期行为。卸载保留 `%APPDATA%\Cairn`，以便重装后恢复项目、会话与设置。需要彻底清理
时，退出应用后手动删除该目录；删除前先备份需要保留的内容。

## 10. 提交问题

导出诊断包并附上：

- Cairn 版本、更新通道、Windows 版本与是否管理员账户；
- 复现步骤与预期/实际结果；
- 是否使用代理、是否有 Git、是否中文用户名或长路径；
- 诊断包路径（不要直接粘贴 API Key、令牌或未脱敏日志）。

---

## English summary

Export a diagnostics bundle first; it redacts keys, tokens and home paths. For a blank
window, check for an existing `Cairn.exe` instance and review `%APPDATA%\Cairn\logs`. For
model failures, verify Base URL, key and connection test. Update failures usually mean
network/proxy, hash/signature mismatch, low disk space or a running task. Sandbox denials
are expected outside the workspace; sandboxing is not a virtual machine. Uninstall keeps
`%APPDATA%\Cairn` by design; remove it manually after backing up anything you need.
