# ADR-0016 Agent 定义与运行作为一等概念

- 状态：提议
- 日期：2026-11-02
- 详细设计：[Agent Runtime 详细设计](../design/agent-runtime.md)

## 背景

项目计划依次实现 Agent Runtime、Agent 管理界面和多 Agent 协作。如果第一版把"Agent"实现为写死在代码中的一段系统提示词，会话中也只隐含一个 Agent，那么之后：

- 管理界面无法让用户创建、修改、复用 Agent；
- 多 Agent 协作需要在事件、存储、状态机中补上"这条事件属于哪个 Agent"，涉及大量历史数据迁移。

## 决定

- 引入 **Agent 定义**（AgentDefinition）：可保存、可版本化的 Agent 模板，包含角色指令、模型选择、可用工具、权限预设、限额和上下文策略。内置 Agent 与用户 Agent 使用同一结构。
- 引入 **运行**（AgentRun）：某个 Agent 定义的某个版本在会话中的执行实例。会话包含一个或多个运行，运行之间可以有父子关系。
- 所有事件携带 `runId`（以及可选的 `parentRunId`、`stepId`）。
- 数据库新增 `agent_definitions`、`agent_runs`、`run_snapshots` 表。
- 运行引用 Agent 定义的具体版本，修改定义不影响已有运行。
- 委派子 Agent 的底层原语（父子运行、`awaiting_children` 状态、限额继承、权限收敛、取消传播）在第一版即定义，但不启用。

## 备选方案

- **第一版只有一个隐式 Agent，以后再拆分**：初期简单，但会在多 Agent 阶段造成数据迁移和大范围重构。
- **Agent 定义不做版本化**：实现更简单，但用户修改 Agent 后，历史会话将无法准确解释当时的行为。

## 后果

- 第一版的数据模型和事件稍微复杂一些。
- 管理界面和多 Agent 协作可以在不改动底层数据结构的前提下实现。
