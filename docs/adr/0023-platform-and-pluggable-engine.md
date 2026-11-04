# ADR-0023 自研平台 + 可插拔 Agent 引擎（首选 pi）

- 状态：已接受
- 日期：2026-11-04

## 背景

ADR-0004 为了隔离 pi 的版本变化，定义了 `AgentRuntime` 接口，只允许 `packages/runtime-pi` 引用 pi。实际实现中，工具流水线、权限、审批、检查点、事件、存储与界面都在我们自己的代码中，pi 只承担模型循环与模型通信。

但对外的描述仍是“基于 pi 构建”，容易让人以为 pi 是整个应用的底座。项目的定位需要明确写下来，作为以后评估改动的依据。

## 决定

NEXUS-OS = **自研 Agent 平台** + **可插拔的 Agent 引擎**（首选 pi）。

- **平台层**（`packages/protocol`、`core`、`storage`、`tools`、`i18n` 与 `apps/desktop`）由我们自己设计和维护：
  - 运行的生命周期与编排（`RunSupervisor`、`RunEngine`）、上下文组装与历史重建；
  - 工具注册表与工具流水线（校验、路径规范化、权限、审批、检查点、执行、输出预算）；
  - 事件日志与存储（自己的 `CanonicalMessage` 格式，不绑定任何引擎的格式）、凭据、界面、多 Agent 协作。
- **引擎层**只负责 agent 循环：调用模型 → 解析工具调用 → 回填工具结果 → 再调用模型，以及与模型的通信（各接口格式、流式输出、推理内容）。
- 两层之间只有 `AgentRuntime` 接口（`createSession` → `RuntimeSession`：`prompt`、`steer`、`abort`、`onEvent`、`exportHistory`、`dispose`）。工具不在引擎中执行，而是经钩子（`beforeToolCall`、`executeTool`、`beforeModelCall`）交回平台。因此更换引擎不影响权限、审批、审计与存储。
- **引擎接入条件**：
  - 实现 `AgentRuntime`，事件顺序与语义符合接口约定；
  - 引擎相关的代码与依赖只放在各自的 `packages/runtime-*` 包中，ESLint 依赖边界禁止其他包引用；
  - 锁定引擎依赖的精确版本，升级前通过契约测试（ADR-0004）。
- **pi 是首选引擎**（`packages/runtime-pi`），用于正式使用；`FakeRuntime` 用于测试与界面开发。

## 备选方案

- **以 pi 为底座，在其上开发**：开发更快，但应用的数据格式、工具执行与权限都会跟着 pi 的 API 变化，也无法更换引擎。
- **完全自研 agent 循环**：与“只做平台”相比收益不大，还要自己处理多种模型接口的差异，失去选择 pi 的主要理由（ADR-0004）。

## 后果

- README 与架构文档按此定位描述项目，不再写成“基于 pi 构建”。
- 现状与“可插拔”之间还有两处差距，在接入第二个真实引擎之前补上：
  - 宿主选择引擎的逻辑（`apps/desktop/src/agent-host/runtime-select.ts`）目前写死了 pi 与 Fake 两种，需要改为按 id 注册、按配置选择；
  - 契约测试目前只针对 pi（`packages/runtime-pi`），需要把与引擎无关的部分（事件顺序、中止、错误、工具钩子）抽成通用测试，每个引擎都运行。
- 新功能若需要引擎提供新能力，先扩展 `AgentRuntime` 接口与通用约定，再由各引擎实现，不能让平台代码直接依赖某个引擎。
