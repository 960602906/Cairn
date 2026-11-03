# ADR-0003 Agent 运行在独立的 utilityProcess 中

- 状态：已接受
- 日期：2026-11-02（2026-11-03 补充 pi 预研结论）

## 背景

最初方案把 agent 循环放在 Electron 主进程。主进程同时负责窗口、菜单和所有 IPC，如果 agent 执行大量同步计算（解析大文件、计算 diff）或某个依赖卡住，整个应用会失去响应；单个会话出错也可能拖垮整个应用。后续还要支持多会话并行，进程模型一旦定型很难再改。

## 决定

- 每个运行中的会话使用一个独立的 Agent 宿主进程（`utilityProcess.fork()`），通过 MessagePort 与主进程通信。
- 主进程只负责调度、网关、存储写入、配置、凭据和日志，不运行 agent 循环、不执行工具。
- 宿主进程空闲后回收，需要时从事件日志恢复。
- 设置运行中会话的并发上限（默认 3），并通过心跳检测卡死。

## 备选方案

- **agent 跑在主进程**：最简单，但有上述阻塞和崩溃传播问题。
- **所有会话共用一个宿主进程**：进程数少，但会话间仍会互相影响，且难以实现会话级资源回收。
- **Node `child_process` / `worker_threads`**：`utilityProcess` 是 Electron 官方推荐的方式，能直接使用 MessagePort，且与 Electron 的生命周期管理集成更好。

## pi 在 utilityProcess 中运行（S1 预研结论）

**维持本决定。** 预研在 Electron 45.2.1 的 `utilityProcess` 中运行 pi-agent-core / pi-ai 1.5.0，指向本地 mock 的 OpenAI 兼容端点，覆盖纯 Node 对照、Electron 开发运行与打包后（从 `app.asar` 加载）运行，宿主分别用源码与 Vite 打包产物加载，见 `spikes/pi-utility-process/README.md`：

- 带工具调用的对话、思考内容解析、流式增量、中止、401 错误全部正常，与纯 Node 行为一致。
- 不依赖 DOM（`window`、`document` 等均不存在），不新增全局变量，不读取凭据相关的环境变量（API Key 由宿主经 `auth.apiKey.resolve` 提供），除配置的端点外没有网络请求，不向用户目录写文件。
- 中止与错误不抛异常，以最后一条消息的 `stopReason`（`aborted` / `error`）表示，由适配器转换为事件。
- pi-ai 依赖多家厂商 SDK，依赖外置时打包体积约 54 MB；打进宿主产物后约 1.1 MB，加载也更快。宿主构建应把 pi 打包进去（electron-vite 的 `noExternal`）。

## 后果

- 需要定义主进程与宿主之间的协议（见 ADR-0009），并处理进程启动、握手、崩溃恢复。
- 每个会话多占用一个进程的内存，通过空闲回收和并发上限控制。
- 宿主进程崩溃只影响单个会话；多会话并行天然支持。
