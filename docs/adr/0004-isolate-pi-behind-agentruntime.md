# ADR-0004 用 AgentRuntime 接口隔离 pi

- 状态：已接受
- 日期：2026-11-02（2026-11-03 补充 S1、S8 预研结论）

## 背景

选用 pi（pi-agent-core、pi-ai）作为 agent 核心，主要因为它支持多种模型。但 pi 迭代很快，npm 包已经从 `@mariozechner/*` 迁移到 `@earendil-works/*`，API 也可能继续变化。如果业务代码到处直接使用 pi 的类型和事件，pi 一次大改就会牵动整个项目，将来想替换框架也几乎不可能。

## 决定

- 在 `packages/core` 中定义 `AgentRuntime`、`RuntimeSession`、`RuntimeEvent`、`ToolDefinition`、`CanonicalMessage` 等接口和类型。
- 只有 `packages/runtime-pi` 可以引用 pi，负责双向格式转换和钩子对接。
- 用 ESLint 依赖边界规则在 CI 中强制这一约束。
- 锁定 pi 的精确版本；升级前必须通过适配器的契约测试。
- 提供 `FakeRuntime`，用于界面开发和测试。

## 备选方案

- **直接使用 pi 的类型**：开发初期更快，但耦合严重。
- **完全自己实现 agent 循环**：完全可控，但需要自己处理多模型适配，失去选择 pi 的主要理由。

## 适配器要点（S1 预研，2026-11-03）

在 pi 1.5.0 上验证（`spikes/pi-utility-process/`，结论见 ADR-0003），`packages/runtime-pi` 实现时注意：

- 模型经 `createProvider` + `openAICompletionsApi`（`@earendil-works/pi-ai/api/openai-completions.lazy`）配置，凭据用 `auth.apiKey.resolve` 注入，不经环境变量；
- `Agent` 的 `subscribe` 事件（`message_update` 的 `text_delta` / `thinking_delta` / `toolcall_delta`、`tool_execution_start` / `end`、`turn_end` 等）映射为 `RuntimeEvent`；
- 中止和模型错误不抛异常，`prompt()` 正常返回，以最后一条助手消息的 `stopReason`（`aborted` / `error`）与 `errorMessage` 表示；401 不重试；
- pi 消息中的工具结果角色为 `toolResult`，与我们的 `CanonicalMessage` 之间需要转换。

## 版本锁定与契约测试（S8 预研，2026-11-03）

见 `spikes/pi-contract/README.md`：

- **版本锁定**：pi 自身对全部依赖（含各家 SDK）都用精确版本，因此在 `packages/runtime-pi` 中把 pi-agent-core 与 pi-ai 声明为同一个精确版本即可（`save-exact=true`，CI `--frozen-lockfile`）。守卫测试检查：声明为精确版本且相同；锁文件中每个 `@earendil-works/*` 包只有一个版本；pi-agent-core 实际加载的 pi-ai 与直接依赖是同一份（按真实路径，pnpm 下适用）。pi 约每周发布一个次版本，升级须有计划地进行。
- **契约测试在 HTTP 层录制与回放**：pi-ai 的 Gemini 适配器不支持注入 `fetch`，三种格式统一经模型的 `baseUrl` 指向本地服务。录制代理记录请求与原始响应分块（不记录凭据）；回放服务逐个比对请求（发现请求格式变化），返回录制的响应。三种格式 11 个场景在 15 种分块方式与重复回放下事件轨迹完全一致；用 pi 1.4.0 / 1.3.0 回放同一组录制，差异只有一个新增字段。**注意**：这 11 份录制都来自预研自己写的模拟上游（`source: synthetic`），证明的是录制回放机制与 pi 解析的稳定性，不能证明 pi 与真实服务兼容；M1-02 须补充从真实服务录制的文件（S2 的 DeepSeek，以及 Anthropic、OpenAI、Gemini 各至少一组）。
- **黄金文件比对适配器输出的 `RuntimeEvent`**（M1-02），不比对 pi 的原始事件；规范化时间戳、耗时与 pi 生成的工具调用 id。
- 适配器只从 `message_start` 取角色：助手消息是 pi-ai 正在填充的对象，发出时已有哪些字段取决于网络分块；用量以 `message_end` / `turn_end` 为准。各格式的错误文本不同，按状态码归类。
- **升级流程**：pi-agent-core 与 pi-ai 一起升级 → 契约测试 → 审阅请求不一致与黄金文件差异 → 更新黄金文件并在 PR 中说明。

## 后果

- 需要维护一层转换代码，初期多一些工作量。
- pi 的变化被限制在一个包内；必要时可以增加其他实现（如 Claude Agent SDK、OpenAI Agents SDK 或自研循环）。
- 我们自己的消息格式成为持久化格式，不受 pi 影响（见 ADR-0005、ADR-0006）。

## 定位补充（2026-11-04）

产品定位为"自研 Agent 平台 + 可插拔 Agent 引擎（首选 pi）"：

- **平台层**（core、protocol、storage、tools 与桌面端）负责 Run 生命周期、工具管线与权限、事件日志与存储、凭据、界面与多 Agent 协作；工具的放行与执行始终经 `RuntimeHooks` 留在平台层。
- **引擎层**只负责 agent 循环与模型通信，经 `AgentRuntime` 接入。当前实现为 `PiRuntime`（首选）与 `FakeRuntime`（测试）。
- M0–M6 均不需要第二个引擎，因此暂不做引擎注册表；`runtime-select.ts` 直接创建 `PiRuntime`。**接入第二个引擎时**再增加按 id 选择引擎的注册表，并把与引擎无关的契约测试（`RuntimeEvent` 顺序与语义）抽为通用测试，让每个实现都要通过。
