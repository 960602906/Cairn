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

待 CI 运行后补充。

## 结论

待补充。
