# Agent Runtime 详细设计

> 状态：已确认（v1.1，补充能力层、记忆、运行模式）
> 作者：960602906
> 上层文档：[架构设计](../architecture.md)。相关决策：ADR-0003、ADR-0004、ADR-0005、ADR-0007、ADR-0016。
> 后续文档：Agent 管理界面、多 Agent 协作（均基于本文档）。

## 目录

1. [范围](#1-范围)
2. [核心概念](#2-核心概念)
3. [Agent 定义](#3-agent-定义)
4. [运行时组件](#4-运行时组件)
5. [运行状态机](#5-运行状态机)
6. [Agent 循环](#6-agent-循环)
7. [工具执行流水线](#7-工具执行流水线)
8. [上下文组装与预算](#8-上下文组装与预算)
9. [用户介入：追加、引导与中断](#9-用户介入追加引导与中断)
10. [取消、超时与限额](#10-取消超时与限额)
11. [生命周期钩子](#11-生命周期钩子)
12. [事件](#12-事件)
13. [持久化与恢复](#13-持久化与恢复)
14. [模型切换](#14-模型切换)
15. [用量统计](#15-用量统计)
16. [为多 Agent 预留的委派原语](#16-为多-agent-预留的委派原语)
17. [接口定义](#17-接口定义)
18. [测试](#18-测试)
19. [对总体架构的影响](#19-对总体架构的影响)
20. [已确认事项](#20-已确认事项)
21. [能力层：Tools、Skills 与 MCP](#21-能力层toolsskills-与-mcp)
22. [记忆（预留）](#22-记忆预留)
23. [交互运行与无人值守运行](#23-交互运行与无人值守运行)
24. [脱离界面运行](#24-脱离界面运行)

---

## 1. 范围

Agent Runtime 是运行在 Agent 宿主进程（ADR-0003）中的那部分代码，负责：

- 按照一个 **Agent 定义** 驱动一次 **运行**：组装上下文、调用模型、执行工具、处理审批、产出事件。
- 管理运行的状态、限额、取消和恢复。
- 为后续的多 Agent 协作提供底层原语（父子运行、委派、限额继承）。

不在本文档范围：界面（见 Agent 管理界面设计）、多 Agent 的协作模式（见多 Agent 协作设计）、存储实现（见 ADR-0006）。

**设计目标**：

1. Agent 是一等公民：可以定义、保存、复用、版本化，而不是写死在代码里的一段提示词。
2. 一次运行的所有行为都可观察、可中断、可恢复、可回退。
3. 单 Agent 与多 Agent 使用同一套运行机制，多 Agent 只是"运行可以产生子运行"。
4. 与 pi 解耦：本文档中的所有类型都不依赖 pi，pi 只出现在适配器里（ADR-0004）。

---

## 2. 核心概念

| 概念 | 英文 | 说明 |
|---|---|---|
| Agent 定义 | AgentDefinition | 一个 Agent 的"模板"：角色、指令、模型、可用工具、权限、限额。可保存、可版本化 |
| 会话 | Session | 用户可见的一段对话，绑定一个工作区。包含一个或多个运行 |
| 运行 | AgentRun | 某个 Agent 定义在某个会话中的一次执行实例。单 Agent 会话中只有一个根运行；多 Agent 时根运行可以产生子运行 |
| 轮次 | Turn | 运行中，从一条用户（或父运行）输入开始，到 Agent 给出最终回复结束 |
| 步骤 | Step | 轮次中的一次模型调用，以及它触发的工具调用 |
| 工具调用 | ToolCall | 一次具体的工具执行 |

层级关系：

```
Session
 └── AgentRun（根运行，引用 AgentDefinition@版本）
      ├── Turn 1
      │    ├── Step 1：模型调用 → ToolCall a, ToolCall b
      │    ├── Step 2：模型调用 → ToolCall c
      │    └── Step 3：模型调用 → 最终回复
      ├── Turn 2 ...
      └── AgentRun（子运行，多 Agent 时才出现）
```

**关键点**：运行引用的是 Agent 定义的**某个具体版本**。用户之后修改 Agent 定义，不会影响已经存在的运行，历史记录始终可以解释。

---

## 3. Agent 定义

### 3.1 结构

```ts
interface AgentDefinition {
  id: string                        // 稳定 id，如 'builtin.coder'、'user.reviewer-7f3a'
  version: number                   // 每次保存递增；运行引用 id@version
  source: 'builtin' | 'user' | 'imported'

  // 展示
  name: LocalizedText               // { 'zh-CN': '编程助手', 'en-US': 'Coder' }
  description: LocalizedText
  icon?: string                     // 图标名
  color?: string                    // 设计令牌名，不是色值

  // 行为
  instructions: string              // 角色指令（追加到基础系统提示词之后）
  model: ModelSelection
  tools: ToolSelection              // 内置工具与 MCP 工具（见第 21 节）
  skills: SkillSelection            // 可用的 Skills（见第 21 节）
  permissions: PermissionPreset     // 该 Agent 的默认权限规则集
  limits: RunLimits
  context: ContextPolicy
  memory: MemoryPolicy              // 记忆范围（见第 22 节，第一版只预留）

  // 输入输出约定（可选，主要供多 Agent 委派使用）
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema

  // 多 Agent（第一版保留字段，不启用）
  delegation?: DelegationPolicy

  // 元数据
  status: 'draft' | 'published'     // 草稿不能被会话选用，只能试运行
  tags?: string[]
  createdAt: number
  updatedAt: number
  schemaVersion: 1
}

type LocalizedText = Partial<Record<'zh-CN' | 'en-US', string>>

interface ModelSelection {
  primary: ModelRef                 // { providerId, modelId }
  fallbacks?: ModelRef[]            // 主模型不可用（限流、宕机）时依次尝试
  params?: {
    temperature?: number
    maxOutputTokens?: number
    reasoningEffort?: 'low' | 'medium' | 'high'   // 仅对支持的模型生效
  }
  // 'inherit' 表示使用会话当前选择的模型，便于用户在界面上随时切换
  mode: 'fixed' | 'inherit'
  // 辅助模型：用于上下文压缩、生成标题等杂项任务，可配置为更便宜或本地的模型；不填则使用主模型
  auxiliary?: ModelRef
}

interface ToolSelection {
  allow: string[]                   // 工具名、类别或 MCP 服务，如 ['read', 'run_command', 'mcp:github']
  deny?: string[]
}

interface SkillSelection {
  allow: string[]                   // Skill id；['*'] 表示所有已启用的 Skill
  deny?: string[]
  pinned?: string[]                 // 始终完整加载的 Skill（谨慎使用，会占用上下文）
}

interface MemoryPolicy {
  scopes: Array<'session' | 'project' | 'global'>   // 可读取的范围
  write: 'never' | 'propose' | 'auto'               // 第一版固定为 'never'
}

interface RunLimits {
  maxStepsPerTurn: number           // 默认 50
  maxTurnDurationMs: number         // 默认 30 分钟
  maxTokensPerTurn?: number         // 输入 + 输出总量上限
  maxCostPerTurn?: number           // 按配置的单价估算，可选
  maxConsecutiveToolErrors: number  // 默认 5
}

interface ContextPolicy {
  includeProjectInstructions: boolean   // 是否读取 AGENTS.md
  compaction: 'auto' | 'off'
  reserveOutputTokens?: number
}
```

### 3.2 内置 Agent（第一版）

| id | 名称 | 用途 | 工具 | 默认权限 |
|---|---|---|---|---|
| `builtin.coder` | 编程助手 / Coder | 默认 Agent，读写代码、执行命令 | 全部内置工具 | 询问 |
| `builtin.explorer` | 代码探索 / Explorer | 只读：理解项目结构、回答问题 | read 类 | 只读 |

第一版只有这两个，并且用户可以在内置 Agent 的基础上"复制并修改"生成自定义 Agent。内置 Agent 本身不可修改，随应用升级更新。

### 3.3 校验规则

- `tools.allow` 中的工具必须在工具注册表中存在；不存在的工具在加载时报错并标记该定义为不可用，而不是静默忽略。
- 权限预设不能放宽系统的强制拦截规则（如危险命令、工作区外路径）。
- `instructions` 长度有上限，避免挤占上下文。
- 所有字段由 zod schema 校验，`schemaVersion` 用于以后迁移。

### 3.4 存储与导入导出

- Agent 定义保存在数据库 `agent_definitions` 表，每个版本一行（`id`, `version` 联合主键）。
- 支持导出为单个 Markdown 文件（YAML 头部存结构化字段，正文为 `instructions`），便于分享和放进版本控制；导入时按同样格式解析并校验。
- 后续可选：读取项目内 `.nexus/agents/*.md` 作为项目级 Agent（默认关闭，需用户在项目设置中开启，避免打开陌生项目时自动加载其中的指令）。

---

## 4. 运行时组件

Agent 宿主进程内的组件：

```
┌───────────────────────────── Agent 宿主进程 ─────────────────────────────┐
│                                                                          │
│   HostController ── 与主进程通信（MessagePort），握手、心跳、命令分发       │
│        │                                                                 │
│   RunSupervisor ── 管理本会话内的所有运行：创建、限额、取消、父子关系        │
│        │                                                                 │
│   RunEngine（每个运行一个）                                                │
│    ├── ContextAssembler   组装系统提示词、历史、工具定义，控制预算、压缩     │
│    ├── LoopDriver         通过 AgentRuntime 接口驱动模型循环（pi 适配器）   │
│    ├── ToolPipeline       参数校验 → 权限 → 审批 → 检查点 → 执行 → 后处理   │
│    ├── HookBus            生命周期钩子                                     │
│    └── EventOutbox        事件缓冲与发送，保证顺序                          │
│                                                                          │
│   共享服务：ToolRegistry、PermissionEngine、CheckpointService、             │
│            ShellAdapter、PathGuard、TokenEstimator、Logger                 │
└──────────────────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 | 所在包 |
|---|---|---|
| HostController | 进程入口；协议握手、心跳；把主进程命令分发给 RunSupervisor | `apps/desktop/agent-host` |
| RunSupervisor | 运行的创建与销毁；限额继承；取消信号树；子运行管理 | `core` |
| RunEngine | 单个运行的编排，持有状态机 | `core` |
| ContextAssembler | 上下文组装与压缩 | `core` |
| LoopDriver | 调用 `AgentRuntime`，把运行时事件转为本系统事件 | `core`（接口）/ `runtime-pi`（实现） |
| ToolPipeline | 工具调用的完整流程 | `core` |
| PermissionEngine | 纯函数规则判定 | `core` |
| HookBus | 钩子注册与调用 | `core` |
| EventOutbox | 事件排队发送；主进程确认前不丢弃 | `core` |

**原则**：`RunEngine` 和它的子组件只依赖接口，可以在普通 Node 环境中用 `FakeRuntime` 完整测试，不需要 Electron。

---

## 5. 运行状态机

### 5.1 状态

| 状态 | 说明 |
|---|---|
| `idle` | 已创建，等待输入 |
| `thinking` | 正在调用模型 |
| `tooling` | 正在执行工具 |
| `awaiting_approval` | 有工具调用等待用户审批 |
| `awaiting_children` | 等待子运行返回（多 Agent，第一版不会出现） |
| `completed` | 本轮已结束，回到可接受新输入的状态（实际表现为 `idle`） |
| `aborting` | 正在中止 |
| `failed` | 本轮失败（可重试） |
| `interrupted` | 进程崩溃或应用退出导致中断（可恢复） |
| `disposed` | 运行已结束，不再接受输入 |

### 5.2 状态转换

```
idle ──输入──▶ thinking
thinking ──模型请求工具──▶ tooling
thinking ──模型给出最终回复──▶ idle（发出 turn.completed）
tooling ──需要审批──▶ awaiting_approval ──批准/拒绝──▶ tooling
tooling ──全部工具完成──▶ thinking
tooling ──委派子 Agent──▶ awaiting_children ──子运行返回──▶ tooling
任意运行中状态 ──用户停止──▶ aborting ──清理完成──▶ idle（turn.aborted）
任意运行中状态 ──不可恢复错误 / 超出限额──▶ failed
任意运行中状态 ──进程退出──▶ interrupted（下次启动时由主进程标记）
idle / failed / interrupted ──用户归档或删除──▶ disposed
```

- 状态转换只能由 `RunEngine` 内部触发，每次转换都发出 `run.state.changed` 事件，界面据此显示状态。
- 非法转换（例如 `idle` 时收到工具结果）记录错误日志并忽略，不让运行进入未定义状态。

---

## 6. Agent 循环

### 6.1 单轮流程

```
开始轮次
  1. 创建轮次检查点（工作区快照）
  2. ContextAssembler 组装上下文
  3. 循环：
     a. 检查限额（步数、时长、token、成本）→ 超出则结束轮次
     b. 调用模型（流式），发出文本 / 思考增量事件
     c. 若模型返回工具调用：
          - 交给 ToolPipeline（见第 7 节）
          - 收集所有工具结果
          - 循环检测（见 6.3）
          - 回到 a
     d. 若模型返回最终回复：结束循环
  4. 发出 turn.completed，附用量统计
```

实际的"调用模型 → 解析工具调用 → 回填结果 → 再次调用"由 pi 完成，`LoopDriver` 通过 `AgentRuntime` 接口驱动它，并在 `beforeToolCall` 钩子中接入 `ToolPipeline`。上面的流程描述的是语义，不要求逐步自己实现。

### 6.2 并行工具调用

模型一次可能返回多个工具调用：

- 只读类工具（`read`）可以并行执行，最大并发可配置（默认 4）。
- 写入、执行、网络类工具按模型给出的顺序串行执行。
- 一批中只要有任何非只读工具，整批串行执行，避免读写交错导致结果不一致。
- 需要审批的工具在审批前不执行；同一批中多个需要审批的调用，在界面上合并为一组审批，用户可以逐个决定。

### 6.3 循环检测

agent 有时会反复做同一件事。检测规则：

- 连续 N 次（默认 3）以完全相同的参数调用同一工具，且结果相同 → 向模型注入一条提示："你在重复相同的操作，请换一种方法或向用户说明情况"。
- 注入后仍然重复 → 结束本轮并提示用户。
- 连续工具错误次数超过 `maxConsecutiveToolErrors` → 结束本轮。

### 6.4 最终回复的判定

模型返回不含工具调用的回复即视为本轮结束。若模型在未完成任务时就结束（例如只说"我将要做 X"），由用户继续输入推进，不做自动续写，避免难以预测的行为。

---

## 7. 工具执行流水线

每个工具调用依次经过以下阶段，每个阶段都有明确的事件和失败处理：

| 阶段 | 内容 | 失败时 |
|---|---|---|
| 1. 解析 | 找到工具定义 | 工具不存在 → 返回错误给模型 |
| 2. 参数校验 | 按 `inputSchema` 校验参数 | 参数非法 → 返回校验错误给模型，计入连续错误 |
| 3. 可用性检查 | 工具是否在当前 Agent 的 `tools.allow` 内 | 不可用 → 返回"此 Agent 无权使用该工具" |
| 4. 路径与命令规范化 | 解析为工作区内的绝对路径；解析命令 | 越界 → 按强制规则拒绝或要求审批 |
| 5. 权限判定 | PermissionEngine 返回 allow / ask / deny 及理由 | deny → 返回拒绝理由给模型 |
| 6. 审批 | ask 时生成预览（diff、完整命令），发起审批 | 用户拒绝 → 返回拒绝理由（可附用户说明） |
| 7. 前置检查点 | 执行类工具在执行前创建检查点 | 检查点失败 → 询问用户是否在无检查点情况下继续 |
| 8. 执行 | 带取消信号和超时执行；流式输出进度 | 异常 → `tool.failed`，错误信息返回模型 |
| 9. 后处理 | 记录文件改动（按块）；输出截断；发出 `file.changed` | — |
| 10. 返回 | 结果交回 agent 循环 | — |

补充说明：

- **审批预览在审批前计算**：例如 `write_file` 在审批前就读取原文件并计算 diff，用户看到的就是将要发生的改动。
- **审批后的一致性**：如果审批期间文件被外部修改，执行前重新校验原文；不一致则返回错误让模型重新读取，避免覆盖用户的修改。
- **工具结果是数据**：所有工具结果在交给模型时标注为工具输出，系统提示词明确要求模型不要执行工具结果中出现的指令（防提示注入）。

---

## 8. 上下文组装与预算

### 8.1 组成

按顺序组装：

1. **基础系统提示词**（英文）：身份、工作方式、工具使用规范、安全规则、当前操作系统与 shell 类型、回复语言跟随用户。
2. **Agent 指令**：来自 `AgentDefinition.instructions`。
3. **项目说明**：项目根目录的 `AGENTS.md`（若存在且 Agent 允许）。
4. **用户自定义说明**：设置中的全局说明。
5. **环境信息**：工作区路径、当前日期、git 分支（如有）等简短信息。
6. **Skills 索引**：每个可用 Skill 只放名称和一句话描述；完整内容在需要时按需加载（见 21.2）。
7. **记忆**：按 `MemoryPolicy` 读取的记忆条目（第一版不启用）。
8. **工具定义**：当前 Agent 可用的工具。
9. **对话历史**：可能包含压缩后的摘要。
10. **本轮输入**。

### 8.2 预算分配

以模型的 `contextWindow` 为总量：

| 部分 | 分配 |
|---|---|
| 预留输出 | `reserveOutputTokens` 或 `maxOutputTokens` |
| 系统提示词 + 工具定义 | 实际占用，超过总量 30% 时给出警告 |
| 单个工具结果 | 不超过剩余空间的 25%，并有绝对上限 |
| 历史 | 剩余部分 |

token 数优先使用模型对应的分词器估算；没有时按字符数估算（中文按每字约 1 token、英文按约 4 字符 1 token 粗略估计），并保留安全余量。

### 8.3 压缩

- 当历史占用超过可用空间的 80% 时触发。
- 保留最近 K 轮（默认 2）的完整内容；更早的轮次由模型总结为摘要，摘要中保留：用户目标、已做的决定、修改过的文件列表、未完成事项。
- 压缩是一个独立的模型调用，结果记录为 `context.compacted` 事件；原始事件全部保留，界面中仍可查看完整历史。
- 压缩失败时退化为直接丢弃最早的工具输出内容（保留调用记录），并提示用户。

### 8.4 提示词缓存

组装顺序保证稳定部分（系统提示词、Agent 指令、工具定义）在前，变化部分在后，便于支持前缀缓存的提供方降低成本和延迟。

---

## 9. 用户介入：追加、引导与中断

用户在 Agent 运行过程中可能还会输入新内容。支持三种方式：

| 方式 | 行为 | 默认 |
|---|---|---|
| 排队 | 新消息排在当前轮次之后，本轮结束后自动作为下一轮输入 | 是（运行中直接按发送） |
| 引导 | 新消息在当前步骤结束后插入上下文，Agent 在下一次模型调用时看到，不打断正在执行的工具 | 通过按钮或快捷键选择 |
| 中断 | 停止当前轮次，然后以新消息开始新的一轮 | 通过"停止并发送"选择 |

pi 提供了追加消息的机制，具体对接方式在适配器中实现；如不满足需求，由 `RunEngine` 在步骤边界自行插入。

---

## 10. 取消、超时与限额

### 10.1 取消信号树

```
会话 AbortController
 └── 运行 AbortController
      └── 轮次 AbortController
           ├── 模型请求
           └── 工具调用 AbortController（每个工具一个）
                └── 子进程（命令）
```

- 上层取消自动传播到下层；下层可以单独取消（例如只停止一个超时的命令）。
- 子运行（多 Agent）挂在父运行的轮次之下，父轮次取消时子运行一起取消。

### 10.2 取消的清理保证

- 模型请求：中止 HTTP 请求，已收到的部分文本保留并标记为不完整。
- 命令：结束整个进程树（ADR-0012）。
- 写文件：写入采用"写临时文件 + 原子替换"，取消不会留下写了一半的文件。
- 未完成的工具调用记为 `tool.cancelled`，避免下次恢复时被误认为成功。

### 10.3 限额

限额来自 Agent 定义的 `RunLimits`，用户可以在会话中临时调整。超出限额时：

- 结束本轮，发出 `turn.limit_reached`，说明是哪项限额；
- 界面提供"继续"按钮，用户确认后以更高限额继续，而不是直接失败。

---

## 11. 生命周期钩子

`HookBus` 提供内部扩展点，供内置功能和以后的扩展使用：

| 钩子 | 时机 | 可以做什么 |
|---|---|---|
| `beforeTurn` | 轮次开始 | 创建检查点、注入额外上下文 |
| `beforeModelCall` | 每次调用模型前 | 修改上下文（如压缩）、选择备用模型 |
| `afterModelCall` | 模型返回后 | 记录用量、检测异常输出 |
| `beforeToolCall` | 工具执行前 | 权限判定、审批、参数改写 |
| `afterToolCall` | 工具执行后 | 记录改动、截断输出、循环检测 |
| `afterTurn` | 轮次结束 | 生成会话标题、统计 |
| `onError` | 任何阶段出错 | 重试、降级、记录 |

规则：

- 钩子按注册顺序执行，可以返回"继续 / 修改 / 阻止"。
- 钩子执行有超时，超时视为错误并记录，不让单个钩子卡住整个运行。
- 第一版钩子只供内部代码注册；是否向用户开放（例如运行用户的脚本）在后续单独设计，因为涉及安全问题。

---

## 12. 事件

在[总体架构第 7 节](../architecture.md#7-事件模型)的基础上，所有事件增加运行维度：

```ts
interface EventEnvelope {
  v: 1
  sessionId: string
  runId: string              // 新增：事件所属的运行
  parentRunId?: string       // 新增：父运行（多 Agent）
  seq: number                // 仍为会话内单调递增
  ts: number
  turnId?: string
  stepId?: string            // 新增：所属步骤
  type: EventType
  payload: unknown
}
```

新增事件类型：

| 事件 | 说明 |
|---|---|
| `run.created` | 运行创建，含 Agent 定义 id 与版本、模型、限额 |
| `run.state.changed` | 状态转换 |
| `run.disposed` | 运行结束 |
| `step.started` / `step.completed` | 每次模型调用的边界，含模型、token、耗时 |
| `tool.cancelled` | 工具被取消 |
| `turn.limit_reached` | 超出限额 |
| `context.compacted` | 上下文已压缩，含摘要和被压缩的轮次范围 |
| `model.fallback` | 切换到备用模型 |
| `run.delegated` / `run.child.completed` | 委派子运行（多 Agent，预留） |

---

## 13. 持久化与恢复

### 13.1 持久化什么

| 内容 | 位置 |
|---|---|
| 运行元数据（Agent 定义版本、模型、限额、父运行、状态） | `agent_runs` 表 |
| 运行过程 | `events` 表（完成类事件，增量事件不落库） |
| 规范化消息历史 | 由事件推导；为加速恢复，在每轮结束时保存一份快照到 `run_snapshots` |
| 文件改动与检查点 | 见总体架构第 11 节 |

### 13.2 恢复规则

- **正常恢复**（进程被空闲回收后再次运行）：从最近的 `run_snapshots` 加上之后的事件重建 `CanonicalMessage` 历史，交给 `AgentRuntime` 继续。
- **崩溃恢复**：主进程把未完成的轮次标记为 `interrupted`；正在执行中的工具调用标记为"结果未知"。恢复时向模型注入说明："上一次操作在执行过程中被中断，结果未知，请先检查当前状态"。**不会自动重新执行**被中断的工具调用，因为命令和写文件不一定可以安全重复。
- **未决审批**：应用重启后视为取消，模型会收到"审批已取消"的结果。

---

## 14. 模型切换

- 会话中可以随时切换模型（`ModelSelection.mode = 'inherit'` 的 Agent 跟随会话设置）。
- 历史以 `CanonicalMessage` 保存，与具体提供方无关，因此可以跨提供方继续对话。
- 切换时的处理：
  - 推理内容（思考过程）只保留在原提供方的上下文中，切换到其他提供方时不发送，界面中仍显示。
  - 如新模型上下文更小，切换前检查预算，必要时先压缩。
  - 新模型不支持工具调用时，提示用户并禁止切换（或只允许纯对话）。
- 备用模型：主模型请求失败且重试耗尽时，依次尝试 `fallbacks`，并发出 `model.fallback` 事件告知用户。

---

## 15. 用量统计

- 每次模型调用记录输入 token、输出 token、缓存命中 token（如提供方返回）、耗时。
- 提供方配置可填写单价，用于估算费用；未配置则只显示 token 数。本地模型（Ollama）费用为 0，只显示 token 和耗时。
- 汇总维度：步骤、轮次、运行、会话、项目、按天。
- 可选的成本上限（`maxCostPerTurn`）达到时按限额处理（见 10.3）。

---

## 16. 为多 Agent 预留的委派原语

多 Agent 协作的具体模式在单独的文档中设计，但以下底层能力必须现在就纳入 Runtime，否则以后要改事件、存储和状态机：

1. **父子运行**：运行有 `parentRunId`；事件带 `runId` 与 `parentRunId`（已在第 12 节加入）。
2. **委派工具**：委派以一个特殊工具 `delegate` 的形式提供，参数为目标 Agent 定义、任务描述、期望输出格式。这样委派也经过工具流水线，自然获得权限判定、审批和事件记录。
3. **状态**：父运行在等待子运行时处于 `awaiting_children`（已在第 5 节加入）。
4. **限额继承**：子运行的限额不超过父运行剩余的限额；子运行消耗的 token 和成本计入父运行。
5. **权限收敛**：子运行的有效权限为"子 Agent 定义的权限"与"父运行当前权限"的交集，子 Agent 不能获得比父运行更多的权限。
6. **取消传播**：子运行挂在父运行的取消信号树下（见 10.1）。
7. **结果返回**：子运行结束时产出结构化结果（摘要、改动文件列表、状态），作为 `delegate` 工具的返回值交给父运行，而不是把子运行的完整对话塞进父运行的上下文。
8. **深度与数量上限**：委派深度和同时运行的子运行数量有上限，防止无限递归。

第一版：以上字段、状态和接口全部定义，`delegate` 工具不注册，`DelegationPolicy` 不启用。

---

## 17. 接口定义

以下接口位于 `packages/core`，替代总体架构第 6 节的草案。

```ts
// ---------- 运行管理 ----------
interface RunSupervisor {
  createRun(init: CreateRunInput): Promise<AgentRunHandle>
  getRun(runId: string): AgentRunHandle | undefined
  abortAll(reason: string): Promise<void>
}

interface CreateRunInput {
  sessionId: string
  agent: AgentDefinitionRef               // { id, version }
  workspace: WorkspaceInfo
  parentRunId?: string
  mode: 'interactive' | 'unattended'      // 见第 23 节
  limitsOverride?: Partial<RunLimits>
  restoreFrom?: RunRestoreData            // 恢复时提供
}

interface AgentRunHandle {
  readonly runId: string
  readonly state: RunState
  send(input: RunInput, mode?: 'queue' | 'steer' | 'interrupt'): Promise<void>
  abort(reason?: string): Promise<void>
  resolveApproval(approvalId: string, decision: ApprovalDecision): void
  updateLimits(limits: Partial<RunLimits>): void
  onEvent(listener: (e: RunEvent) => void): Unsubscribe
  dispose(): Promise<void>
}

// ---------- 底层运行时（pi 适配器实现） ----------
interface AgentRuntime {
  readonly id: string
  createSession(init: RuntimeSessionInit): Promise<RuntimeSession>
}

interface RuntimeSessionInit {
  model: ResolvedModel
  systemPrompt: string
  tools: RuntimeToolSpec[]                // 名称、说明、参数 schema
  history: CanonicalMessage[]
  signal: AbortSignal
  hooks: {
    beforeToolCall(call: RuntimeToolCall): Promise<RuntimeToolGate>
    executeTool(call: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolResult>
    beforeModelCall?(ctx: ModelCallContext): Promise<ModelCallContext>
  }
}

interface RuntimeSession {
  prompt(input: CanonicalMessage): Promise<void>
  steer(input: CanonicalMessage): Promise<void>
  abort(reason?: string): Promise<void>
  onEvent(listener: (e: RuntimeEvent) => void): Unsubscribe
  exportHistory(): CanonicalMessage[]
  dispose(): Promise<void>
}

// ---------- 规范化消息（持久化格式，与 pi 无关） ----------
type CanonicalMessage =
  | { role: 'user'; content: ContentPart[]; ts: number }
  | { role: 'assistant'; content: ContentPart[]; reasoning?: ReasoningPart;
      toolCalls?: CanonicalToolCall[]; model: ModelRef; ts: number }
  | { role: 'tool'; toolCallId: string; content: ContentPart[];
      status: 'ok' | 'error' | 'denied' | 'cancelled' | 'unknown'; ts: number }
  | { role: 'summary'; content: string; coversTurns: [string, string]; ts: number }

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; blobRef: string; mimeType: string }   // 预留
```

说明：

- 工具的执行由我们自己的 `ToolPipeline` 完成，pi 只负责循环和模型通信。适配器把 pi 的工具执行回调接到 `hooks.executeTool` 上。
- `ReasoningPart` 记录提供方信息，用于模型切换时决定是否发送（见第 14 节）。

---

## 18. 测试

| 测试 | 方式 |
|---|---|
| 状态机 | 对所有合法和非法转换编写单元测试 |
| 工具流水线 | 每个阶段的成功与失败分支；审批期间文件被修改的情况 |
| 并行工具调用 | 只读并行、混合串行、部分审批被拒 |
| 循环检测 | 构造重复调用场景 |
| 取消 | 在模型调用中、工具执行中、审批等待中分别取消，验证清理结果 |
| 上下文预算与压缩 | 用小上下文模型配置触发压缩 |
| 恢复 | 模拟崩溃后从快照与事件恢复；验证不会重复执行被中断的工具 |
| 适配器契约 | 用录制的模型响应驱动 pi 适配器，比对输出事件序列（黄金文件） |
| 端到端 | `FakeRuntime` 脚本化场景，覆盖完整的界面流程 |

---

## 19. 对总体架构的影响

以下改动已同步到总体架构文档：

1. 事件信封增加 `runId`、`parentRunId`、`stepId`（第 7 节）。
2. 数据库新增表：`agent_definitions`、`agent_runs`、`run_snapshots`；`events` 表增加 `run_id` 列和索引（第 14 节）。
3. 第 6 节的接口草案由本文档第 17 节替代。
4. 新增 ADR-0016：Agent 定义与运行作为一等概念。

这些都属于"难改的部分"，因此在开发开始前确定。

---

## 20. 已确认事项

1. 第一版内置"编程助手"和"代码探索"两个 Agent。
2. 默认限额：每轮最多 50 步、30 分钟。
3. 运行中发送消息默认"排队"，另提供"引导"和"中断"。
4. 项目级 Agent（`.nexus/agents/*.md`）默认关闭，需在项目设置中手动开启。
5. 崩溃后不自动重试被中断的工具调用，由模型先检查当前状态。

后续在实际使用中根据反馈调整。

---

## 21. 能力层：Tools、Skills 与 MCP

详见 ADR-0017。

### 21.1 三类能力的边界

| 概念 | 回答的问题 | 本质 | 是否可执行 |
|---|---|---|---|
| Tool | 如何执行一个具体操作 | 带参数 schema 的函数 | 是 |
| Skill | 如何完成某一类任务 | 说明、流程、示例、参考资料，可附带脚本 | 否（附带的脚本通过工具执行） |
| MCP | 如何以标准方式接入外部能力 | 连接协议；MCP 服务暴露的工具适配后进入工具注册表 | 通过适配后的工具执行 |

原则：**模型只看到一种可执行的东西——工具**。MCP 工具和 Skill 附带的脚本最终都以工具的形式出现，统一经过工具流水线（第 7 节）的权限判定、审批和事件记录。

### 21.2 Skills

- **格式**：一个文件夹，包含 `SKILL.md`（YAML 头部写 `name`、`description`，正文写说明）以及可选的参考资料、模板和脚本。兼容社区通用的 `SKILL.md` 约定，以便复用现有 Skill。
- **来源**：内置、用户安装（应用数据目录）、项目内（`.agents/skills/` 或 `.nexus/skills/`，与项目级 Agent 一样默认关闭，需手动开启）。
- **按需加载**：上下文中只放 Skill 索引（名称 + 一句话描述）。模型判断需要时调用内置工具 `load_skill`，获得完整说明；参考资料再通过 `read_file` 按需读取。这样即使安装了很多 Skill，常驻上下文的开销也很小，对上下文较小的本地模型尤其重要。
- **固定加载**：`SkillSelection.pinned` 中的 Skill 在每轮开始时完整注入，适合必须始终遵守的规范。
- **版本**：Skill 元数据记录来源、版本或内容哈希；运行事件中记录本轮实际加载的 Skill 及其版本，便于追溯。
- **安全**：Skill 是会进入上下文的文本，与项目文件同样视为不可信输入。Skill 附带的脚本只能通过 `run_command` 执行，照常审批。

### 21.3 MCP

- **连接管理**：MCP 服务的启动、连接、断线重连、超时、退出由主进程中的 MCP 管理器负责（stdio 类服务作为子进程启动），状态通过事件通知界面。
- **工具适配**：MCP 服务的工具被适配为 `ToolDefinition`，名称加上服务前缀（如 `github.create_issue`），注册进工具注册表。
- **工具元数据**：`ToolDefinition` 增加字段：

```ts
interface ToolDefinition {
  // ……原有字段
  source: { kind: 'builtin' } | { kind: 'mcp'; serverId: string } | { kind: 'skill'; skillId: string }
  trust: 'builtin' | 'user-configured' | 'third-party'
}
```

- **默认权限**：来自 MCP 的工具默认 `ask`，用户可以按服务或按工具放宽；MCP 工具的类别由用户配置或按名称推断，推断不出时按最严格的 `network` 处理。
- **凭据**：MCP 服务需要的令牌同样经过凭据服务（ADR-0010）管理，不写入明文配置。

---

## 22. 记忆（预留）

详见 ADR-0019。第一版不实现记忆功能，只预留数据模型，避免以后修改 Agent 定义和上下文组装。

- **范围**：会话（只在当前会话内）、项目（同一项目的所有会话）、全局（所有项目）。不同范围严格隔离，Agent 只能读取 `MemoryPolicy.scopes` 中声明的范围。
- **写入方式**：`never`（不写）、`propose`（Agent 提出，用户确认后写入）、`auto`（自动写入）。默认 `never`，以后开放时默认 `propose`。
- **可控**：所有记忆条目对用户可见、可编辑、可删除，并标注来源（哪次运行、哪个 Agent 写入）。
- **与 `AGENTS.md` 的关系**：`AGENTS.md` 是用户维护的项目说明，属于上下文的固定部分；记忆是运行中积累的内容，两者分开管理。

---

## 23. 交互运行与无人值守运行

详见 ADR-0018。

为以后的定时任务、事件触发等自动化场景，运行从一开始就区分两种模式：

| | 交互运行 `interactive` | 无人值守运行 `unattended` |
|---|---|---|
| 触发方式 | 用户在界面中发起 | 定时、事件、其他程序触发（以后实现） |
| `ask` 类权限 | 弹出审批 | 不能弹出审批，按策略处理（见下） |
| 运行中插话 | 支持 | 不支持 |
| 结果通知 | 界面实时显示 | 完成后系统通知 + 任务记录 |

无人值守运行遇到 `ask` 时的策略（在任务配置中选择）：

- `deny`（默认）：视为拒绝，告知模型并继续。
- `pause`：暂停运行，保存状态，在用户下次打开应用时提示审批，批准后继续。

此外，无人值守运行使用更严格的默认限额，并且强制拦截类规则（危险命令等）一律直接拒绝。第一版所有运行都是 `interactive`，但字段、状态和权限判定逻辑按两种模式实现。

---

## 24. 脱离界面运行

`RunSupervisor`、`RunEngine` 及其依赖只依赖接口，可以在普通 Node 环境中运行（第 4 节）。因此以后可以在不改动 Runtime 的前提下提供：

- 命令行版本（在终端中运行 Agent）；
- 后台服务（供自动化任务使用）；
- 作为库被其他程序嵌入。

为保证这一点，Runtime 相关包禁止引用 Electron API，由 CI 中的依赖边界规则检查。
