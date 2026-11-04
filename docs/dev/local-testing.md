# 本地测试环境

需要在维护者（lan）本机运行的测试（m0.md 中标为 **[用户本地]** 的预研、M1 起的真实模型对话验证）所用的环境与接入信息。

## Windows 机器

- Windows 11（10.0.26100），系统区域设置为中文：ANSI 与 OEM 代码页都是 936，`culture=zh-CN`。
- 仓库在 `C:\Users\mrqin\Desktop\NEXUS-OS`。目录所有者是 `BUILTIN\Administrators`，git 会报 “dubious ownership”。可以给每条命令加 `-c safe.directory=C:/Users/mrqin/Desktop/NEXUS-OS`，或执行一次：

  ```powershell
  git config --global --add safe.directory C:/Users/mrqin/Desktop/NEXUS-OS
  ```

- PowerShell：自带 Windows PowerShell 5.1；PowerShell 7.6.9 是**商店版**，路径为 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`，实际安装在 `C:\Program Files\WindowsApps\...`。商店版 pwsh 的子进程会脱离作业对象，见 ADR-0012 与 `spikes/powershell/README.md`。
- npm 11 默认不运行依赖的安装脚本，koffi 会提示 `install-scripts`，不影响使用（用的是预编译二进制）。

## 本地模型网关

本机 `127.0.0.1:3425` 上有一个模型网关，同时提供四种接口格式，后面是同一个模型：

| 格式 | `kind`（ADR-0021） | baseUrl | API Key | 模型 |
|---|---|---|---|---|
| OpenAI Chat Completions | `openai` | `http://127.0.0.1:3425/v1` | `magpie` | `group/smart-split` |
| OpenAI Responses | 暂不支持 | `http://127.0.0.1:3425/v1` | `magpie` | `group/smart-split` |
| Anthropic Messages | `anthropic` | `http://127.0.0.1:3425` | `magpie` | `group/smart-split` |
| Gemini | `gemini` | `http://127.0.0.1:3425` | `magpie` | `group/smart-split` |

- 只能在这台机器上访问，CI 与云端容器连不到。
- 网关信任本机回环请求，Key 填任意值都可以，这里统一用 `magpie`（如 `GEMINI_API_KEY=magpie`）。真实的上游 Key 不要写进仓库。
- 用途：
  - 真实模型的工具调用、推理内容、流式字段的验证（S2）；
  - ADR-0021 要求的三种格式各完成一次真实对话（M1）；
  - 补录真实的契约测试录制（S8 的录制目前都是合成的）。
- OpenAI Responses 接口不在 ADR-0021 首批的三种格式之内，可用来评估是否值得增加。
