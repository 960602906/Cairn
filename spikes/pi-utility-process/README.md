# S1：pi 在 utilityProcess 中运行

## 问题

pi-agent-core / pi-ai 能否在 Electron `utilityProcess` 中加载，并完成一次带工具调用的对话；是否依赖 DOM、全局变量或特定环境（m0.md 第 4 节 S1，ADR-0003、ADR-0004）。

## 版本

按最新稳定版选择（2026-11-03 npm 上的 `latest`）：

| 组件 | 版本 | 说明 |
|---|---|---|
| Electron | 45.2.1 | 内置 Node 24.22.1，与桌面应用一致 |
| @earendil-works/pi-agent-core | 1.5.0 | `Agent`：agent 循环、工具执行、事件订阅、`abort()` |
| @earendil-works/pi-ai | 1.5.0 | `createModels` / `createProvider`，OpenAI Chat Completions 接口（`openai-completions.lazy`） |
| Vite | 8.3.5 | 把宿主与 pi 打成单个 ESM 产物，对照"依赖外置"的方式 |
| electron-builder | 26.18.0 | 只做 `--dir` 打包，不生成安装包 |

本目录不属于 pnpm workspace，用 npm 独立安装，依赖不进入应用的锁文件和许可证检查。

## 做法

- `src/mock-server.mjs`：本地 OpenAI 兼容端点（`127.0.0.1` 随机端口，SSE 流式），三个模型：
  - `tool-model`：先流式输出 `reasoning_content` 和文本，再请求工具 `add({a:2,b:3})`；收到工具结果后回复 `2 + 3 = 5`；
  - `slow-model`：每 40 ms 输出一段，共 100 段，用于中止；
  - `auth-fail-model`：返回 401。
  端点记录每个请求的模型、`Authorization`、消息角色、工具结果、是否流式、连接是否提前关闭。
- `src/host.mjs`：宿主入口。Electron 下与应用相同（`utilityProcess.fork` + `MessageChannelMain`，主进程经 `{ type: 'port' }` 转交专用端口，配置和结果都走这个端口）；纯 Node 对照组用 `child_process.fork` 的 IPC。
- `src/probe.mjs`：在加载 pi 之前安装，记录读取过的环境变量、`fetch` 的目标地址、加载前后新增的全局变量，以及 `window` / `document` / `navigator` 等 DOM 相关全局的类型。
- `src/scenario.mjs`：用 `Agent` + `createProvider` 指向 mock 端点跑三个场景。API Key 通过 `auth.apiKey.resolve` 注入（ADR-0010：宿主从主进程拿到凭据），不放进环境变量。
- 宿主以一个空临时目录作为 `HOME` / `USERPROFILE`，运行后检查其中是否被写入文件。

## 检查项

`src/checks.mjs` 共 16 项，任何一项失败则该环境失败：

- pi 能加载（记录耗时）；
- 工具调用：`prompt()` 正常结束；第一条回复 `stopReason` 为 `toolUse`；工具收到解析后的参数 `{a:2,b:3}`；第二次请求带回同一个 `tool_call_id` 和结果；最终回复正确且 `stopReason` 为 `stop`；文本以多个增量流式到达；`reasoning_content` 被解析为思考内容；
- 所有请求都是流式的，且带注入的 API Key；
- 中止：收到 3 个文本增量后 `abort()`，`prompt()` 正常结束，最后一条消息 `stopReason` 为 `aborted`，HTTP 连接被提前关闭；
- 错误：401 时 `prompt()` 正常结束（不抛出），最后一条消息 `stopReason` 为 `error`；
- 除 mock 端点外没有其他网络请求；没有向 `HOME` 写入文件。

## 运行

```sh
cd spikes/pi-utility-process
npm ci
node src/cli.mjs --out=result-node.json                                   # 纯 Node，宿主用源码
npx vite build                                                            # 宿主 + pi 打包到 dist/host.mjs
node src/cli.mjs --host=bundled --out=result-node-bundled.json            # 纯 Node，宿主用打包产物
npx electron . --out=result-electron.json                                 # utilityProcess（Linux 需 xvfb-run，容器内加 --no-sandbox）
npx electron . --host=bundled --out=result-electron-bundled.json
npx electron-builder --dir --publish never                                # 打包到 out/（含 src/ 与 dist/）
out/win-unpacked/PiUtilityProcessSpike.exe --out=result-packaged.json     # Windows 打包后运行，宿主从 app.asar 加载
out/win-unpacked/PiUtilityProcessSpike.exe --host=bundled --out=result-packaged-bundled.json
node src/summarize.mjs result-*.json                                      # 汇总为表格
```

CI：`.github/workflows/spike-pi-utility-process.yml` 在 Windows 与 Linux 上执行以上全部步骤，表格写入作业摘要，结果文件作为构件上传。

## 决策标准

能跑通则维持 ADR-0003；否则评估在宿主内用 worker 或调整进程模型。

## 结果

耗时只用于判断量级。"加载 pi"为动态 `import` 三个入口的耗时；"工具调用一轮"为一次 `prompt()`（两次模型请求 + 一次工具执行）；"中止后结束"为调用 `abort()` 到 `prompt()` 返回的时间。

**Linux 容器（x64），2026-11-03**

| 环境 | 进程类型 | 版本 | 结果 | 加载 pi ms | 工具调用一轮 ms | 中止后结束 ms | 读取的环境变量 | 新增全局变量 |
|---|---|---|---|---|---|---|---|---|
| node | node | Node 24.22.2 | 通过 16/16 | 32.6 | 172 | 3.3 | WATCH_REPORT_DEPENDENCIES | - |
| node (bundled) | node | Node 24.22.2 | 通过 16/16 | 10.1 | 130 | 2.8 | WATCH_REPORT_DEPENDENCIES | - |
| electron | utility | Electron 45.2.1 | 通过 16/16 | 28.1 | 151 | 4.1 | WATCH_REPORT_DEPENDENCIES | - |
| electron (bundled) | utility | Electron 45.2.1 | 通过 16/16 | 8.9 | 123 | 2.2 | WATCH_REPORT_DEPENDENCIES | - |
| packaged | utility | Electron 45.2.1 | 通过 16/16 | 34.2 | 148 | 1.9 | WATCH_REPORT_DEPENDENCIES | - |
| packaged (bundled) | utility | Electron 45.2.1 | 通过 16/16 | 8.4 | 119 | 1.8 | WATCH_REPORT_DEPENDENCIES | - |

**Windows（GitHub Actions `windows-latest`，x64），2026-11-03**

| 环境 | 进程类型 | 版本 | 结果 | 加载 pi ms | 工具调用一轮 ms | 中止后结束 ms | 读取的环境变量 | 新增全局变量 |
|---|---|---|---|---|---|---|---|---|
| node | node | Node 24.22.2 | 通过 16/16 | 64.6 | 426 | 3.2 | WATCH_REPORT_DEPENDENCIES | - |
| node (bundled) | node | Node 24.22.2 | 通过 16/16 | 15.8 | 304 | 3.3 | WATCH_REPORT_DEPENDENCIES | - |
| electron | utility | Electron 45.2.1 | 通过 16/16 | 51.2 | 382 | 3.7 | WATCH_REPORT_DEPENDENCIES | - |
| electron (bundled) | utility | Electron 45.2.1 | 通过 16/16 | 17.1 | 308 | 2.5 | WATCH_REPORT_DEPENDENCIES | - |
| packaged | utility | Electron 45.2.1 | 通过 16/16 | 66.1 | 305 | 2.8 | WATCH_REPORT_DEPENDENCIES | - |
| packaged (bundled) | utility | Electron 45.2.1 | 通过 16/16 | 16.4 | 309 | 2.5 | WATCH_REPORT_DEPENDENCIES | - |

Windows 上"工具调用一轮"较长，主要是 mock 端点每段之间 `setTimeout(5)` 的开销：Windows 计时器精度约 15.6 ms，一轮约 20 段。

观察：

1. pi 在 `utilityProcess` 中加载并完成全部场景，Windows 与 Linux 上开发运行与打包后（从 `app.asar` 加载）都正常，与纯 Node 行为一致。
2. **不依赖 DOM 或特定环境。** `window`、`document`、`self`、`localStorage`、`XMLHttpRequest` 均为 `undefined`；`navigator` 是 Node 21 起自带的全局对象。加载 pi 不新增全局变量。唯一读取的环境变量 `WATCH_REPORT_DEPENDENCIES` 来自 Node 内部（与 pi 无关）；没有读取 `OPENAI_API_KEY` 等变量，凭据完全由 `auth.apiKey.resolve` 提供。
3. 除配置的端点外没有任何网络请求（`pi-telemetry` 只有接口，没有导出器），也不向 `HOME` 写文件。
4. 工具调用一轮的消息为 `system → user → assistant(toolUse) → toolResult → assistant(stop)`，第二次请求按 OpenAI 格式发送 `role: tool` 与对应的 `tool_call_id`；`reasoning_content` 被解析为 `thinking` 内容。
5. **中止与错误不抛异常。** `abort()` 后约 2～4 ms `prompt()` 返回，最后一条消息为 `stopReason: 'aborted'`（带已收到的部分文本），底层 HTTP 连接被关闭。401 时同样正常返回，最后一条消息为 `stopReason: 'error'`、`errorMessage` 为响应内容，且只请求一次（不重试）。适配器（`packages/runtime-pi`）需要按 `stopReason` 转换为 `turn.aborted` / 错误事件，而不是依赖异常。
6. **建议把 pi 打进宿主产物。** pi-ai 依赖各家 SDK（AWS、Google、Anthropic、OpenAI 等，生产依赖 89 个）：依赖外置时 `app.asar` 约 54 MB，几乎全是 `node_modules`；Vite 打包后宿主产物约 1.1 MB（OpenAI 兼容接口是按需加载的独立分块），加载耗时从约 30 ms 降到约 9 ms（Windows 上从 50～65 ms 降到约 16 ms）。桌面应用的 electron-vite 目前只打包 `@nexus/*`，M1 接入 pi 时应把 pi 加入 agent-host 构建的 `noExternal`。
7. 许可证：89 个生产依赖为 MIT、Apache-2.0、BSD-3-Clause、Unlicense、0BSD，均在 ADR-0014 白名单内。

## 结论

**维持 ADR-0003：pi 在 `utilityProcess` 中运行无问题，无需 worker 或调整进程模型。** M1 的 pi 适配器按上面第 5、6 条处理中止 / 错误与打包方式。
