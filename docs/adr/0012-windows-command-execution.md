# ADR-0012 Windows 命令执行方案

- 状态：已接受
- 日期：2026-11-02

## 背景

第一版开放命令执行，首发平台为 Windows。Windows 上的命令执行有一些特有问题：PowerShell 5.1 默认输出编码常导致中文乱码；结束父进程不会自动结束其子进程；命令字符串的转义规则复杂。后续还要支持 macOS 和 Linux。

## 决定

- 命令执行通过 `packages/shell` 中的 Shell 适配器完成，业务代码不出现特定 shell 的语法。
- Windows 默认使用 PowerShell 5.1（`powershell.exe`），检测到 PowerShell 7（`pwsh.exe`）时优先使用；设置中可切换为 cmd。
- PowerShell 以 `-NoProfile -NonInteractive` 启动，命令通过 `-EncodedCommand`（Base64 编码的 UTF-16LE）传入，前置脚本将输出编码设为 UTF-8。
- 工作目录固定为工作区根目录。
- 默认超时 120 秒，可配置；超时或用户停止时结束整个进程树（优先使用 Job Object，回退到 `taskkill /T /F`）。
- 子进程环境变量经过清洗，移除密钥和应用内部变量。
- 第一版不支持交互式命令，也不支持后台常驻进程；接口中预留 `background` 选项供后续实现。

## 备选方案

- **只用 cmd**：兼容性好，但功能弱，模型生成的命令多为 PowerShell 或 Unix 风格。
- **强制要求安装 PowerShell 7**：体验更一致，但增加用户安装门槛。
- **使用 node-pty 提供真实终端**：支持交互式命令，但原生模块复杂，且交互式命令在 agent 场景中难以处理；留待后续评估。

## 后果

- 需要专门的 Windows 测试覆盖编码、转义和进程树结束。
- 模型可能生成 Unix 风格的命令，系统提示词中需说明当前 shell 类型。
