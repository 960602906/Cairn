# S7：PowerShell 预研

## 问题

m0.md 第 4 节 S7，ADR-0012：

- Windows PowerShell 5.1 与 PowerShell 7 下，命令输出的中文是否乱码；
- `-EncodedCommand` 是否可靠（转义、长度、错误与退出码）；
- 超时后能否结束整个进程树：Job Object 与 `taskkill /T` 对比。

决策标准：中文输出无乱码；超时后无残留进程。

## 版本与安装

- PowerShell：运行环境自带的 Windows PowerShell 5.1 与 PowerShell 7（如已安装）。
- [koffi](https://koffi.dev/) 3.3.6（MIT）：调用 kernel32 的作业对象 API。预编译的二进制随可选依赖 `@koromix/koffi-win32-*` 安装，不需要安装脚本。

本目录不属于 pnpm workspace，用 npm 独立安装，依赖不进入应用的锁文件和许可证检查。

## 做法

`src/powershell.mjs` 是 ADR-0012 的候选做法，检查项都通过它运行：

- 启动参数：`-NoProfile -NonInteractive -EncodedCommand <Base64(UTF-16LE)>`，脚本不经过命令行转义；标准输入立即关闭。
- 前置脚本（`PRELUDE`）：
  - `[Console]::OutputEncoding`、`$OutputEncoding` 设为无 BOM 的 UTF-8；
  - `$PSDefaultParameterValues['*:Encoding'] = 'utf8'`，文件读写默认 UTF-8；
  - `$ProgressPreference = 'SilentlyContinue'`，进度条不以 CLIXML 写入 stderr；
  - PowerShell 7 上 `$PSStyle.OutputRendering = 'PlainText'`，不输出颜色控制符。
- 用户脚本（`wrap: 'scriptblock'`）：以 UTF-8 Base64 嵌入，前置脚本运行后再解码为脚本块点执行。用户脚本有语法错误时，错误发生在前置脚本之后，错误信息同样按 UTF-8 输出。
- 结尾（`EPILOGUE`）：最后一条原生命令失败时以它的退出码退出（否则 PowerShell 只返回 0 或 1）。

每个编码检查项用三种方式各运行一次，对比默认行为：

| 方式 | 说明 |
|---|---|
| `raw` | 只传用户脚本，不做任何设置（对照组） |
| `prelude` | 前置脚本与用户脚本直接拼接 |
| `recommended` | 前置脚本 + 脚本块点执行 + 结尾（候选做法） |

## 检查项

### 编码、转义与退出码（`src/encoding.mjs`）

标为“必须”的检查项要求 `recommended` 通过：

- 中文输出：`Write-Output`、`Write-Host`、原生程序按 UTF-8 输出（node）、原生程序按控制台代码页输出（`cmd /c echo`）；Python 的默认编码与 `PYTHONUTF8=1` 只记录。
- stderr：`Write-Error` 的中文可读，没有 CLIXML 与颜色控制符；`Write-Progress` 不写入 stderr。
- 文件：`Get-Content` 读无 BOM 的 UTF-8；`>` 重定向写出的不是 UTF-16。
- 参数与路径：向原生程序传含空格的中文参数；中文目录名；引号、`$`、反引号、管道符、制表符、emoji 原样传入。
- 错误与退出码：语法错误中的中文可读且退出码非 0；`exit 7`；最后一条原生命令以 3 退出；原生命令失败后又成功（退出码 0）；`Read-Host` 不挂起。
- 长度（只记录）：ASCII 2000～14000 个字符、汉字 1000～4000 个。Windows 命令行上限 32767 个 UTF-16 字符，Base64(UTF-16LE) 约为原文的 2.7 倍，候选做法再把用户脚本按 UTF-8 Base64 嵌入一次。
- 长脚本回退：3 万个汉字的脚本写成带 BOM 的 UTF-8 `.ps1`，用 `-File` 运行。
- 启动耗时：`exit 0` 运行 5 次的中位数。

### 进程树结束（`src/tree.mjs`，仅 Windows）

测试进程树（`src/fixtures/tree.mjs`）每个进程启动后把自己的 pid 写入文件：

| 场景 | 说明 |
|---|---|
| `nested` | PowerShell → node(root) → node(mid) → node(leaf) |
| `orphan` | root 以 detached 启动 mid 后退出，mid、leaf 的父进程已不存在 |
| `start-process` | PowerShell 用 `Start-Process -NoNewWindow` 启动 nested 树 |

结束方式：

| 方式 | 说明 | 必须通过 |
|---|---|---|
| `kill` | 只结束 PowerShell（`child.kill()`，对照组） | 否 |
| `taskkill` | `taskkill /T /F /PID <PowerShell>`，按父子关系结束 | 除 `orphan` 外 |
| `job` | 启动后立即把 PowerShell 放进作业对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），结束时 `TerminateJobObject` | 是 |
| `job-close` | 同上，结束时只关闭作业句柄（模拟应用退出或崩溃） | 是 |

结束后最多等 5 秒，检查 PowerShell 与各角色进程是否都已退出。

## 运行

```sh
cd spikes/powershell
npm ci
node src/cli.mjs --out=result.json          # 全部检查
node src/cli.mjs --only=encoding            # 只跑编码检查
node src/cli.mjs --shells=pwsh              # 只测 PowerShell 7
node src/summarize.mjs result.json          # 汇总为 Markdown 表格
```

CI：`.github/workflows/spike-powershell.yml`，在 `windows-latest` 上分默认控制台代码页与 `chcp 936` 两组运行。

### 中文系统本地复测

CI 的运行环境是英文系统（ANSI 代码页 1252，控制台 437），`chcp 936` 只改变控制台代码页。真实中文系统（ANSI 与 OEM 代码页都是 936）需在本地复测：

```powershell
git clone https://github.com/960602906/NEXUS-OS.git
cd NEXUS-OS\spikes\powershell
npm ci
node src\cli.mjs --out=result-zh.json
node src\summarize.mjs result-zh.json > result-zh.md
```

结果开头会打印每个 PowerShell 的 `ACP=936 OEM=936 culture=zh-CN`，确认环境正确。把 `result-zh.json` 发回即可。

## 结果

2026-11-03，GitHub Actions `windows-latest`（Windows Server 2025，10.0.26100，英文系统：ANSI 代码页 1252、控制台 437），Node 24.22.2，Windows PowerShell 5.1.26100、PowerShell 7.6.9。默认与 `chcp 936` 两组结果相同：`chcp 936` 只作用于 cmd 自己，PowerShell 中读到的控制台代码页仍为 437，这一组不能代替中文系统复测。

### 编码、转义与退出码

两个 PowerShell 版本下，`recommended` 通过全部必须项。`raw` 与 `prelude` 的问题（✅ 通过，❌ 失败，5.1 / 7 不同时分开写）：

| 检查 | raw | prelude | recommended |
|---|---|---|---|
| Write-Output、Write-Host、中文目录名、特殊字符、`Get-Content` 读无 BOM 的 UTF-8 | ❌ 输出按控制台代码页 437 编码，中文变 `?` | ✅ | ✅ |
| `cmd /c echo`（按控制台代码页输出） | ❌ | ✅ | ✅ |
| node 输出 UTF-8、向原生程序传中文参数 | ✅ | ✅ | ✅ |
| 原生程序 stderr 中文 | ✅ | ✅ | ✅ |
| Python 默认编码 | ❌ 无输出（按 cp1252 编码中文出错） | ❌ | ❌ |
| Python + `PYTHONUTF8=1` | ✅ | ✅ | ✅ |
| `Write-Error`、`throw` 写入 stderr | ❌ CLIXML | 5.1 ❌ CLIXML；7 ✅ | ✅ |
| 进度条 | ❌ stderr 出现 CLIXML | ✅ | ✅ |
| `>` 写文件 | 5.1 ❌ UTF-16LE；7 ✅ 无 BOM 的 UTF-8 | 5.1 带 BOM 的 UTF-8；7 无 BOM | 同 prelude |
| 语法错误中的中文 | ❌ 中文乱码、CLIXML | ❌ 语法错误在前置脚本运行前就报告，前置脚本不生效 | ✅ 退出码 1 |
| `exit 7`、原生命令失败后又成功（退出码 0） | ✅ | ✅ | ✅ |
| 最后一条原生命令以 3 退出 | ❌ 退出码 1 | ❌ 1 | ✅ 3 |
| `Read-Host` | ✅ 标准输入已关闭，立即返回 | ✅ | ✅ |

其他发现：

- **CLIXML**：`-EncodedCommand` 且输出被重定向时，PowerShell 把错误流序列化为 CLIXML 写入 stderr。PowerShell 7 加 `-OutputFormat Text` 即可；**5.1 加了仍然是 CLIXML**。候选做法把用户脚本放进 `try { . $sb 2>&1 | ForEach-Object { ... } } catch { ... }`，错误记录由脚本自己写到 `[Console]::Error`，两个版本都得到纯文本，stdout 内容与顺序不受影响。
- **命令行长度**：Windows 命令行上限 32767 个字符。候选做法把用户脚本先按 UTF-8 Base64、整体再按 UTF-16LE Base64，每个 ASCII 字符约占 3.6 个字符、每个汉字约占 10.7 个（前置脚本固定约 3000）。实测 6000 个 ASCII 字符（24480）、2000 个汉字（24480）可以，1 万个 ASCII 字符（38708）、4000 个汉字（45812）超过上限，`spawn` 直接报 `ENAMETOOLONG`。超过上限时改用带 BOM 的 UTF-8 `.ps1` + `-File`，3 万个汉字的脚本正常输出（文件开头同样是前置脚本）。
- **启动耗时**（`exit 0`，5 次中位数）：5.1 约 330 ms，7 约 420～480 ms。

### 进程树结束

两个版本、两组结果相同：

| 场景 | `kill`（只结束 PowerShell） | `taskkill /T /F` | Job Object：`TerminateJobObject` | Job Object：关闭句柄 |
|---|---|---|---|---|
| nested | ❌ 残留 root、mid、leaf | ✅ 约 90 ms | ✅ 约 1 ms | ✅ 约 1 ms |
| orphan（中间进程已退出） | ❌ 残留 mid、leaf | ❌ 残留 mid、leaf | ✅ | ✅ |
| `Start-Process -NoNewWindow` | ❌ 残留 root、mid、leaf | ✅ 约 80 ms | ✅ | ✅ |

- 在 PowerShell 启动后（`spawn` 返回、子进程尚未创建）立即放进作业，之后创建的所有子孙进程都在作业内（`IsProcessInJob` 全部为是），包括父进程已经退出的孤儿进程。
- `taskkill /T` 按父子关系查找，父进程退出后的子进程找不到。
- 关闭作业句柄（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）同样结束全部进程，应用退出或崩溃时句柄由系统关闭，不留下进程。
- GitHub Actions 的运行器本身也把进程放在作业中，嵌套作业（Windows 8 起）正常工作。
- koffi 在 npm 11 默认不运行安装脚本的情况下可用（预编译二进制来自可选依赖）。

### 中文系统本地复测（lan，2026-11-04）

Windows 11（10.0.26100），系统区域设置为中文：5.1 为 `ACP=936 OEM=936 culture=zh-CN`；PowerShell 7.6.9 为 `ACP=65001 OEM=936`。PowerShell 7.6.9 是商店版：经 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`（应用执行别名）启动，安装在 `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe`。

- **编码**：两个版本的结果与 CI 一致，候选做法全部通过。不做设置时同样乱码（输出按 936 编码）。Python 默认按 GBK 输出，按 UTF-8 解码后乱码，设 `PYTHONUTF8=1` 后正常。
- **进程树，5.1**：与 CI 一致，作业对象全部通过，`taskkill /T` 约 220 ms。
- **进程树，商店版 PowerShell 7**：
  - `AssignProcessToJobObject` 返回成功，pwsh 本身也在作业里（`IsProcessInJob` 为是），但它创建的子孙进程**都不在作业里**，`TerminateJobObject` 和关闭句柄后全部残留。
  - `taskkill /T` 的结果与 5.1 相同：嵌套场景可以结束，孤儿进程残留。
  - CI 上的 PowerShell 7 装在 `C:\Program Files\PowerShell\7`（MSI 版），没有这个问题。原因应是商店版作为打包应用运行，子进程脱离了调用方的作业。

## 结论

- **中文输出**：候选做法在 CI 的英文系统和本地中文系统上全部通过。
- **候选做法**写回 ADR-0012：
  - 启动参数：`-NoProfile -NonInteractive -OutputFormat Text -EncodedCommand`；
  - 前置脚本：UTF-8 输出、文件默认 UTF-8、关闭进度条、PowerShell 7 关闭颜色；
  - 用户脚本：UTF-8 Base64 嵌入，前置脚本之后解码为脚本块点执行，错误流由脚本写到 stderr；
  - 结尾：最后一条原生命令失败时以它的退出码退出；
  - 命令行超过约 30000 个字符时改用临时 `.ps1`（带 BOM 的 UTF-8）+ `-File`；
  - 子进程环境设 `PYTHONUTF8=1`（Python 默认按系统代码页输出）。
- **进程树**：只用 Job Object。`taskkill /T` 不能结束父进程已退出的子孙进程，不满足“无残留”，只在作业对象不可用时作为回退。`spawn` 后立即放进作业；超时或停止时 `TerminateJobObject`；同时设 `KILL_ON_JOB_CLOSE`，应用退出时不留下进程。
- **选择哪个 PowerShell**：优先用非商店版的 PowerShell 7，判断方法是实际路径不在 `WindowsApps` 下；否则用 Windows PowerShell 5.1（系统自带，全部检查通过）。商店版 pwsh 不选用：它的子进程脱离作业对象，超时后会残留。
- **已知限制**：`spawn` 与放进作业之间有极短的间隔，这期间 PowerShell 还在初始化（实测启动约 300 ms），尚未创建子进程。如需完全消除，可在 M1 改为以挂起方式创建进程（需原生模块），目前不需要。
