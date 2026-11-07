# M3 无人值守执行报告

> 分支：`codex/m3-overnight-20261107`
> 开始时间：2026-11-07 23:05（Asia/Shanghai）
> 基线提交：`3cea1b3`（origin/main）
> 目标：完成 `docs/plan/m3.md` 中 M3-09 ～ M3-14 的全部任务，按交付物与验收标准执行。

## 1. 启动与基线

### 1.1 已读文档

- `README.md`、`docs/architecture.md`
- `docs/plan/m3.md`
- `docs/design/agent-runtime.md`、`docs/design/agent-management-ui.md`、`docs/design/visual-style.md`
- 相关 ADR：0010、0014、0016、0017、0023、0024

### 1.2 分支

- 从 `origin/main` 新建 `codex/m3-overnight-20261107`。
- 未删除、未重建任何已有分支；未推 `main`。

### 1.3 基线验证（任务开始前）

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通过（依赖已是最新） |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 通过：153 个文件通过 / 2 跳过，2191 个用例通过 / 19 跳过 |

已知失败：无。

### 1.4 覆盖率门槛调整

- `docs/plan/m3.md` 的“四项覆盖率不低于 90%”改为 95%。
- `.github/workflows/ci.yml` 步骤名改为 `Test (coverage ≥ 95%)`；`vitest.config.ts` 原本已是 95%。

## 2. 任务清单与状态

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| M3-09 MCP 后端 | 完成 | `feat(mcp): MCP 后端 [M3-09]` | 覆盖率、build、完整 e2e 通过 |
| M3-10 设置页“MCP 服务” | 完成 | `feat(settings): MCP 服务设置页 [M3-10]` | 15 个组件用例、e2e、截图 |
| M3-11 自定义 Agent 后端 | 完成 | `feat(agents): 自定义 Agent 后端 [M3-11]` | 覆盖率四项 ≥ 95%，build/e2e 28 项通过 |
| M3-12 Agents 页面与 Agent 选择器 | 未开始 | — | |
| M3-13 诊断包 | 未开始 | — | 不依赖 MCP |
| M3-14 收尾与验收 | 未开始 | — | |

## 3. 决策与假设

- 无人值守模式优先于 `grill-me` 技能的交互式提问：规格有歧义时按文档与 ADR 选保守方案，并记录在本报告。

## 4. 阻塞

（暂无）

## 5. 断点

- 当前断点：M3-11 完成并提交，准备开始 M3-12（Agents 页面与 Agent 选择器）。

## 6. 任务实施记录

### M3-09 MCP 后端

- 状态：完成。
- 主要改动：
  - 新包 `packages/mcp`：连接管理器、SDK 薄包装、脱敏、真实 stdio 集成测试。
  - 协议：`packages/protocol/src/mcp.ts`、`host.init.mcpTools`、`host.mcp.call`、`mcp.*` RPC 与 `mcp.status` 事件。
  - 存储：迁移 0009、`mcp_servers` / `mcp_tool_prefs` 的内存与 SQLite 实现及契约测试。
  - 主进程：`mcp-service`、宿主工具适配、`renderer-gateway`、应用启动连接与退出关闭。
  - ADR-0026：MCP 连接放主进程，宿主经 RPC 调用。
  - e2e：`apps/desktop/e2e/mcp.spec.ts`（添加服务 → mock 模型调用 → 审批 → 结果回传）。
- 验证：
  - `pnpm format:check`：通过。
  - `pnpm typecheck`：通过。
  - `pnpm lint`：通过。
  - `pnpm check:i18n`：通过。
  - `pnpm test:coverage`：通过，四项均达到 95%。
  - `pnpm build`：通过。
  - `pnpm e2e`：完整 26 项通过；新增 MCP e2e 单独复跑通过（完整套件在新增前跑过一次，新增后单跑通过）。
  - `pnpm check:licenses`：通过。
- 关键决策与差异：
  - 工具名使用 `mcp_<服务>_<工具>`，不使用点号（ADR-0026）。
  - 工具名改为按存储顺序一次性分配，保证列表与宿主名称一致。
  - Windows 上用 `taskkill /T /F` 结束 stdio 子进程树；其他平台只结束直接子进程。
  - 覆盖率补充：新增 MCP 单测与存储契约用例；保留 7 个防御性分支未覆盖（平台差异、不可达的保护判断）。
- 已知问题：无。

### M3-10 设置页“MCP 服务”

- 状态：完成。
- 主要改动：
  - `apps/desktop/src/renderer/settings/McpSettings.tsx`：列表、添加 / 编辑表单、详情（工具类别与默认权限、连接日志、重新连接、编辑、删除）、删除确认。
  - `SettingsPage.tsx` 新增“能力 → MCP 服务”分区；`session-store.ts` 增加 `mcp.*` 方法与 `mcp.status` 订阅。
  - i18n：`settings.json` 新增 `section.mcp.*` 与约 60 条 `mcp.*` 文案；`errors.json` 新增 `mcp.*` 错误码（中英同步）。
  - 组件测试 `McpSettings.test.tsx`（15 个用例）；e2e `mcp-settings.spec.ts` 用真实 stdio 服务覆盖添加、连接失败与删除，并输出浅 / 深色截图。
- 验证：
  - `pnpm format:check`：通过。
  - `pnpm typecheck`：通过。
  - `pnpm lint`：通过。
  - `pnpm check:i18n`：通过。
  - `pnpm test:coverage`：通过，四项均达到 95%（补测前分支一度为 94.76%，补充组件用例后恢复）。
  - `pnpm build`：通过。
  - `pnpm e2e`：28 项全部通过。
- 关键决策与差异：
  - 配置里不保存环境变量值与令牌，界面只显示“已设置”，留空保持原值；清除令牌用单独开关。
  - 状态刷新由 `mcp.status` 驱动：列表总是刷新，详情只在同一服务时刷新。
  - 覆盖率调整只新增测试与消除不可达的分支判断，没有放宽阈值或跳过测试。
- 截图：`/opt/cursor/artifacts/mcp-settings-{light,dark}.png`、`mcp-settings-detail-{light,dark}.png`（Windows 实际路径 `C:\opt\cursor\artifacts`）。
- 已知问题：无。

### M3-11 自定义 Agent 后端

- 状态：完成。
- 实施计划（执行后回填）：
  1. 协议与存储：`AgentDefinition` / 草稿 / 校验结果类型；迁移 `0010-agents` 与 `agents`、`agent_versions` 的内存、SQLite 实现。
  2. 核心：`builtin.coder`、工具与技能选择器、`validateAgentDefinition`。
  3. 主进程：`agent-service`（CRUD、版本、diff、导入导出、生效配置、运行期辅助）与 `renderer-gateway` RPC。
  4. 运行接入：`host-supervisor` / `session-manager` / `agent-host/host.ts` 使用 Agent 的指令、工具、Skills、权限与限额；`session.setAgent`。
  5. 测试：协议、核心、存储契约、服务、宿主与网关单测；补宿主 `summarize` / `compact` / 会话要点 / 计划执行 / 读取路径等分支的覆盖。
- 风险：草稿与已发布字段混用（发布定义带版本与时间戳）会破坏草稿 schema；运行中切换 Agent 需要先停宿主；工具、Skills、MCP 选择器的过滤顺序影响系统提示词里的“是否有工具”。
- 主要改动：
  - 协议 `packages/protocol/src/agents.ts`：`AgentDefinition`、`AgentDraft`、`AgentDraftInput`、`AgentValidationResult`、`AgentDetail`、`AgentSummary`、`AgentVersionSummary`、`AgentDiff`、`AgentEffectiveConfig` 等。
  - 存储：迁移 `packages/storage/src/sqlite/migrations/0010-agents.ts`，`types.ts` 增加 `agents` / `agent_versions`，`memory.ts`、`sqlite/storage.ts`、`testing/store-contract.ts` 同步。
  - 核心 `packages/core/src/agents.ts`：`builtin.coder`、工具目录、选择器、定义校验。
  - 主进程 `apps/desktop/src/main/services/agent-service.ts`：`agent.*` 命令与运行期辅助；`agent-service.test.ts` 覆盖边界。
  - 运行接入：`host-supervisor.ts`、`session-manager.ts`（`setAgent`、固定模型、限额覆盖）、`agent-host/host.ts`（工具过滤、Agent 指令、`includeProjectInstructions`、`activePlan`）。
  - i18n：`errors.json` 增加 `agent.*` 错误码（中英同步）。
- 修复的真实缺陷（以测试驱动发现）：
  1. `duplicate` 把已发布定义的版本与时间戳混入草稿，导致 `AgentDraft.parse` 失败 → 新增 `pickDraftFields`。
  2. `versions` 对不存在的 Agent 不报错 → 先 `recordOf`。
  3. `session-manager.prompt()` 在 `markInterrupted` 之前捕获运行句柄，崩溃残留运行会被当成新运行 → 调整顺序。
  4. `agent-host/host.ts` 的 `hasTools` 曾在注册计划工具之后计算，导致计划工具让“有工具”恒为真并忽略 MCP 工具 → 移到注册计划工具之前。
  5. 构建回归：`fflate` 被打进共享 chunk 后与 electron-vite 注入的 `require` 垫片冲突（`Identifier 'require' has already been declared`），应用无法启动、全部 e2e 超时 → 按 koffi 先例把 `fflate` 列进 `apps/desktop` 依赖（外置），构建与 e2e 恢复。
- 验证：
  - `pnpm format:check`：通过。
  - `pnpm typecheck`：通过。
  - `pnpm lint`：通过。
  - `pnpm check:i18n`：通过。
  - `pnpm test:coverage`：通过，四项均 ≥ 95%。
  - `pnpm build`：通过。
  - `pnpm e2e`：28 项全部通过。
- 关键决策与差异：
  - 定义校验的上下文（工具、MCP、Skills、模型清单）由主进程注入，`packages/core` 不读文件、不连 MCP。
  - 发布时把草稿字段写入 `agent_versions`，草稿表只保留草稿；删除只允许从未出现在 `run.created` 中的 Agent。
  - `agent.effectiveConfig` 只做合并与估算，不真正调用模型。
- 已知问题：无。
