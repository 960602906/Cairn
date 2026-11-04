# ADR-0012 Windows 命令执行方案

- 状态：已接受
- 日期：2026-11-02

## 背景

第一版开放命令执行，首发平台为 Windows。Windows 上的命令执行有一些特有问题：PowerShell 5.1 默认输出编码常导致中文乱码；结束父进程不会自动结束其子进程；命令字符串的转义规则复杂。后续还要支持 macOS 和 Linux。

## 决定

- 命令执行通过 `packages/shell` 中的 Shell 适配器完成，业务代码不出现特定 shell 的语法。
- Windows 默认使用 PowerShell 5.1（`powershell.exe`）。检测到非商店版的 PowerShell 7（`pwsh.exe`，实际路径不在 `WindowsApps` 下）时优先使用。商店版 pwsh 不选用，因为它的子进程会脱离作业对象（S7）。设置中可切换为 cmd。
- PowerShell 以 `-NoProfile -NonInteractive -OutputFormat Text` 启动，命令通过 `-EncodedCommand`（Base64 编码的 UTF-16LE）传入。具体做法按 S7 预研结论（见下文“预研结论”）：前置脚本将输出与文件读写编码设为 UTF-8；用户脚本在前置脚本之后解码为脚本块执行，错误流由脚本写到 stderr；最后一条原生命令失败时以它的退出码退出；命令行过长时改用临时 `.ps1` 文件。
- 工作目录固定为工作区根目录。
- 默认超时 120 秒，可配置；超时或用户停止时结束整个进程树：进程启动后立即放进 Job Object（设 `KILL_ON_JOB_CLOSE`），结束时 `TerminateJobObject`；只在作业对象不可用时回退到 `taskkill /T /F`。
- 子进程环境变量经过清洗，移除密钥和应用内部变量；设 `PYTHONUTF8=1`。
- 第一版不支持交互式命令，也不支持后台常驻进程；接口中预留 `background` 选项供后续实现。

## 备选方案

- **只用 cmd**：兼容性好，但功能弱，模型生成的命令多为 PowerShell 或 Unix 风格。
- **强制要求安装 PowerShell 7**：体验更一致，但增加用户安装门槛。
- **使用 node-pty 提供真实终端**：支持交互式命令，但原生模块复杂，且交互式命令在 agent 场景中难以处理；留待后续评估。

## 后果

- 需要专门的 Windows 测试覆盖编码、转义和进程树结束。
- 模型可能生成 Unix 风格的命令，系统提示词中需说明当前 shell 类型。

## 预研结论（S7，2026-11-03）

`spikes/powershell/`，Windows CI（英文系统）与用户本地（中文系统区域设置，2026-11-04）上 Windows PowerShell 5.1 与 PowerShell 7.6 的结果，详见该目录 README。

- **编码**：不做设置时，PowerShell 输出、`cmd` 输出、中文路径的中文都变成 `?`。前置脚本设置 `[Console]::OutputEncoding`、`$OutputEncoding` 为无 BOM 的 UTF-8，`$PSDefaultParameterValues['*:Encoding'] = 'utf8'`，`$ProgressPreference = 'SilentlyContinue'`，PowerShell 7 上 `$PSStyle.OutputRendering = 'PlainText'` 后，全部检查通过。5.1 下 `>` 写出的是带 BOM 的 UTF-8。Python 默认按系统代码页输出，需在环境中设 `PYTHONUTF8=1`。
- **CLIXML**：`-EncodedCommand` 且输出被重定向时，错误流与进度以 CLIXML 写入 stderr。PowerShell 7 加 `-OutputFormat Text` 即可，5.1 加了仍然是 CLIXML。因此用户脚本以 `try { . $sb 2>&1 | ForEach-Object { ErrorRecord 写到 [Console]::Error，其余原样输出 } } catch { 写 stderr; exit 1 }` 执行，两个版本都得到纯文本。
- **语法错误**：前置脚本与用户脚本直接拼接时，语法错误在任何代码运行前报告，前置脚本不生效；用户脚本因此以 UTF-8 Base64 嵌入，在前置脚本之后用 `[ScriptBlock]::Create` 解析。
- **退出码**：PowerShell 只返回 0 或 1；结尾加 `if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`，最后一条原生命令的退出码得以保留。
- **长度**：两层 Base64 后每个 ASCII 字符约占 3.6 个字符、每个汉字约 10.7 个，前置脚本约 3000；Windows 命令行上限 32767。约 6000 个 ASCII 字符或 2000 个汉字以内可直接传入，超过约 30000 时改用临时 `.ps1`（带 BOM 的 UTF-8，开头同样是前置脚本）+ `-File`。
- **进程树**：`taskkill /T` 不能结束父进程已退出的子孙进程；Job Object 在嵌套、孤儿、`Start-Process` 三种场景下都在约 1 ms 内结束全部进程，关闭句柄（应用退出、崩溃）同样有效。M1 中通过 koffi（MIT）调用 kernel32 实现，打包时需随应用分发其预编译二进制。
- **启动耗时**：5.1 约 330 ms，7 约 450 ms。
- **商店版 PowerShell 7**（本地复测）：经应用执行别名启动的商店版 pwsh，`AssignProcessToJobObject` 成功、pwsh 本身也在作业里，但它创建的子孙进程都不在作业里，结束作业后全部残留。MSI 版（CI）没有这个问题。因此商店版不选用。
- **中文系统**：编码结果与英文系统一致；Python 默认按 GBK 输出，同样需要 `PYTHONUTF8=1`。
