# 架构决策记录（ADR）

每条记录描述一个难以事后更改的决策：背景、决定、考虑过的备选方案、取舍和后果。

- **状态**：提议 → 已接受 → （可能）已替代或已废弃。被替代或废弃的记录不删除，只标注被哪条替代，或废弃的日期与原因。
- **修改方式**：不直接改写已接受的结论，而是新增一条 ADR 说明变化和原因。
- **待验证**：标注"待预研"的部分在 M0 验证后更新。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | 使用 ADR 记录架构决策 | 已接受 |
| [0002](0002-electron-typescript.md) | 使用 Electron 与全栈 TypeScript | 已接受 |
| [0003](0003-agent-in-utility-process.md) | Agent 运行在独立的 utilityProcess 中 | 已接受 |
| [0004](0004-isolate-pi-behind-agentruntime.md) | 用 AgentRuntime 接口隔离 pi | 已接受 |
| [0005](0005-event-log-as-source-of-truth.md) | 以追加式事件日志作为会话的事实来源 | 已接受 |
| [0006](0006-sqlite-storage-with-migrations.md) | 使用 SQLite 存储并从第一天起支持迁移 | 已接受（引擎待预研） |
| [0007](0007-rule-based-permissions.md) | 基于规则的权限引擎 | 已接受 |
| [0008](0008-checkpoints-and-hunks.md) | 检查点与按块改动记录 | 已接受 |
| [0009](0009-typed-versioned-ipc.md) | 类型化、带版本的进程间通信协议 | 已接受 |
| [0010](0010-credential-provider.md) | 可扩展的凭据提供方与加密存储 | 已接受 |
| [0011](0011-openai-compatible-first.md) | 模型接入以 OpenAI 兼容接口优先 | 部分被 0021 替代 |
| [0012](0012-windows-command-execution.md) | Windows 命令执行方案 | 已接受 |
| [0013](0013-bilingual-i18n.md) | 中英双语国际化 | 已接受 |
| [0014](0014-permissive-dependency-licenses.md) | 只使用宽松许可证的依赖 | 已接受 |
| [0015](0015-pnpm-monorepo.md) | 使用 pnpm monorepo 并强制依赖边界 | 已接受 |
| [0016](0016-agent-definition-and-run.md) | Agent 定义与运行作为一等概念 | 已接受 |
| [0017](0017-unified-capability-layer.md) | 统一能力层：Tools、Skills 与 MCP | 已接受 |
| [0018](0018-interactive-and-unattended-runs.md) | 交互运行与无人值守运行 | 已接受 |
| [0019](0019-memory-scopes.md) | 记忆范围（预留） | 已接受（功能暂缓） |
| [0020](0020-hub-and-spoke-delegation.md) | 多 Agent 采用以父运行为中心的委派模式 | 已接受 |
| [0021](0021-three-api-formats.md) | 首批支持 OpenAI、Anthropic、Gemini 三种接口格式 | 已接受 |
| [0022](0022-prompt-enhancement.md) | 输入优化：由用户触发、确认后发送 | 已废弃 |
| [0023](0023-platform-and-pluggable-engine.md) | 自研平台 + 可插拔 Agent 引擎（首选 pi） | 已接受 |
| [0024](0024-conversation-first-visual-style.md) | 界面采用“对话风”视觉风格 | 已接受 |
| [0025](0025-product-name-cairn.md) | 产品命名为 Cairn（石标） | 已接受 |
| [0026](0026-mcp-in-main-process.md) | MCP 连接放在主进程，宿主经 RPC 调用 | 已接受 |
| [0027](0027-context-compaction.md) | 上下文压缩：摘要替换模型历史，原始事件保留 | 已接受 |
| [0028](0028-plan-mode.md) | 计划模式：结构化计划、只读轮次与两个工具 | 已接受 |
| [0029](0029-custom-agents.md) | 自定义 Agent 存储、版本与运行隔离 | 已接受 |
| [0030](0030-multi-run-delegation.md) | 同一宿主内的多运行、父子运行与委派边界 | 已接受 |
| [0031](0031-isolated-workspaces.md) | 隔离工作区与改动集合并 | 提议（M4 定稿中） |
| [0032](0032-activity-center.md) | 活动中心与跨会话审批聚合 | 提议（M4 定稿中） |
