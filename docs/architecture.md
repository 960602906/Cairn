# 架构设计（草案）

> 状态：讨论中，尚未开始开发。本文档用于在开发前确认方向，所有内容都可以调整。
> 作者：960602906

## 1. 项目目标

做一个类似 Codex 的**编程类桌面 agent 应用**：用户选择一个本地项目目录，用自然语言描述任务，agent 自主读代码、改代码、执行命令，并把每一步过程和文件改动可视化地展示出来，敏感操作需要用户审批。

核心诉求：

- **多模型**：可以接入各种格式的 LLM（Anthropic、OpenAI、Google、OpenAI 兼容接口、本地 Ollama 等），用户可以填写自己的 key 和 baseUrl。
- **可控**：agent 的每个操作都看得见，写文件、执行命令前可以拦截确认。
- **可审阅**：所有文件改动以 diff 形式展示，可以接受或撤销。

非目标（第一版不做）：

- 云端运行、多人协作、账号体系。
- 通用办公类任务（整理文件、写文档等），只聚焦编程。
- 插件市场。

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面外壳 | Electron + electron-vite | 全栈 TypeScript，无需 Rust；生态成熟 |
| 界面 | React + TypeScript | 已有前端经验 |
| UI 组件 | Tailwind CSS + shadcn/ui | 快速搭建、易于主题化 |
| 代码与 diff | Monaco Editor | 与 VS Code 同款，自带 DiffEditor |
| 状态管理 | Zustand | 轻量，适合会话和消息流 |
| Agent 核心 | pi-agent-core | 现成的 agent 循环、工具调用、事件流，带 `beforeToolCall` 钩子 |
| 模型接入 | pi-ai | 统一的多厂商 LLM 接口，支持自定义 baseUrl |
| 持久化 | JSONL / SQLite | 会话可按 pi 的格式存储，配置存本地文件 |

> 注意：pi 的 npm 包已从 `@mariozechner/*` 迁移到 `@earendil-works/*`，迭代较快，开发时需锁定版本并以官方文档为准。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│ 渲染进程（React 界面）                                      │
│  对话界面 │ 改动视图（Diff） │ 设置页 │ 状态存储（Zustand）  │
└───────────────────────┬──────────────────────────────────┘
                        │  指令向下 / 事件向上
┌───────────────────────▼──────────────────────────────────┐
│ 预加载脚本（contextBridge 白名单 API）                       │
└───────────────────────┬──────────────────────────────────┘
                        │  IPC
┌───────────────────────▼──────────────────────────────────┐
│ 主进程（Node.js）                                          │
│  Agent 循环（pi-agent-core） │ 工具层 │ 审批钩子 │ 会话存储  │
└──────┬─────────────────────┬──────────────────────┬───────┘
       │                     │                      │
  模型提供方（pi-ai）     项目目录（白名单）      Git 仓库（后续 worktree）
```

### 3.1 渲染进程

只负责展示与交互，**不能直接访问文件系统、网络或 API Key**。

- 对话界面：消息流、工具调用卡片、审批卡片、输入框。
- 改动视图：改动文件列表 + Monaco DiffEditor。
- 设置页：模型提供方、API Key、baseUrl、默认模型、权限模式。
- 状态存储：会话列表、消息、运行状态、改动记录。

### 3.2 预加载脚本

通过 `contextBridge` 暴露最小化的 API，是渲染进程与主进程之间的唯一通道。开启 `contextIsolation`，关闭 `nodeIntegration`。

### 3.3 主进程

- **Agent 循环**：每个会话一个 `Agent` 实例，订阅其事件并转发给界面。
- **工具层**：内置工具（见第 5 节），所有路径都经过项目目录白名单校验。
- **审批钩子**：在 `beforeToolCall` 中根据权限模式决定放行、拦截或请求用户确认。
- **会话存储**：保存会话历史，支持恢复和分支。
- **配置管理**：API Key 等敏感信息只存在主进程，可考虑使用系统钥匙串（如 keytar 或 Electron safeStorage）加密保存。

## 4. 核心流程

### 4.1 一次任务的执行流程

1. 用户在界面输入任务，渲染进程调用 `agent:run`。
2. 主进程为会话创建或复用 `Agent`，调用 `agent.prompt()`。
3. 模型返回文本或工具调用请求，事件流实时推送到界面。
4. 工具调用前进入 `beforeToolCall`：
   - 只读工具：直接放行。
   - 写入或执行类工具：按权限模式处理，必要时发起审批。
5. 工具执行结果回到 agent 循环，进入下一轮，直到模型给出最终回复。
6. 主进程发送 `agent:done`，界面切回空闲状态。

### 4.2 审批流程

1. 主进程生成审批 id，通过 IPC 发送 `agent:approval-request`（含工具名、参数、diff 预览）。
2. 界面插入审批卡片，等待用户点击允许或拒绝。
3. 渲染进程调用 `agent:approve(id, allow)`。
4. 主进程恢复钩子：允许则执行工具，拒绝则返回 `{ block: true, reason }` 让模型调整。

### 4.3 文件改动记录

写文件工具在执行前读取原内容保存为 `before`，执行后记录 `after`，用于生成 diff 和支持撤销。

## 5. 工具清单（第一版）

| 工具 | 类型 | 默认策略 |
|---|---|---|
| `read_file` | 只读 | 自动放行 |
| `list_dir` | 只读 | 自动放行 |
| `search`（基于 ripgrep） | 只读 | 自动放行 |
| `write_file` | 写入 | 需审批，附 diff 预览 |
| `edit_file`（局部替换） | 写入 | 需审批，附 diff 预览 |
| `run_command` | 执行 | 需审批，显示完整命令 |

后续可扩展：git 操作、网页抓取、MCP 工具接入。

## 6. 权限模式

| 模式 | 只读工具 | 写入工具 | 执行命令 |
|---|---|---|---|
| 只读 | 放行 | 拒绝 | 拒绝 |
| 询问（默认） | 放行 | 审批 | 审批 |
| 自动 | 放行 | 放行 | 放行（危险命令仍审批） |

## 7. IPC 接口定义（草案）

| 通道 | 方向 | 说明 |
|---|---|---|
| `agent:run` | 界面 → 主进程 | 启动任务（会话 id、提示词） |
| `agent:abort` | 界面 → 主进程 | 停止当前任务 |
| `agent:approve` | 界面 → 主进程 | 回复审批（id、是否允许） |
| `agent:event` | 主进程 → 界面 | agent 事件流（文本增量、工具开始/结束等） |
| `agent:approval-request` | 主进程 → 界面 | 请求审批 |
| `agent:done` | 主进程 → 界面 | 本轮结束 |
| `project:open` | 界面 → 主进程 | 选择项目目录（系统对话框） |
| `settings:get` / `settings:set` | 双向 | 读写配置（不返回明文 Key） |

## 8. 数据模型（草案）

```ts
type Project = { id: string; name: string; path: string }

type Session = {
  id: string
  projectId: string
  title: string
  status: 'idle' | 'running' | 'waiting_approval' | 'error'
  createdAt: number
}

type Message =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; name: string; input: unknown; output?: string;
      status: 'running' | 'done' | 'error' | 'blocked' }
  | { kind: 'approval'; id: string; toolName: string; input: unknown;
      decision?: 'allow' | 'deny' }

type FileChange = { path: string; before: string | null; after: string }

type ProviderConfig = {
  id: string
  provider: string        // anthropic / openai / google / openai-compatible ...
  baseUrl?: string
  models: string[]
  // apiKey 只保存在主进程的加密存储中
}
```

## 9. 安全设计

- 渲染进程隔离：`contextIsolation: true`、`nodeIntegration: false`、启用 sandbox。
- 路径白名单：所有文件工具只允许访问当前项目目录，拒绝 `..` 越界和符号链接逃逸。
- 命令审批：默认每条命令都需要确认；后续可加命令白名单和危险命令识别（如 `rm -rf`、`git push --force`）。
- 密钥保护：API Key 不进入渲染进程，不写入日志，不打包进前端代码。
- 输出截断：工具输出按长度截断，防止上下文爆炸。
- 后续：命令沙箱（macOS sandbox-exec、Linux bubblewrap 或容器）。

## 10. 目录结构（草案）

```
NEXUS-OS/
├── docs/
│   └── architecture.md
├── src/
│   ├── main/            # 主进程
│   │   ├── index.ts     # 窗口与 IPC 注册
│   │   ├── agent/       # Agent 创建、事件转发
│   │   ├── tools/       # 内置工具
│   │   ├── approval/    # 审批与权限模式
│   │   ├── storage/     # 会话与配置存储
│   │   └── providers/   # 模型提供方配置
│   ├── preload/         # contextBridge API
│   └── renderer/        # React 界面
│       ├── components/  # Chat、ToolCard、ApprovalCard、DiffView ...
│       ├── stores/      # Zustand
│       └── styles/      # 设计令牌
└── package.json
```

## 11. 开发阶段

| 阶段 | 内容 | 目标 |
|---|---|---|
| M1 | Electron 骨架、对话界面、一个模型、读写文件工具、审批 | 跑通一个完整任务 |
| M2 | 多模型接入与设置页、工具调用卡片、diff 视图 | 可切换模型、可审阅改动 |
| M3 | 会话持久化、项目与会话管理、执行命令工具 | 日常可用 |
| M4 | git worktree 隔离、多会话并行、MCP 支持 | 进阶能力 |
| M5 | 沙箱、自动更新、打包发布 | 可分发 |

## 12. 待确认问题

1. **项目名称**：已定为 NEXUS-OS（仓库 960602906/NEXUS-OS）。
2. **目标平台**：首发支持 macOS、Windows 还是 Linux？
3. **首批接入的模型**：例如 Claude、GPT、DeepSeek、通义千问、本地 Ollama？
4. **API Key 方式**：只支持用户自带 key，还是也考虑中转服务？
5. **是否开源**：如开源，许可证选择（MIT / Apache-2.0）。
6. **界面语言**：中文、英文还是双语？
7. **命令执行**：第一版是否就开放执行命令，还是先只做读写文件？
8. **会话存储**：沿用 pi 的 JSONL 格式，还是自建 SQLite？
9. **diff 粒度**：第一版做整文件接受/撤销，还是直接支持按块操作？
