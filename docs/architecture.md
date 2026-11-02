# 架构设计（草案）

> 状态：讨论中，尚未开始开发。本文档用于在开发前确认方向，所有内容都可以调整。
> 作者：960602906

## 1. 项目目标

做一个类似 Codex 的**编程类桌面 agent 应用**：用户选择一个本地项目目录，用自然语言描述任务，agent 自主读代码、改代码、执行命令，并把每一步过程和文件改动可视化地展示出来，敏感操作需要用户审批。

核心诉求：

- **多模型**：可以接入各种格式的 LLM（Anthropic、OpenAI、Google、OpenAI 兼容接口、本地 Ollama 等），用户可以填写自己的 key 和 baseUrl。
- **可控**：agent 的每个操作都看得见，写文件、执行命令前可以拦截确认。
- **可审阅**：所有文件改动以 diff 形式展示，可以接受或撤销。

### 已确认决策

| 事项 | 结论 |
|---|---|
| 项目名称 | NEXUS-OS |
| 首发平台 | Windows；后续支持 macOS 和 Linux |
| 首批模型 | DeepSeek（云端 API）、Ollama（本地模型） |
| 命令执行 | 第一版即开放，默认每条命令需审批 |
| 开源 | 暂时私有，后续开源；许可证待开源时再定 |
| Windows 默认 Shell | PowerShell 5.1（系统自带）；检测到 PowerShell 7 时优先使用 |
| 界面语言 | 中英双语 |

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
| 国际化 | i18next + react-i18next | 成熟、支持按命名空间拆分和运行时切换语言 |
| Agent 核心 | pi-agent-core | 现成的 agent 循环、工具调用、事件流，带 `beforeToolCall` 钩子 |
| 模型接入 | pi-ai | 统一的多厂商 LLM 接口，支持自定义 baseUrl |
| 持久化 | JSONL / SQLite | 会话可按 pi 的格式存储，配置存本地文件 |

> 注意：pi 的 npm 包已从 `@mariozechner/*` 迁移到 `@earendil-works/*`，迭代较快，开发时需锁定版本并以官方文档为准。

### 2.1 首批模型接入

| 提供方 | 接入方式 | 说明 |
|---|---|---|
| DeepSeek | OpenAI 兼容接口，baseUrl 指向 DeepSeek 官方 API | 用户填写自己的 API Key；需验证其工具调用（function calling）在 pi-ai 下的表现 |
| Ollama | OpenAI 兼容接口，默认 `http://localhost:11434/v1` | 无需 Key；工具调用能力取决于具体本地模型，需在设置页提示用户选择支持工具调用的模型 |

两者都走 pi-ai 的 OpenAI 兼容通道，因此第一版只需实现一种"OpenAI 兼容提供方"配置，后续加入 Anthropic、OpenAI、Google 等时再扩展。具体 baseUrl、模型名以各自官方文档为准。

模型相关的设计要点：

- **能力探测**：设置页添加"测试连接"，发送一次带工具定义的请求，检查模型能否正确返回工具调用。
- **上下文长度**：不同模型差异大（本地模型往往较小），工具输出截断阈值和上下文压缩策略按模型配置。
- **Ollama 状态**：启动时检测本地服务是否在运行，未运行时在界面上给出提示。

### 2.2 平台策略

首发 Windows，后续支持 macOS 和 Linux。为了降低移植成本，从第一版开始遵守：

- 路径处理统一使用 Node 的 `path` 模块，不手写分隔符；比较路径时在 Windows 上忽略大小写。
- 命令执行抽象为"Shell 适配器"：Windows 默认 PowerShell 5.1（`powershell.exe`），检测到 PowerShell 7（`pwsh.exe`）时优先使用，也可在设置中改为 cmd；macOS/Linux 使用用户默认 shell。
- ripgrep 等外部二进制按平台打包，不依赖用户本机安装。
- 打包使用 electron-builder，Windows 产物为 NSIS 安装包；代码签名在发布阶段处理。

### 2.3 国际化（中英双语）

- **界面文案**：所有文案放入 `locales/zh-CN` 和 `locales/en-US` 资源文件，组件中只引用 key，禁止硬编码字符串。
- **默认语言**：首次启动跟随系统语言，非中文系统默认英文；设置页可手动切换，切换后立即生效，无需重启。
- **主进程文案**：系统对话框、菜单、通知、错误提示同样走 i18n 资源，主进程与渲染进程共用一套 key。
- **agent 回复语言**：不强制，系统提示词要求模型使用用户提问所用的语言回复。
- **格式化**：日期、数字使用 `Intl` API 按当前语言格式化。
- **质量保障**：增加脚本检查两种语言的 key 是否一一对应，缺失时在开发环境报警。

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

### 5.1 命令执行（第一版开放）

- **Shell**：Windows 默认 PowerShell 5.1，检测到 PowerShell 7 时优先使用，工作目录固定为项目根目录。需注意 5.1 的输出编码，统一按 UTF-8 读取，避免中文乱码。
- **审批**：默认每条命令都需确认，审批卡片显示完整命令和工作目录。
- **超时与输出**：设置默认超时（如 120 秒），输出流式显示在终端面板，返回给模型时按长度截断。
- **可中断**：用户可随时停止正在运行的命令，Windows 上需结束整个进程树。
- **环境变量**：不把 API Key 等敏感变量传给子进程。
- **危险命令识别**：即使在自动模式下，以下类型仍强制审批：
  - 递归删除：`Remove-Item -Recurse`、`rm -rf`、`del /s`、`rd /s`
  - 磁盘与系统：`format`、`diskpart`、修改注册表、修改系统设置
  - 远端改写：`git push --force`、`git reset --hard` 等
  - 访问项目目录之外的路径

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
- Windows 路径：校验时处理盘符、大小写、反斜杠、`\\?\` 长路径前缀和目录联接（junction）。
- 后续：命令沙箱。Windows 可考虑受限令牌或 AppContainer，macOS 用 sandbox-exec，Linux 用 bubblewrap 或容器。由于第一版已开放命令执行而暂无沙箱，审批是主要的安全防线。

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
│       ├── locales/     # zh-CN、en-US 文案
│       └── styles/      # 设计令牌
└── package.json
```

## 11. 开发阶段

| 阶段 | 内容 | 目标 |
|---|---|---|
| M1 | Electron 骨架（Windows）、对话界面、DeepSeek 接入、读写文件与执行命令工具、审批 | 跑通一个完整任务 |
| M2 | Ollama 接入与设置页、工具调用卡片、diff 视图、终端输出面板 | 可切换模型、可审阅改动 |
| M3 | 会话持久化、项目与会话管理、危险命令识别 | 日常可用 |
| M4 | git worktree 隔离、多会话并行、MCP 支持、更多模型 | 进阶能力 |
| M5 | 沙箱、自动更新、Windows 打包发布 | 可分发 |
| M6 | macOS 与 Linux 适配和打包、开源准备 | 跨平台与开源 |

## 12. 待确认问题

已确认的事项见第 1 节"已确认决策"。剩余问题：

1. **API Key 方式**：只支持用户自带 key，还是也考虑中转服务？
2. **会话存储**：沿用 pi 的 JSONL 格式，还是自建 SQLite？
3. **diff 粒度**：第一版做整文件接受/撤销，还是直接支持按块操作？
4. **开源准备**：私有期间是否需要注意依赖许可证兼容性，以便后续开源时选择 MIT 或 Apache-2.0？（建议是）
