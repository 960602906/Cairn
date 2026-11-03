# ADR-0004 用 AgentRuntime 接口隔离 pi

- 状态：已接受
- 日期：2026-11-02

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

## 后果

- 需要维护一层转换代码，初期多一些工作量。
- pi 的变化被限制在一个包内；必要时可以增加其他实现（如 Claude Agent SDK、OpenAI Agents SDK 或自研循环）。
- 我们自己的消息格式成为持久化格式，不受 pi 影响（见 ADR-0005、ADR-0006）。
