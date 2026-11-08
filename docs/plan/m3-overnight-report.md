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
| M3-09 MCP 后端 | 完成 | `ec26cf2` | 覆盖率、build、完整 e2e 通过 |
| M3-10 设置页“MCP 服务” | 完成 | `2ec809c` | 17 个组件用例、e2e、截图 |
| M3-11 自定义 Agent 后端 | 完成 | `226f795` | 覆盖率四项 ≥ 95%，build/e2e 通过 |
| M3-12 Agents 页面与 Agent 选择器 | 完成 | `77a23c7` | 单测/组件测试、e2e、深浅色截图 |
| M3-13 诊断包 | 完成 | `4e14507` | fflate 打包、脱敏单测、导出弹窗、e2e |
| M3-14 收尾与验收 | 完成 | `f81bfd1` | 全流程 e2e、ADR-0027/0028、架构文档 §22-24、M4 规划 |

## 3. 决策与假设

- 无人值守模式优先于 `grill-me` 技能的交互式提问：规格有歧义时按文档与 ADR 选保守方案，并记录在本报告。

## 4. 阻塞

（暂无）

## 5. 断点与完成度

- M3-09 ～ M3-14 全部任务的实现、测试与文档已完成，分支已推送并开出草稿 PR：<https://github.com/960602906/Cairn/pull/111>。
- 最终 gate（2026-11-08 晨）：`pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm check:i18n`、`pnpm check:licenses`、`pnpm test:coverage`、`pnpm build`、`pnpm e2e`、`$env:CAIRN_PERF='1'; pnpm test:perf`、`pnpm smoke` 全部通过。
- 覆盖率：语句 97.52%、分支 95.1%、函数 96.83%、行 98.54%（门槛 95%）。
- 测试：173 个文件通过 / 2 跳过，2488 个用例通过 / 19 跳过。
- e2e：31 项全部通过（`apps/desktop`，Windows 本机）。
- 无新增依赖；`pnpm check:licenses` 通过。

### CI 修复（2026-11-08）

- **现象**：PR #111 的 `check (windows-latest)` 在 `pnpm test:coverage` 阶段失败，报
  `ENOENT: no such file or directory, open 'C:\tmp\test-diag.zip'`；`ubuntu-latest` 与 `licenses` 通过。
- **原因**：`apps/desktop/src/main/services/diagnostics-service.test.ts` 的导出用例把保存路径硬编码为
  `C:\tmp\test-diag.zip`。本机恰好存在 `C:\tmp`，GitHub Windows runner 上不存在。
- **修复**：`f7f365a` 用 `mkdtempSync(join(tmpdir(), 'cairn-diag-'))` 创建真实临时目录，导出后断言
  文件非空并在 `finally` 中清理；不再依赖任何固定盘符路径。
- **验证**：本地重跑该用例（15 项通过）、`pnpm format:check`、`pnpm typecheck`、`pnpm lint`、
  `pnpm check:i18n`、`pnpm test:coverage`（四项 97.52% / 95.1% / 96.83% / 98.54%）、`pnpm build`、
  `pnpm e2e`（31 项）全部通过；CI run
  [42431186270](https://github.com/960602906/Cairn/actions/runs/42431186270) 三个作业全部成功
  （ubuntu 2m36s、windows 6m49s、licenses 14s）。

### 最新修复与就绪状态（2026-11-08 晨间交接）

1. **全流程 e2e 工具名对齐（M3-14）**：
   - `apps/desktop/e2e/m3-full-flow.spec.ts`：将 mock 模型与测试断言中的 `mcp_fixture_echo` 全面更新为 `mcp_flowfixture_echo`（共 3 处），严格匹配 `uniqueToolName('FlowFixture', 'echo')` 生成规则。
2. **Agent 编辑器发布状态显示（M3-12）**：
   - `apps/desktop/src/renderer/agents/AgentEditor.tsx`：状态徽标逻辑完善，发布后未修改时明确展示 `已发布`（绿色徽标），解决 `agents.spec.ts` 对 `getByText('已发布')` 的断言等待。
3. **诊断服务脱敏测试真实路径清零（M3-13）**：
   - `apps/desktop/src/main/services/diagnostics-service.test.ts`：全面清查并替换所有真实用户名路径为测试假路径（`C:\Users\alice`），完全符合硬约束。
4. **截图确认（M3-10 / M3-12 / M3-13）**：
   - 经 `view_image` 工具逐项核验，`C:\opt\cursor\artifacts` 目录下 4 组深浅色截图均已真实存在：
     - `mcp-settings-light.png` / `mcp-settings-dark.png`
     - `agents-page-light.png` / `agents-page-dark.png`
     - `agents-editor-light.png` / `agents-editor-dark.png`
     - `diagnostics-dialog-light.png` / `diagnostics-dialog-dark.png`
5. **全流程 e2e 的 mock 脚本按轮次驱动（M3-14）**：
   - `apps/desktop/scripts/mock-model.js` 新增 `toolCallsByPrompt`：按最后一条用户消息（取最长匹配键）选择本轮脚本，并在本轮内按已发生的工具调用次数推进。原 `toolCalls` 的全局顺序行为保持不变。
   - 修复了“同一用户轮里连续触发 write_file、MCP 与 propose_plan”的测试设计缺陷；批准计划后的步骤标题消息用独立脚本调用 `update_plan_step`，再从右侧栏完整计划确认“已完成”。

### 建议的晨间验收步骤与接管指南

1. **运行验证 Gate**：
   ```powershell
   pnpm format:check
   pnpm typecheck
   pnpm lint
   pnpm check:i18n
   pnpm test:coverage
   pnpm build
   pnpm e2e
   $env:CAIRN_PERF='1'; pnpm test:perf
   pnpm smoke
   ```
2. **提交与推送（已在无人值守会话内执行）**：见 §7 的真实 commit。
3. **草稿 PR**：
   ```powershell
   git push origin codex/m3-overnight-20261107
   gh pr create --draft --base main --title "feat: M3 阶段完整交付（MCP 服务、自定义 Agent 与脱敏诊断包）" --body "详见 docs/plan/m3-overnight-report.md"
   ```
4. **[用户本地] 真实模型与真实 MCP 服务验收项（待本地人工验证）**：
   - 启动本地 Ollama（或配置真实 OpenAI / DeepSeek API Key），新建会话确认多轮对话正常；
   - 连接本地真实 MCP 服务（如 SQLite、Filesystem），触发模型调用并核验审批弹窗与工具输出；
   - 导出诊断包 `.zip`，解压检查日志脱敏与 `settings.json` 脱敏效果。

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

### M3-14 收尾与验收

- 状态：完成。
- 主要改动：
  - 端到端全流程测试（`apps/desktop/e2e/m3-full-flow.spec.ts`）：
    - Skill 安装与启用；
    - MCP 服务连接（基于 `packages/mcp/src/testing/fixture-server.mjs` stdio echo 服务）；
    - 复制内置 `builtin.coder` 创建自定义 Agent，修改指令并发布新版本；
    - 在会话中通过 Agent 选择器选用新 Agent；
    - 第一轮交互：模型触发 `write_file`，经权限审批通过并验证按块撤销能力；
    - 第二轮交互：模型调用 MCP 工具 `mcp_flowfixture_echo`（服务名 `FlowFixture` + 工具 `echo`），弹出审批卡片并确认回传；
    - 第三轮交互：开启计划模式，只读生成多步骤方案，用户确认后按步骤执行；
    - 长对话自动化上下文压缩：超过上下文预算后触发压缩，在消息流展示带摘要的折叠分隔线并维持历史连贯；
    - 退出与清理：移除测试 MCP 服务，校验环境复原。
  - 架构文档与 ADR 补齐：
    - `docs/architecture.md`：增加 §22（诊断包导出与脱敏规范）、§23（自定义 Agent 架构、配置合并与运行态切换）、§24（界面 Agents 管理与选择器设计）；
    - `docs/adr/0027-context-compaction.md`：长会话滑动窗口与摘要压缩方案；
    - `docs/adr/0028-custom-agents.md`：自定义 Agent 存储模型、草稿/多版本状态机及运行时权限限额合并。
  - M4 计划草稿（`docs/plan/m4.md`）：
    - 梳理从 M3 顺延或新增的高级能力：跨会话长期记忆（Memory Store）、任务执行树与子 Agent 编排、插件市场生态接入与开发者套件。
- 验证状态：
  - `pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm check:i18n`：通过。
  - `pnpm test:coverage`：173 文件通过 / 2 跳过，2488 用例通过 / 19 跳过；语句 97.52%、分支 95.08%、函数 96.83%、行 98.54%。
  - `pnpm build`：通过。
  - `pnpm e2e`：31 项全部通过。
  - `$env:CAIRN_PERF='1'; pnpm test:perf`：通过。
  - `pnpm smoke`：通过（fake 与 pi 两种宿主）。
  - 测试基础设施：`apps/desktop/scripts/mock-model.js` 新增 `toolCallsByPrompt`，按最后一条用户消息（取最长匹配键）选择本轮工具脚本并在轮内推进；修复了「同一用户轮连续触发多个工具」的测试设计缺陷。批准计划后运行时以步骤标题作为新的用户消息，测试用独立脚本调用 `update_plan_step`，并从右侧栏完整计划确认「已完成」。
  - 真实模型本地验收项（`[用户本地]`）已在验收指引中列出，待用户启动应用后验证。

### M3-12 Agents 页面与 Agent 选择器

- 状态：完成。
- 主要改动：
  - 侧栏新增 Agents 入口（Bot 图标，保留活动入口隐藏）；`App.tsx` 增加 `agents` 页面分支。
  - Agents 页面壳（`AgentsView.tsx`）：列表 ↔ 编辑器状态切换，处理“从空白开始 / 复制编程助手”创建流。
  - 列表页（`AgentsPage.tsx`）：卡片列表（图标、名称、描述、来源、版本、状态）、分类筛选（全部/内置/自定义/草稿/已归档）、中英文搜索与空状态引导。
  - 编辑器（`AgentEditor.tsx`）：8 个分区导航（基本信息、指令、模型、能力、权限、限额、上下文、记忆）、未保存/警告/错误标记、Ctrl+S 保存草稿、离开未保存确认、发布确认弹窗、指令 token 估算。内置仅支持复制；归档支持复制/导出/取消归档；可编辑草稿支持保存/发布/复制/导出/归档。
  - 版本历史（`AgentVersions.tsx`）：版本列表、任意两版本结构化字段对比与指令 diff、恢复为草稿。
  - 生效配置预览（`AgentEffectiveConfig.tsx`）：调用 `agent.effectiveConfig`，展示合并后的指令、工具、Skills、权限、限额与上下文预算条形图。
  - 输入框选择器（`AgentPicker.tsx`）：最近使用排前、搜索、快捷键 Ctrl+. 打开；固定模型联动禁用模型下拉并提示“由 Agent 固定”。
  - 消息流（`MessageStream.tsx`）：会话切换 Agent 在消息流插入“已切换到 X vN”分隔线；多 Agent 会话中在助手回复前显示 Agent 徽标；`ChatPanel.tsx` 挂载时刷新 Agent 列表。
  - i18n：`agents.json` 中英完整补齐；`session.json` 补充 `sidebar.agents`、`composer.model.fixedByAgent`、`composer.agent.*`、`chat.agentSwitched`。
  - 测试：新增 `model.test.ts`、`AgentAvatar.test.tsx`、`AgentsPage.test.tsx`、`AgentEditor.test.tsx`、`AgentVersions.test.tsx`、`AgentEffectiveConfig.test.tsx`、`AgentPicker.test.tsx`，补充 `session-store.test.ts` 与 `shortcuts.test.ts`；新增 `e2e/agents.spec.ts` 并输出浅/深色截图至 `/opt/cursor/artifacts/`。
- 关键决策与修复：
  - 新草稿首次保存后在组件内部维护 `currentId`，避免后续保存生成新 Agent。
  - 区分内置只读（仅复制）与归档只读（允许取消归档）。
  - 合并 `Composer.tsx` 中的类型导入，并将 `agent` prop 设为可选以兼容现有组件测试。
  - `draftFieldsOf` 类型扩展支持 `AgentDraftFields | AgentDefinition`。
- 截图：`C:\opt\cursor\artifacts\agents-page-{light,dark}.png`、`agents-editor-{light,dark}.png`。

### M3-13 诊断包

- 状态：完成。
- 主要改动：
  - 主进程服务 `apps/desktop/src/main/services/diagnostics-service.ts`：利用 `fflate` 纯 JS 进行 zip 压缩，提供 `summary`、`createZipBuffer`、`export`、`showInFolder`。
  - 严格脱敏：`sanitizeText` 替换用户主目录真实路径为 `~`，替换 `sk-*`、`ghp_*`、`xoxb-*`、`Bearer` 等格式的 API Key 与 Token 为 `[REDACTED]`；设置摘要仅保留安全字段；会话事件默认剔除消息正文和文件内容，勾选后才导出脱敏正文。
  - 界面与入口：`DiagnosticsExportDialog.tsx` 弹窗展示导出清单、会话敏感内容开关与导出状态；`GeneralSettings.tsx` 通用设置底部增加“导出诊断包”入口；`ErrorBanner.tsx` 错误横幅中增加“导出诊断包”快捷入口并携带当前会话。
  - i18n：`settings.json` 与 `common.json` 补充诊断包中英文文案。
  - 测试：新增 `diagnostics-service.test.ts`（严格解压断言 zip 文件列表与无泄漏真实路径/Key）、`DiagnosticsExportDialog.test.tsx`（组件测试）；新增 `e2e/diagnostics.spec.ts` 并保存截图。
- 关键决策与差异：
  - 使用已外置的 `fflate` 依赖，不增加额外包，避免构建 chunk 打包冲突。
  - 诊断包中固定输出 `manifest.json`、`app-version.json`、`settings-summary.json`、`logs/main.log`、`logs/host.log`，有会话时输出 `session/events.json`。
- 截图：`C:\opt\cursor\artifacts\diagnostics-dialog-{light,dark}.png`。

### M3-10 设置页“MCP 服务”

- 状态：完成。
- 主要改动：
  - `apps/desktop/src/renderer/settings/McpSettings.tsx`：列表、添加 / 编辑表单、详情（工具类别与默认权限、连接日志、重新连接、编辑、删除）、删除确认。
  - `SettingsPage.tsx` 新增“能力 → MCP 服务”分区；`session-store.ts` 增加 `mcp.*` 方法与 `mcp.status` 订阅。
  - i18n：`settings.json` 新增 `section.mcp.*` 与约 60 条 `mcp.*` 文案；`errors.json` 新增 `mcp.*` 错误码（中英同步）。
  - 组件测试 `McpSettings.test.tsx`（17 个用例）；e2e `mcp-settings.spec.ts` 用真实 stdio 服务覆盖添加、连接失败与删除，并输出浅 / 深色截图。
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


## 7. 提交记录（真实 hash）

| 任务 | 提交 |
|---|---|
| M3-09 MCP 后端 | `ec26cf2` feat(mcp): MCP 后端 [M3-09] |
| M3-10 设置页“MCP 服务” | `2ec809c` feat(settings): MCP 服务设置页 [M3-10] |
| M3-10 补测（日志与 Esc 关闭） | `fa60bd3` test(settings): 补 MCP 设置页日志与 Esc 关闭用例 [M3-10] |
| M3-11 自定义 Agent 后端 | `226f795` feat(agents): 自定义 Agent 后端 [M3-11] |
| M3-12 Agents 页面与选择器 | `77a23c7` feat(agents): Agents 页面与选择器 [M3-12] |
| M3-13 诊断包 | `4e14507` feat(diagnostics): 诊断包导出与脱敏 [M3-13] |
| M3-13 CI 修复 | `f7f365a` test(diagnostics): 诊断包导出用例改用系统临时目录 [M3-13] |
| M3-14 收尾与验收 | `f81bfd1` docs(m3): M3 全流程验收、架构文档与 M4 计划草稿 [M3-14] |

共享接线说明：`main/index.ts`、`renderer-gateway*`、`protocol/contracts/renderer-main.ts`、
`protocol/index.ts`、`session-store.ts`、`i18n/resources.ts` 同时承载 M3-12 与 M3-13，
按“保证每个提交可构建”的原则，RPC 接线随 M3-12 提交，诊断服务实现与其 RPC 处理器随 M3-13 提交。


