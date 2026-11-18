# M7 记忆与团队协作验收报告

> 状态：**M7-00～M7-09 全部实施完成**。M7-00 与 M7-01 已合并到 `main`，其余任务以堆叠 PR
> 交付，按顺序合并；每个提交都有 DCO `Signed-off-by`。团队模板目前的入口是 RPC 与试运行，
> **没有模板编辑界面**，这是本轮明确的缺口，见 §5。
>
> 相关文档：[M7 计划](m7.md)、[Agent Runtime](../design/agent-runtime.md) §22、
> [多 Agent 协作](../design/multi-agent.md) §15、[Agent 管理界面](../design/agent-management-ui.md)、
> [M6 验收报告](m6-report.md)。

## 1. 结论摘要

- **记忆按范围严格隔离**：会话 / 项目 / 全局三个范围的条目互不可见，写入默认 `never`，
  开放后默认 `propose`（确认后才生效），可以显式允许自动写入；所有条目在设置页与会话信息
  面板可见、可改、可删，并记录来源。
- **记忆不进诊断包**：即使开启“包含会话正文”，诊断包也只记录条目长度；删除会话或项目时
  一并删除其记忆。
- **团队模板可版本化**：草稿、发布、版本回退与 Agent 共用一套模型，发布前校验主控能否
  委派、成员与阶段引用是否完整。
- **两种协作模式可用**：`review-loop` 让只读 maker 起草、checker 审查并多轮返工；
  `pipeline` 按依赖关系执行固定阶段，无依赖阶段并发，某阶段失败后停止后续阶段并汇总原因。
  两者都有对话内卡片与端到端用例。
- **模板可以试运行**：用草稿开一个隐藏会话，默认只读；模板的委派覆盖与协作说明并入主控
  这一轮的定义，试运行不写回任何 Agent 或模板。
- **质量门槛达标**：四项覆盖率均 ≥ 95%，format / typecheck / lint / i18n / 单测 / e2e /
  三平台 CI 全绿。

## 2. 交付与合并记录

| 任务 | PR | 分支 | 主要交付 |
|---|---|---|---|
| M7-00 质量防线与文档基线 | #190 | `test/quality-defense-and-roadmap` | 补 `ChatPanel` / `Markdown` 分支覆盖、归组 E2E、两个偶发用例稳定化、本计划 |
| M7-01 记忆存储与数据模型 | #191 | `feat/m7-01-memory-storage` | 迁移 `0018_memory-entries`、`memory_entries`、范围校验与来源记录 |
| M7-02 记忆注入 | #193 | `feat/m7-02-memory-context` | 按 Agent 的 `memory.scopes` 组装上下文、与压缩/限额共用预算 |
| M7-03 记忆写入 | #194 | `feat/m7-03-memory-write` | `remember` 工具、确认卡片、自动写入开关、来源与去重 |
| M7-04 记忆管理界面 | #195 | `feat/m7-04-memory-ui` | 设置页“记忆”分类、会话信息面板“记忆”标签、编辑与删除确认 |
| M7-05 记忆隐私与删除 | #196 | `feat/m7-05-memory-privacy` | 诊断包排除正文、级联删除、隐私说明 |
| M7-06 团队模板数据模型 | #197 | `feat/m7-06-team-model` | 迁移 `0019_agent-teams`、`AgentTeam`、`validateAgentTeam`、草稿/发布/版本存储 |
| M7-07 审查循环 | #198 | `feat/m7-07-review-loop` | `review_loop` 与 `runReviewLoop`、`team.review.*` 事件、`view.reviewLoops`、审查循环卡片 |
| M7-08 流水线 | #199 | `feat/m7-08-pipeline` | `run_pipeline` 与 `runTeamPipeline`、`team.pipeline.*`、`view.pipelineRuns`、流水线卡片 |
| M7-09 试运行与验收 | 本 PR | `feat/m7-09-team-trial` | 迁移 `0020-trial-team`、`TeamService` 与 7 个 RPC、`applyTeamToAgentDefinition`、试运行 E2E、本报告 |

M7-02～M7-09 是堆叠 PR：每个任务基于上一个任务的分支，合并时按顺序合并，PR 的 base 指向前
一个任务分支。每个任务在开 PR 前都跑了本机全量校验，并等 CI 三平台通过再开始下一个任务。

## 3. 质量门槛与证据

### 3.1 覆盖率（Windows 本机，`pnpm test:coverage`）

| 指标 | 结果 | 门槛 |
|---|---|---|
| 语句 | 97.71% | ≥ 95% |
| 分支 | 95.01% | ≥ 95% |
| 函数 | 96.97% | ≥ 95% |
| 行 | 98.73% | ≥ 95% |

测试文件 294 passed / 3 skipped；用例 4438 passed / 21 skipped。平台相关用例按
`describe.skipIf` 跳过，三个平台各自按所在平台重新统计。分支覆盖是四项里余量最小的一项，
每个任务的新增分支都自带测试，M7-00 的基线因此没有被后续任务吃掉。

### 3.2 静态检查与构建

`npx tsc -b`、`npx eslint`、`npx prettier --check .`、`pnpm check:i18n` 全绿；`pnpm build`
产出主进程、preload、renderer 与 agent-host 四份产物，构建信息取当前提交。

### 3.3 端到端用例

| 用例 | 覆盖 |
|---|---|
| `memory.spec.ts` | 记忆写入提议 → 确认 → 下一轮注入 → 删除；不跨项目 |
| `review-loop.spec.ts` | 父运行调用 `review_loop`，maker 产出、checker 通过，卡片显示结局与轮次 |
| `pipeline.spec.ts` | `build` → `check`，`check` 失败后停止后续阶段并显示跳过项与原因 |
| `team-trial.spec.ts` | 模板草稿 → 试运行 → 审查循环完成；非法模板被拒绝；版本回退后行为一致；试运行会话保持隐藏、可整体清理 |

### 3.4 CI

三个平台的 `check` job 都执行 format、typecheck、lint、`test:coverage`、`check:i18n`、build、
`smoke`、`package:dir`、`package:verify`、`smoke:packaged`，Windows 另跑打包应用 e2e，
Windows 与 Linux 跑 Playwright e2e。M7-02～M7-09 的 PR 在三平台 CI 上通过；期间修掉的问题：

- Ubuntu 无系统密钥环时 `credentials.set` 返回 `credentials.unavailable`，e2e 的
  `configureProvider` 现在把这种情况当成“没有凭据”，不再让所有 M7 用例在 Linux 上失败。
- `packages/checkpoint` 的性能用例在 Windows 上偶发超时，属于与本轮无关的抖动，重跑即可。
- macOS 偶发被基础设施取消（`CANCELLED`），重跑即可。

## 4. 验收对照

| 计划完成标准 | 证据 |
|---|---|
| 记忆在会话 / 项目 / 全局严格隔离，`propose` 或 `auto` 写入 | `packages/storage` 契约测试、`packages/core` 注入与写入测试、`memory.spec.ts` |
| 记忆条目可见、可编辑、可删除并记录来源 | `MemorySettings.test.tsx`、会话信息面板测试、`memory.spec.ts` |
| 记忆不进诊断包，删除会话/项目级联删除 | `diagnostics-service.test.ts`（含“包含会话正文”开关）、`packages/storage` 级联测试 |
| 团队模板有版本、草稿、发布与试运行 | `packages/core/src/teams.test.ts`、`team-service.test.ts`、`team-trial.spec.ts` |
| `review-loop` 多轮审查 | `packages/core/src/review-loop.test.ts`、`delegation-host.test.ts`、`review-loop.spec.ts` |
| `pipeline` 按依赖执行、失败传播 | `packages/core/src/pipeline.test.ts`、`delegation-host.test.ts`、`pipeline.spec.ts` |
| 四项覆盖率 ≥ 95%，静态检查与 e2e 全绿 | §3 |

## 5. 已知缺口与未执行项

- **团队模板没有编辑界面**：M7-06 交付了数据模型与校验，M7-09 交付了 RPC 与试运行，但
  Agents 管理页只有 Agent 的分区，没有模板的创建/编辑/版本对比界面。因此本轮验收里的
  “模板选择到 review-loop 完成”是通过 RPC 驱动的（`team-trial.spec.ts`），不是通过界面操作
  完成的。补这一块需要单独的界面任务：模板列表、成员与模式编辑、校验问题定位、版本对比与
  回退、试运行入口。
- **流水线没有可视化编排**：`pipeline` 只执行模板内的固定阶段，这是计划里明确的非目标。
- **团队试运行与 Agent 试运行共用基础设施**，但没有“模板改过草稿后提示重启”的界面提示；
  会话里记录了 `trial_team_draft_hash`，数据已具备，界面留待模板编辑任务一并做。
- **stable 发布的前置条件**（Windows/macOS 签名、法务、干净 VM 与真实更新演练）仍按 M6 报告
  §7 延期，与本轮无关，关闭前不得签发 stable。