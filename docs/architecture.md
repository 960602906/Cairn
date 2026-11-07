# Cairn 架构设计

> 状态：设计定稿（v1.0），下一步进入 M0 基础阶段。实际使用中根据反馈持续调整。
> 作者：960602906
> 关键决策的背景、备选方案和取舍理由记录在 [`docs/adr/`](adr/README.md)，本文档描述整体架构，引用处标注为「ADR-xxxx」。

## 目录

1. [项目概述](#1-项目概述)
2. [设计原则](#2-设计原则)
3. [总体架构](#3-总体架构)
4. [进程模型](#4-进程模型)
5. [模块划分](#5-模块划分)
6. [Agent 运行时抽象](#6-agent-运行时抽象)
7. [事件模型](#7-事件模型)
8. [核心流程](#8-核心流程)
9. [工具系统](#9-工具系统)
10. [权限与审批](#10-权限与审批)
11. [检查点与撤销](#11-检查点与撤销)
12. [模型接入](#12-模型接入)
13. [上下文管理](#13-上下文管理)
14. [数据存储](#14-数据存储)
15. [进程间通信协议](#15-进程间通信协议)
16. [配置与凭据](#16-配置与凭据)
17. [安全设计](#17-安全设计)
18. [平台策略](#18-平台策略)
19. [国际化](#19-国际化)
20. [可观测性与诊断](#20-可观测性与诊断)
21. [错误处理与恢复](#21-错误处理与恢复)
22. [性能](#22-性能)
23. [测试策略](#23-测试策略)
24. [构建、发布与更新](#24-构建发布与更新)
25. [仓库结构](#25-仓库结构)
26. [里程碑](#26-里程碑)
27. [风险与待验证事项](#27-风险与待验证事项)

---

## 1. 项目概述

### 1.1 定位

Cairn 是一个类似 Codex 的**编程类桌面 agent 应用**。用户选择本地项目目录，用自然语言描述任务，agent 自主读代码、改代码、执行命令；每一步过程和文件改动都可视化展示，敏感操作需要用户审批，所有改动都可以回退。

技术上，Cairn = **自研 Agent 平台** + **可插拔的 Agent 引擎**（首选 pi，ADR-0023）：

- **平台层**（自研）：运行编排与上下文、工具注册表与工具流水线、权限与审批、检查点与改动记录、事件日志与存储、凭据、界面、多 Agent 协作。
- **引擎层**（可替换）：只负责 agent 循环（调用模型 → 解析工具调用 → 回填结果）与模型通信，经 `AgentRuntime` 接口接入；工具执行经钩子交回平台。更换引擎不影响权限、审计与存储。

### 1.2 产品定位策略

**编程优先，架构可扩展。** 第一版只做编程场景，把它做深；但能力层（Tools、Skills、MCP）、运行模式（交互与无人值守）、记忆范围等底层设计不局限于编程，以后可以扩展为更通用的个人 AI 工作平台，而不需要重构。

### 1.3 核心诉求

- **多模型**：可接入各种格式的 LLM，用户自带 key 和 baseUrl。
- **可控**：agent 的每个操作都看得见，写文件和执行命令前可以拦截确认。
- **可审阅**：所有文件改动以 diff 展示，可接受或撤销。
- **可回退**：任意时刻可以把项目恢复到某一步之前的状态。

### 1.4 已确认决策

| 事项 | 结论 |
|---|---|
| 项目名称 | Cairn |
| 首发平台 | Windows；后续支持 macOS 和 Linux |
| 首批模型 | Anthropic、OpenAI、Gemini 三种协议格式；DeepSeek 等兼容服务走 OpenAI 格式（ADR-0021） |
| 命令执行 | 第一版即开放，默认每条命令需审批 |
| Windows 默认 Shell | PowerShell 5.1；检测到 PowerShell 7 时优先使用 |
| 界面语言 | 中英双语 |
| API Key | 第一版仅支持用户自带 key，凭据层按可扩展接口设计 |
| 会话存储 | SQLite，自定义数据结构，带版本迁移，不绑定 pi 的格式 |
| diff | 数据按块（hunk）存储；第一版界面提供整文件接受/撤销 |
| 开源 | 暂时私有，后续开源；依赖只用宽松许可证 |
| 产品定位 | 编程优先，架构可扩展为通用平台 |
| 技术定位 | 自研 Agent 平台 + 可插拔 Agent 引擎，首选 pi（ADR-0023） |
| 能力层 | Tools、Skills、MCP 统一进入工具注册表（ADR-0017） |
| 运行模式 | 区分交互与无人值守，第一版只开放交互（ADR-0018） |
| 记忆 | 预留会话、项目、全局三级范围，功能暂缓（ADR-0019） |

### 1.5 非目标（第一版不做）

- 云端运行、多人协作、账号体系、计费。
- 通用办公类任务，只聚焦编程（架构上不限制以后扩展）。
- 插件市场（但保留 Skills、MCP 和工具注册的扩展点）。
- 定时与事件触发的自动化任务（运行模式已预留）。
- 记忆功能（数据模型已预留）。
- 向量检索与重排（RAG）；代码搜索先使用 ripgrep。
- 交互式命令（需要用户在终端里输入的命令）。

---

## 2. 设计原则

1. **难改的部分一开始就设计好，容易改的部分保持简单。**
   难改：数据格式、进程模型、模块接口、权限模型、事件协议。容易改：界面样式、组件选型、交互细节。
2. **依赖倒置，隔离第三方。** 业务代码只依赖自己定义的接口，pi、SQLite 引擎、Shell 等都是可替换的实现（ADR-0004）。
3. **单一事实来源。** 会话状态以追加式事件日志为准，界面状态是日志的投影（ADR-0005）。
4. **按多会话设计，先实现单会话。** 数据和进程模型从第一天起支持并行，功能上逐步开放。
5. **默认安全。** 默认需要审批、默认不外泄密钥、默认可回退。
6. **一切持久化格式都有版本号。** 数据库、配置、IPC 协议都可迁移、可协商。
7. **跨平台从第一行代码开始。** 首发 Windows，但不写只能在 Windows 上跑的抽象。

---

## 3. 总体架构

```
┌───────────────────────────────────────────────────────────────┐
│ 渲染进程（React）                                               │
│  对话 │ 改动/Diff │ 终端输出 │ 设置 │ 视图状态（Zustand，事件投影）│
└──────────────────────────────┬────────────────────────────────┘
                               │ 预加载脚本（contextBridge，类型化 API）
┌──────────────────────────────▼────────────────────────────────┐
│ 主进程（Electron Main）—— 调度与网关，不跑 agent 逻辑            │
│  窗口与菜单 │ IPC 网关 │ 会话管理器 │ 存储服务（SQLite，唯一写入方）│
│  配置服务 │ 凭据服务（safeStorage）│ 日志 │ 更新                   │
└───────┬─────────────────────────────────────────┬─────────────┘
        │ MessagePort（类型化协议）                 │
┌───────▼──────────────────┐        ┌─────────────▼────────────┐
│ Agent 宿主进程（会话 A）    │  ...   │ Agent 宿主进程（会话 B）   │
│  AgentRuntime（pi 适配器） │        │  （utilityProcess）        │
│  工具执行 │ 权限引擎        │        │                          │
│  检查点 │ 上下文管理        │        │                          │
└───┬──────────┬─────────┬──┘        └──────────────────────────┘
    │          │         │
 模型提供方   项目/工作区   Shell 子进程
 （pi-ai）   （路径白名单） （PowerShell / cmd）
```

三条关键边界：

- **界面 ↔ 主进程**：界面没有任何 Node 能力，只能调用预加载脚本暴露的类型化 API。
- **主进程 ↔ Agent 宿主**：每个会话一个独立进程，崩溃或卡死不影响窗口和其他会话（ADR-0003）。
- **业务代码 ↔ pi**：只有 `runtime-pi` 包允许引用 pi，其他代码通过 `AgentRuntime` 接口使用（ADR-0004）。

---

## 4. 进程模型

详见 ADR-0003。

| 进程 | 数量 | 职责 | 不做什么 |
|---|---|---|---|
| 主进程 | 1 | 窗口、菜单、IPC 网关、会话调度、存储写入、配置、凭据、日志、更新 | 不运行 agent 循环、不执行工具 |
| 渲染进程 | 1（每窗口） | 界面展示与交互 | 不访问文件系统、网络、密钥 |
| Agent 宿主 | 每个运行中会话 1 个 | agent 循环、工具执行、权限判断、检查点、上下文管理 | 不直接写数据库、不持有其他会话的数据 |
| Shell 子进程 | 按需 | 执行命令 | 不继承敏感环境变量 |

### 4.1 生命周期

- 会话开始运行时，会话管理器用 `utilityProcess.fork()` 创建 Agent 宿主，通过 MessagePort 建立通道，完成协议版本握手。
- 会话空闲超过一段时间（可配置）后回收进程；再次运行时重新创建，并从事件日志恢复上下文。
- 宿主崩溃时，主进程记录 `session.crashed` 事件，界面提示用户，可从最后一个完整事件处恢复。
- 设置并发上限（默认 3 个运行中的会话），超出时排队。

### 4.2 为什么存储放在主进程

数据库只有主进程一个写入方，避免多进程并发写入带来的锁竞争和一致性问题。Agent 宿主产生的事件发给主进程，由主进程按顺序落库后再转发给界面。主进程中的写入均为小批量追加，并开启 WAL 模式；耗时的查询（如全文搜索）后续放到专门的工作进程。

---

## 5. 模块划分

采用 pnpm workspace 的 monorepo（ADR-0015），依赖方向自上而下，禁止反向引用：

```
apps/desktop            Electron 应用（main / preload / renderer / agent-host 入口）
  │
  ├─ packages/ui         界面组件、设计令牌
  ├─ packages/i18n       文案资源与工具函数
  │
  ├─ packages/runtime-pi pi 适配器（唯一可引用 pi 的包）
  ├─ packages/tools      内置工具实现
  ├─ packages/skills     Skill 解析、索引与按需加载
  ├─ packages/mcp        MCP 客户端、连接管理与工具适配
  ├─ packages/shell      Shell 适配器（PowerShell / cmd / bash / zsh）
  ├─ packages/checkpoint 检查点实现
  ├─ packages/storage    存储接口与 SQLite 实现、迁移脚本
  │
  ├─ packages/core       领域类型、AgentRuntime 接口、权限引擎、路径校验
  └─ packages/protocol   IPC 协议与事件定义（zod schema + TS 类型）
```

- `protocol` 和 `core` 不依赖任何 Electron、Node 特有 API 以外的第三方运行时，可以独立做单元测试。
- 用 ESLint 的依赖边界规则在 CI 中强制约束，例如禁止 `packages/tools` 引用 `@earendil-works/*`。

### 5.1 与逻辑分层的对应

以下六层是逻辑视图，用于理解职责划分，不按层拆分包：

| 逻辑层 | 职责 | 对应的包 / 模块 |
|---|---|---|
| 应用交互层 | 界面、可视化 | `apps/desktop/renderer`、`packages/ui`、`packages/i18n` |
| 任务编排层 | 多 Agent 委派、以后的工作流与调度 | `packages/core`（RunSupervisor、委派原语） |
| Agent 运行层 | Agent 循环、上下文、状态、工具流水线 | `packages/core`（RunEngine 等）、`packages/runtime-pi` |
| 能力层 | Tools、Skills、MCP | `packages/tools`、`packages/skills`、`packages/mcp`、`packages/shell` |
| 模型层 | 模型接入、能力描述、备用与辅助模型 | `packages/runtime-pi`（经 pi-ai）、`packages/core`（ModelProfile） |
| 基础设施层 | 存储、检查点、日志、IPC | `packages/storage`、`packages/checkpoint`、`packages/protocol`、主进程服务 |

权限、安全、可观测性、配置是横切关注点，分别由 `core` 的权限引擎、主进程的凭据与日志服务、`protocol` 中的事件与 trace 字段承担。

---

## 6. Agent 运行时抽象

详见 ADR-0004、ADR-0016 和 [Agent Runtime 详细设计](design/agent-runtime.md)。

- **Agent 定义**（AgentDefinition）：可保存、可版本化的 Agent 模板（指令、模型、工具、权限、限额、上下文策略）。内置 Agent 与用户 Agent 结构相同。
- **运行**（AgentRun）：某个 Agent 定义的某个版本在会话中的执行实例；会话可包含多个运行，运行之间可以有父子关系。
- Agent 宿主内由 `RunSupervisor` 管理运行，每个运行由 `RunEngine` 编排：上下文组装、模型循环、工具流水线、钩子、事件输出。
- 底层 `AgentRuntime` 接口是平台与引擎之间唯一的边界（ADR-0023）。引擎只负责模型循环与模型通信，首选 pi 适配器（`packages/runtime-pi`），测试与界面开发用 `FakeRuntime`；工具执行由我们自己的工具流水线完成。
- 完整接口见详细设计第 17 节。

---

## 7. 事件模型

详见 ADR-0005。所有会话活动都表示为事件，追加写入事件日志。

### 7.1 事件信封

```ts
interface EventEnvelope<T extends EventType = EventType> {
  v: 1                     // 事件 schema 版本
  sessionId: string
  runId: string            // 所属运行
  parentRunId?: string     // 父运行（多 Agent）
  seq: number              // 会话内单调递增，由主进程分配
  ts: number               // 毫秒时间戳
  turnId?: string          // 一次用户提问到 agent 结束为一轮
  stepId?: string          // 一次模型调用及其工具调用为一步
  type: T
  payload: EventPayload[T]
}
```

### 7.2 事件类型

| 分类 | 事件 | 说明 |
|---|---|---|
| 会话 | `session.created` `session.renamed` `session.crashed` `session.archived` | 生命周期 |
| 运行 | `run.created` `run.state.changed` `run.disposed` `run.delegated` `run.child.completed` | 运行生命周期与委派 |
| 步骤 | `step.started` `step.completed` | 每次模型调用的边界 |
| 轮次 | `turn.started` `turn.completed` `turn.aborted` `turn.failed` | 一次任务的边界 |
| 消息 | `message.user` `message.assistant.delta` `message.assistant.completed` `message.reasoning.delta` | 文本流；delta 不落库，只落 completed |
| 工具 | `tool.requested` `tool.started` `tool.output.delta` `tool.completed` `tool.failed` | 工具调用全过程 |
| 审批 | `approval.requested` `approval.resolved` | 含决策来源（用户或规则） |
| 改动 | `file.changed` | 引用改动记录 id，不内嵌文件内容 |
| 检查点 | `checkpoint.created` `checkpoint.restored` | |
| 用量 | `usage.reported` | token 数、耗时 |
| 其他 | `turn.limit_reached` `context.compacted` `model.fallback` `model.retry` `tool.cancelled` | 详见 Agent Runtime 设计第 12 节 |

### 7.3 规则

- **落库粒度**：增量事件（`*.delta`）只用于实时显示，不写数据库；对应的完成事件写入完整内容，避免数据库膨胀。
- **断线恢复**：界面重载后携带最后的 `seq` 订阅，主进程从数据库补发缺失事件，再继续推送实时事件。
- **投影**：界面的消息列表、会话状态由事件归约（reduce）得出，归约函数放在 `core`，界面和测试共用。
- **兼容**：新增事件类型或字段只能向后兼容地追加；不兼容变化需要提升 `v` 并提供迁移。

---

## 8. 核心流程

### 8.1 执行一次任务

```
用户输入
  → 渲染进程 session.prompt
  → 主进程：落库 message.user，确保 Agent 宿主在运行
  → 宿主：创建检查点（轮次起点），调用 RuntimeSession.prompt
  → 模型流式返回 → 宿主发出事件 → 主进程分配 seq、落库、转发界面
  → 模型请求工具 → beforeToolCall → 权限引擎判定（见第 10 节）
      ├ allow → 执行工具
      ├ deny  → 返回拒绝原因给模型
      └ ask   → approval.requested → 界面 → 用户决定 → approval.resolved
  → 工具结果回到 agent 循环，进入下一轮推理
  → 模型给出最终回复 → turn.completed
```

### 8.2 停止

用户点击停止 → 主进程发送 `abort` → 宿主中止模型请求、结束正在运行的命令进程树 → 发出 `turn.aborted`。未完成的工具调用标记为已取消。

### 8.3 回退

见第 11 节。

### 8.4 恢复

应用重启或宿主被回收后，再次运行会话时，宿主从事件日志重建 `CanonicalMessage` 历史，交给 `AgentRuntime` 继续对话。

---

## 9. 工具系统

### 9.1 工具注册表

工具以统一结构注册，与 pi 无关：

```ts
interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  description: string                   // 给模型看的说明（英文，模型理解更稳定）
  inputSchema: JsonSchema               // 参数定义
  category: 'read' | 'write' | 'execute' | 'network' | 'delegate'
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolProgress> | Promise<O>
  describeForApproval?(input: I, ctx: ToolContext): Promise<ApprovalPreview>
}
```

`ToolContext` 提供工作区根目录、路径校验函数、检查点接口、取消信号、日志等，工具不能绕过它直接访问外部资源。

### 9.2 第一版工具

| 工具 | 类别 | 说明 |
|---|---|---|
| `read_file` | read | 支持按行范围读取，大文件自动分段 |
| `list_dir` | read | 尊重 `.gitignore`，限制深度和数量 |
| `search` | read | 基于随应用打包的 ripgrep |
| `write_file` | write | 新建或覆盖，审批时附 diff 预览 |
| `edit_file` | write | 基于原文片段的精确替换，失败时返回明确原因 |
| `run_command` | execute | 见 9.3 |

预留但第一版不实现：后台进程管理（如启动开发服务器）、git 专用工具、网页抓取、MCP 工具。工具接口和类别已为它们留出位置。

### 9.3 命令执行

详见 ADR-0012。

- 通过 `packages/shell` 的 Shell 适配器执行，工作目录固定为工作区根目录。
- Windows 默认 PowerShell 5.1，检测到 PowerShell 7（`pwsh.exe`）时优先使用；可在设置中切换为 cmd。
- PowerShell 以 `-NoProfile -NonInteractive` 启动，命令通过 `-EncodedCommand` 传入以避免转义问题，并在前置脚本中把输出编码设为 UTF-8，防止中文乱码。
- 默认超时 120 秒（可配置），超时后结束整个进程树（Windows 使用 Job Object 或 `taskkill /T`）。
- 输出流式推送到终端面板；返回给模型时保留开头和结尾，中间截断，并注明截断位置。
- 子进程环境变量经过清洗，移除 API Key 和应用内部变量。
- 不支持需要交互输入的命令；如检测到长时间无输出，提示用户可能在等待输入。

### 9.4 工具输出预算

每个工具的返回结果有长度上限，上限根据当前模型的上下文窗口动态计算（见第 13 节）。被截断的内容可以通过再次调用工具分段获取。

---

## 10. 权限与审批

详见 ADR-0007。

### 10.1 规则模型

```ts
interface PermissionRule {
  id: string
  scope: 'global' | 'project' | 'session'
  effect: 'allow' | 'ask' | 'deny'
  match: {
    tool?: string | string[]           // 工具名
    category?: ToolCategory[]          // 工具类别
    path?: string[]                    // glob，相对工作区，如 "src/**"、"**/.env*"
    command?: string[]                 // 命令匹配模式，如 "npm test"、"git status*"
  }
  source: 'preset' | 'user' | 'approval' // 来自预设、用户手动配置、或审批时勾选"始终允许"
}
```

### 10.2 判定顺序

1. **强制拦截**：危险命令、项目目录外的路径、敏感文件（如 `.env`、私钥），无论规则如何都至少为 `ask`，部分直接 `deny`。
2. 收集所有匹配的规则，按 `deny > ask > allow` 取最严格的结果。
3. 范围优先级 `session > project > global` 只用于同等效果时的展示与管理，不允许低范围的 `allow` 覆盖高范围的 `deny`。
4. 无规则匹配时，按工具类别的默认值：read 放行，write、execute、network 询问。

### 10.3 预设

"只读""询问""自动"三种模式只是三组预设规则，切换模式即替换预设规则集，用户自定义规则保留。“询问”模式的预设为空，即按类别默认值，这样审批时“始终允许”生成的 `allow` 规则才能生效。

### 10.4 审批交互

- 审批请求包含：工具名、参数、预览（diff 或完整命令）、匹配到的规则、判定理由。
- 用户可选：允许一次、本会话始终允许、本项目始终允许、拒绝（可附说明反馈给模型）。
- 等待审批时 agent 暂停，会话状态为 `waiting_approval`；应用重启后未决审批视为取消。

### 10.5 局限说明

危险命令识别基于模式匹配，可以被刻意绕过（例如通过脚本间接执行）。它是防误操作的安全网，不是安全边界；真正的隔离要靠后续的沙箱（第 17 节）。

---

## 11. 检查点与撤销

详见 ADR-0008。

### 11.1 两层机制

| 层 | 粒度 | 实现 | 用途 |
|---|---|---|---|
| 改动记录 | 文件和块 | 写文件类工具执行前后计算 diff，按块存入数据库；文件内容存入内容寻址的 blob 存储 | diff 展示、整文件或按块撤销 |
| 检查点 | 整个工作区 | 应用数据目录中的影子 Git 仓库（`--git-dir` 指向应用目录，`--work-tree` 指向项目），不触碰用户自己的 `.git` | 回退到任意轮次或命令之前，覆盖命令造成的任意改动 |

### 11.2 何时创建检查点

- 每轮任务开始时。
- 每次执行 `run_command` 之前（命令可能修改任何文件）。
- 写文件类工具不单独创建检查点，依靠改动记录即可精确撤销。

### 11.3 回退

- 用户选择某个检查点 → 预览将被恢复的文件列表 → 确认后恢复工作区，并写入 `checkpoint.restored` 事件。
- 可选择是否同时截断对话到该位置（即从那一步重新开始）。
- 恢复前自动再创建一个检查点，保证回退本身也可撤销。

### 11.4 约束

- 影子仓库遵循项目的 `.gitignore`，并额外排除 `node_modules` 等大目录；超大文件跳过并在界面提示。
- 检查点按会话保留，提供清理策略（如保留最近 N 天或总大小上限）。
- 大型仓库上的快照性能需要在 M0 预研中验证（第 27 节）。

---

## 12. 模型接入

详见 ADR-0011、ADR-0021。

### 12.1 抽象

```ts
interface ProviderConfig {
  id: string
  kind: 'openai' | 'anthropic' | 'gemini'  // 接口格式（ADR-0021），每种都可自定义 baseUrl
  displayName: string
  baseUrl: string
  credentialRef?: string          // 指向凭据服务中的条目，不保存明文
  models: ModelProfile[]
}

interface ModelProfile {
  id: string                      // 提供方的模型名
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsParallelToolCalls: boolean
  supportsReasoning: boolean
  verifiedAt?: number             // 最近一次能力探测时间
}
```

### 12.2 首批提供方

| 提供方 | 接入方式 | 注意事项 |
|---|---|---|
| DeepSeek | OpenAI 兼容接口，用户填写 API Key | 需验证推理类模型的思考内容字段和工具调用在 pi-ai 下的兼容性 |
| Anthropic | `anthropic` 格式，用户填写 API Key | 推理内容与缓存用量按 Anthropic 格式转换 |
| OpenAI | `openai` 格式，用户填写 API Key | |
| Google Gemini | `gemini` 格式，用户填写 API Key | 推理内容按 Gemini 格式转换 |

三种格式都可以修改 `baseUrl`，用于兼容服务或代理（ADR-0021）。

具体 baseUrl 和模型名以各自官方文档为准。

### 12.3 能力探测

- 设置页提供"测试连接"：检查连通性、发送一次带工具定义的请求，验证模型能否返回合法的工具调用。
- 探测结果写入 `ModelProfile`；不支持工具调用的模型在选择时给出明确提示，并只能用于纯对话。

---

## 13. 上下文管理

- **预算**：按 `ModelProfile.contextWindow` 为系统提示词、历史、工具结果和输出预留空间。
- **系统提示词分层**：内置基础提示词 + 项目说明（读取项目根目录的 `AGENTS.md`，如存在）+ 用户在设置中的自定义说明。
- **工具结果截断**：见 9.4。
- **压缩**：历史接近上限时，把较早的轮次总结为摘要，原始事件仍保留在日志中，只是不再全部发送给模型。压缩本身记录为事件，便于追溯。
- **回复语言**：提示词要求模型使用用户提问的语言回复。
- **需求澄清**：基础提示词要求模型在需求不清楚时先提问，不要猜测。

---

## 14. 数据存储

详见 ADR-0006。

### 14.1 存放位置

| 内容 | 位置（Windows） |
|---|---|
| 数据库 | `%APPDATA%\Cairn\data\cairn.db` |
| blob（文件内容快照） | `%APPDATA%\Cairn\data\blobs\` |
| 检查点影子仓库 | `%APPDATA%\Cairn\checkpoints\<项目 id>\` |
| 配置 | `%APPDATA%\Cairn\settings.json` |
| 日志 | `%APPDATA%\Cairn\logs\` |

默认不在用户项目目录里写入任何文件。

### 14.2 主要表

| 表 | 内容 |
|---|---|
| `schema_meta` | 当前 schema 版本 |
| `projects` | 项目 id、名称、路径、创建时间 |
| `sessions` | 会话 id、项目 id、工作区路径、标题、状态、模型、时间 |
| `agent_definitions` | `(id, version)` 主键、来源、结构化定义（JSON）、时间 |
| `agent_runs` | 运行 id、会话 id、Agent 定义 id 与版本、父运行 id、状态、限额 |
| `run_snapshots` | 运行 id、轮次 id、规范化消息历史快照（用于加速恢复） |
| `events` | `(session_id, seq)` 主键、`run_id`（带索引）、类型、版本、时间、payload（JSON） |
| `file_changes` | 改动 id、会话、轮次、路径、变更类型、前后 blob 哈希 |
| `hunks` | 改动 id、块序号、起止行、状态（pending / accepted / reverted） |
| `checkpoints` | 检查点 id、会话、轮次、影子仓库提交 id、原因 |
| `permission_rules` | 见 10.1 |
| `provider_configs` | 见 12.1（不含明文密钥） |

### 14.3 约定

- 会话区分 `projectPath`（用户的项目）和 `workspacePath`（agent 实际工作的目录）。第一版两者相同；引入 git worktree 后，`workspacePath` 指向独立的工作树，数据结构无需改动。
- 启动时检查 schema 版本，按顺序执行迁移脚本；迁移前自动备份数据库文件。
- 存储通过 `SessionStore` 等接口访问，SQLite 引擎（better-sqlite3 或 Node 内置 `node:sqlite`）在 M0 预研后确定。

---

## 15. 进程间通信协议

详见 ADR-0009。

### 15.1 原则

- 所有消息在 `packages/protocol` 中用 zod 定义，同时导出 TS 类型；收发两端都做运行时校验。
- 两类通信：**请求/响应**（带 id，可超时）和**事件流**（单向推送）。
- 建立连接时交换协议版本，不兼容时拒绝连接并给出明确错误。

### 15.2 渲染进程 ↔ 主进程（主要接口）

| 名称 | 类型 | 说明 |
|---|---|---|
| `project.open` / `project.list` | 请求 | 打开（系统对话框）和列出项目 |
| `session.create` / `session.list` / `session.rename` / `session.archive` | 请求 | 会话管理 |
| `session.prompt` | 请求 | 发送用户输入 |
| `session.abort` | 请求 | 停止当前轮次 |
| `session.subscribe` | 请求 | 携带 `afterSeq` 订阅事件，返回补发数据 |
| `session.events` | 事件流 | 事件推送 |
| `approval.resolve` | 请求 | 回复审批 |
| `changes.list` / `changes.revert` | 请求 | 查看和撤销改动 |
| `checkpoint.list` / `checkpoint.preview` / `checkpoint.restore` | 请求 | 查看、预览和恢复检查点 |
| `settings.get` / `settings.update` | 请求 | 读写配置，不返回明文密钥 |
| `credentials.set` / `credentials.delete` / `credentials.status` | 请求 | 只能写入和查询是否存在，不能读出 |
| `provider.test` | 请求 | 能力探测 |

### 15.3 主进程 ↔ Agent 宿主

| 名称 | 方向 | 说明 |
|---|---|---|
| `host.init` | 主 → 宿主 | 会话配置、历史、规则、解析好的模型凭据 |
| `host.prompt` / `host.abort` / `host.shutdown` | 主 → 宿主 | 控制 |
| `host.event` | 宿主 → 主 | 运行时事件（无 seq，由主进程分配） |
| `host.approval.request` | 宿主 → 主 | 需要用户审批 |
| `host.approval.response` | 主 → 宿主 | 审批结果 |
| `host.heartbeat` | 双向 | 检测卡死 |

---

## 16. 配置与凭据

详见 ADR-0010。

### 16.1 配置

- `settings.json` 带 `version` 字段，启动时按版本执行迁移，迁移前备份。
- 用 zod 校验，非法字段回退到默认值并记录警告，不让坏配置导致无法启动。

### 16.2 凭据

```ts
interface CredentialProvider {
  readonly kind: 'local-key'       // 后续可加 'relay'、'oauth'
  resolve(ref: string): Promise<ResolvedCredential>
}
```

- 第一版只实现 `local-key`：密钥用 Electron `safeStorage` 加密后保存（Windows 下基于 DPAPI）。
- 在 Linux 上 `safeStorage` 可能因没有系统密钥环而退化为弱加密，届时需检测并提示用户（M6 处理）。
- 密钥只在主进程解密，在 `host.init` 时通过 MessagePort 传给对应会话的宿主进程；不写入环境变量、不进入日志、不传给渲染进程。

---

## 17. 安全设计

| 威胁 | 措施 |
|---|---|
| 渲染进程被注入脚本 | `contextIsolation`、`sandbox`、禁用 `nodeIntegration`、严格 CSP、只暴露白名单 API；Markdown 渲染时清洗 HTML |
| agent 访问项目外的文件 | 路径规范化后校验必须位于工作区内；处理 `..`、符号链接、Windows 盘符、大小写、`\\?\` 前缀、目录联接 |
| agent 读取敏感文件 | 内置敏感路径规则（`.env*`、私钥、云凭据目录）默认需审批 |
| 危险命令 | 强制审批（见 10.2、10.5） |
| 密钥泄露 | 只在主进程解密；清洗子进程环境变量；日志自动脱敏 |
| 提示注入（项目文件、命令输出中夹带指令） | 工具结果标注为数据；高风险操作始终经过权限引擎，不因模型"声称已获授权"而放行 |
| 数据篡改 | 数据库和配置只由主进程写入；渲染进程无法直接调用存储 |
| 缺少隔离 | 后续引入命令沙箱：Windows 受限令牌或 AppContainer，macOS sandbox-exec，Linux bubblewrap；在此之前审批与检查点是主要防线 |

---

## 18. 平台策略

首发 Windows，从第一版起遵守：

- 路径一律用 Node `path` 处理；比较路径前统一规范化，Windows 下忽略大小写。
- 命令执行通过 Shell 适配器，不在业务代码中出现特定 shell 语法。
- ripgrep 等外部二进制按平台打包，不依赖用户本机安装。
- 换行符：读取时识别 CRLF/LF，写入时保持文件原有换行风格。
- 文件编码：默认 UTF-8，检测到 BOM 时保留；其他编码在读取时提示。
- CI 在 Windows 上运行全部测试；跨平台阶段加入 macOS 和 Linux 运行器。

---

## 19. 国际化

详见 ADR-0013。

- 使用 i18next + react-i18next，资源放在 `packages/i18n/locales/{zh-CN,en-US}/`，按命名空间拆分。
- 组件只引用 key，禁止硬编码文案（ESLint 规则检查）。
- 首次启动跟随系统语言，非中文系统默认英文；设置中可切换，即时生效。
- 主进程的菜单、对话框、通知、错误提示共用同一套资源。
- 错误以错误码在进程间传递，由界面按当前语言翻译，避免把某种语言的字符串写进日志和协议。
- 日期、数字用 `Intl` 格式化。
- CI 检查两种语言的 key 完全一致。
- 给模型的工具说明和系统提示词使用英文（模型理解更稳定），回复语言跟随用户。

---

## 20. 可观测性与诊断

- 结构化日志（JSON 行），按进程区分，按大小轮转；统一脱敏函数处理密钥、令牌和用户主目录路径。
- 每个会话可导出"诊断包"：脱敏后的日志、事件摘要、版本和环境信息，便于排查问题。
- 默认不上传任何遥测数据；如后续需要，必须显式征得用户同意（opt-in）。
- 开发模式下提供事件查看器，实时查看事件流，方便调试。

---

## 21. 错误处理与恢复

| 场景 | 处理 |
|---|---|
| 模型请求失败（网络、限流、5xx） | 指数退避重试，次数可配置；最终失败记为 `turn.failed`，界面可一键重试 |
| 模型返回非法工具调用 | 将校验错误作为工具结果返回给模型，让其修正；连续失败超过阈值则终止本轮 |
| 工具执行异常 | 记为 `tool.failed`，错误信息返回模型 |
| 宿主进程崩溃或心跳超时 | 记为 `session.crashed`，结束残留子进程，提示用户从最后完整事件恢复 |
| 主进程退出 | 结束所有宿主和子进程；未完成轮次在下次启动时标记为中断 |
| 数据库迁移失败 | 恢复迁移前备份，提示用户并提供诊断包导出 |

agent 循环设置最大步数和单轮最长时间，防止无限循环。

---

## 22. 性能

- 流式文本增量在主进程合并后按帧率（约 30 次/秒）推送界面，避免频繁渲染。
- 消息列表虚拟滚动；长工具输出折叠显示。
- 大文件 diff 采用懒加载，超大文件只显示摘要。
- 宿主进程按需启动、空闲回收，控制内存占用。
- 启动时只加载会话列表，会话内容在打开时再读取。

---

## 23. 测试策略

| 层次 | 内容 | 工具 |
|---|---|---|
| 单元 | 权限引擎、路径校验、事件归约、协议 schema、迁移脚本 | Vitest |
| 契约 | pi 适配器在固定输入下的事件输出；用于 pi 升级回归 | Vitest + 录制的模型响应 |
| 集成 | Agent 宿主 + 工具 + 存储，使用 `FakeRuntime` 或录制回放的模型 | Vitest |
| 端到端 | 启动真实 Electron 应用，完成典型任务流程 | Playwright（Electron 支持） |
| 平台 | Windows 上的命令执行、编码、路径、进程树结束 | Windows CI 运行器 |

真实模型的测试只在本地或手动触发的流水线中运行，避免在 CI 中消耗密钥。

---

## 24. 构建、发布与更新

- 构建：electron-vite；打包：electron-builder，Windows 产物为 NSIS 安装包。
- 原生模块（如 better-sqlite3）需要针对 Electron 版本重新编译，纳入构建流程。
- 代码签名：发布阶段处理，未签名的安装包会触发 Windows SmartScreen 警告。
- 自动更新：electron-updater。仓库私有期间无法直接使用公开的 GitHub Releases 作为更新源，需要另外的更新服务器或带令牌的私有源，待 M5 决定。
- 依赖许可证：CI 中检查，只允许 MIT、Apache-2.0、BSD、ISC 等宽松许可证（ADR-0014）。

---

## 25. 仓库结构

```
Cairn/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/          # 主进程：窗口、IPC 网关、会话管理、存储服务、凭据
│       │   ├── preload/       # contextBridge 类型化 API
│       │   ├── agent-host/    # Agent 宿主进程入口
│       │   └── renderer/      # React 界面
│       └── electron-builder.yml
├── packages/
│   ├── protocol/              # IPC 协议与事件 schema
│   ├── core/                  # 领域类型、AgentRuntime 接口、权限引擎、路径校验、事件归约
│   ├── runtime-pi/            # pi 适配器
│   ├── tools/                 # 内置工具
│   ├── skills/                # Skill 解析与加载
│   ├── mcp/                   # MCP 客户端与工具适配
│   ├── shell/                 # Shell 适配器
│   ├── checkpoint/            # 检查点
│   ├── storage/               # 存储接口、SQLite 实现、迁移
│   ├── i18n/                  # 文案资源
│   └── ui/                    # 界面组件与设计令牌
├── docs/
│   ├── architecture.md
│   └── adr/
├── scripts/                   # 许可证检查、i18n 检查等
├── pnpm-workspace.yaml
└── package.json
```

---

## 26. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **M0 基础** | monorepo 与依赖边界、协议包、事件模型与归约、存储与迁移、进程模型（主进程 + 宿主）、`AgentRuntime` 接口与 `FakeRuntime`、日志、i18n 骨架、Windows CI；完成第 27 节的技术预研 | 用 `FakeRuntime` 跑通"输入 → 事件 → 落库 → 界面显示 → 重启后恢复" |
| **M1 最小可用** | pi 适配器、DeepSeek 接入、6 个内置工具、权限引擎与审批、PowerShell 执行、基础检查点 | 用 DeepSeek 完成一个真实的改代码并运行测试的任务，可回退 |
| **M2 可审阅** | 能力探测、设置页、工具卡片、diff 视图（整文件接受/撤销）、终端输出面板、检查点回退界面 | 两个模型可切换，所有改动可审阅、可撤销 |
| **M3 日常可用** | 项目与会话管理、Agent 管理界面、计划模式、会话要点、规则管理界面、上下文压缩、`AGENTS.md` 支持、Skills、MCP、辅助模型、诊断包、按块撤销 | 可以长期在真实项目中使用，可自定义 Agent 并接入外部工具 |
| **M4 进阶** | 多 Agent 委派、git worktree 隔离、多会话并行、后台命令、更多模型提供方 | 多任务并行互不干扰 |
| **M5 发布** | 命令沙箱、自动更新、签名与 Windows 安装包（附带精简版 MinGit 供检查点使用，ADR-0008） | 可以分发给他人安装 |
| **M6 跨平台与开源** | macOS、Linux 适配与打包，Linux 凭据存储处理，开源准备（许可证、贡献指南） | 三个平台可用，仓库可公开 |

各阶段的任务分解见 [`docs/plan/`](plan/)：[M0 基础](plan/m0.md)、[M1 最小可用](plan/m1.md)、[M2 可审阅](plan/m2.md)。

---

## 27. 风险与待验证事项

以下在 M0 中通过小规模预研（spike）验证，结论写回对应 ADR：

| 事项 | 风险 | 验证方式 |
|---|---|---|
| pi 在 `utilityProcess` 中运行 | 依赖或环境假设导致无法运行 | 最小示例：宿主进程内跑通一次带工具调用的对话 |
| DeepSeek 工具调用 | 推理模型字段与 pi-ai 不兼容 | 用真实 key 测试多轮工具调用 |
| SQLite 引擎选择 | better-sqlite3 需原生编译；`node:sqlite` 取决于 Electron 内置 Node 版本是否稳定 | 两者各做最小示例，比较打包复杂度 |
| 影子 Git 检查点性能 | 大仓库快照耗时 | 在万级文件的仓库上测量创建和恢复耗时 |
| 检查点使用的 Git 来源 | 用户未安装 Git；随应用打包涉及 GPL 分发合规 | 比较本机 Git、打包 Git、isomorphic-git 三种方式 |
| PowerShell 5.1 编码与进程树结束 | 中文乱码、子进程残留 | 编写含中文输出、嵌套子进程的测试命令 |
| pi 版本变动 | API 不兼容 | 锁定版本，契约测试覆盖 |
