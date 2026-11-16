# 本地测试环境

有些测试需要真实模型服务或真实 Windows 机器，CI 只跑录制回放。计划里标为 **[用户本地]**
的任务由维护者在自己机器上执行；本页记录所需环境与操作步骤，外部贡献者可按自己的环境调整。
凭据（API Key）只从环境变量读取，**不要写进仓库、录制文件或文档**。

## Windows 开发机

- Windows 10/11。验证过中文区域设置（ANSI 与 OEM 代码页都是 936，`culture=zh-CN`）下构建与
  测试正常；其他区域设置未逐一验证。
- 仓库放在哪里都可以。目录属于 `BUILTIN\Administrators` 时 git 会报 “dubious ownership”，
  给命令加 `-c safe.directory=<仓库路径>`，或执行一次：

  ```powershell
  git config --global --add safe.directory <仓库路径>
  ```

- PowerShell：自带 Windows PowerShell 5.1；PowerShell 7 如果是**商店版**，子进程会脱离作业
  对象，见 ADR-0012 与 `spikes/powershell/README.md`。
- npm 11 默认不运行依赖的安装脚本，koffi 会提示 `install-scripts`，不影响使用（用的是预编译二进制）。
- Electron 本体在第一次启动时才下载（`require('electron')` 发现缺失时运行 `install.js`）。
  网络访问 GitHub 受限时改用镜像：

  ```powershell
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  node node_modules/electron/install.js   # 在 apps/desktop 下运行
  ```

## 真实模型验证

契约录制工具（`packages/runtime-pi/src/testing/contract/`）可以把任意 OpenAI、Anthropic 或
Gemini 兼容端点当作上游，用环境变量指定：

- `CAIRN_CONTRACT_UPSTREAM`：上游 baseUrl，如 `https://api.deepseek.com`（openai 格式）、
  `https://api.deepseek.com/anthropic`（anthropic 格式），或自建网关。
- `CAIRN_CONTRACT_MODEL`：模型 id。
- `CAIRN_CONTRACT_KEY_ENV`：存放 Key 的环境变量名，工具只从该变量读取。

用自建或第三方网关时注意：思考开关、流式字段与结束符行为可能与官方接口不同，测协议细节时以
官方接口为准。

## DeepSeek 官方接口

- Key 放在环境变量 `DEEPSEEK_API_KEY` 中，不写进仓库、录制文件或文档。
- openai 格式：`https://api.deepseek.com`；anthropic 格式：`https://api.deepseek.com/anthropic`；
  没有 gemini 格式。
- 模型：`deepseek-flash`（V4.1 Flash）、`deepseek-v4-pro`。
- 云端容器可以直接访问。

## 录制契约测试（M1-02）

录制文件与黄金文件在 `packages/runtime-pi/contract/`。用法见
`packages/runtime-pi/src/contract-record.test.ts` 的说明。

- 每次录制一个场景（`openai-tool`、`openai-parallel`、`openai-abort`、`openai-auth-fail`，
  anthropic 与 gemini 同理，另有 `gemini-3-tool`）。录完会回放一次，确认结果相同，并打印每一步
  的结束原因、用量、文本与工具调用，用来检查模型的行为是否合理，例如是否真的调用了工具。
- 录制文件不含 Key。测试会检查录制中没有凭据请求头，也没有疑似 Key 的字符串。
- 录完后生成黄金文件，审阅后与录制文件一起提交。

```powershell
# DeepSeek 官方，openai 格式（Key 只从环境变量读取）
$env:DEEPSEEK_API_KEY = '<官方 Key>'
$env:CAIRN_CONTRACT_UPSTREAM = 'https://api.deepseek.com'
$env:CAIRN_CONTRACT_MODEL = 'deepseek-flash'
$env:CAIRN_CONTRACT_KEY_ENV = 'DEEPSEEK_API_KEY'
foreach ($s in 'openai-tool','openai-parallel','openai-abort') {
  $env:CAIRN_CONTRACT_ONLY = $s
  $env:CAIRN_CONTRACT_NAME = "ds-$s"
  pnpm contract:record
}
# anthropic 格式：CAIRN_CONTRACT_UPSTREAM 改为 https://api.deepseek.com/anthropic
# 认证失败：把 Key 换成错误的值，录制 *-auth-fail

pnpm vitest run -u packages/runtime-pi/src/contract.test.ts   # 为新录制生成黄金文件
Remove-Item Env:CAIRN_CONTRACT_*                              # 恢复为用合成上游录制
```

不设这些环境变量时，`pnpm contract:record` 用合成上游重新录制全部场景。
