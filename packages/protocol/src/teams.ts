/**
 * 团队模板（M7-06，多 Agent 协作 §15，ADR-0020、ADR-0029）。
 *
 * 模板把常用的协作方式打包：一个主控 Agent（`coordinator`）、可被委派的成员（`members`）
 * 与协作模式（`delegate` / `review-loop` / `pipeline`）。与 Agent 一样有草稿、已发布版本与
 * 归档；校验规则在 `@cairn/core` 的 `validateAgentTeam`，这里只管数据形状。
 */
import { z } from 'zod'
import { LocalizedText } from './agents.js'
import { AgentDraftRef, Id, Timestamp } from './common.js'
import { DelegationPolicy } from './delegation.js'

/** 协作模式。`delegate` 由主控自由分派；`review-loop` 与 `pipeline` 由运行时固定编排。 */
export const TeamPattern = z.enum(['delegate', 'review-loop', 'pipeline'])
export type TeamPattern = z.infer<typeof TeamPattern>

export const TEAM_MAX_MEMBERS = 50
export const TEAM_MAX_PIPELINE_STAGES = 20
/** 审查循环的轮次上限：再多只会烧预算，收益很低。 */
export const TEAM_MAX_REVIEW_ROUNDS = 10

/** pipeline 的一个固定阶段：`agent` 执行，`dependsOn` 引用同一模板里的阶段 id。 */
export const TeamPipelineStage = z
  .object({
    stage: Id,
    agent: Id,
    dependsOn: z.array(Id).max(TEAM_MAX_PIPELINE_STAGES).optional(),
  })
  .strict()
export type TeamPipelineStage = z.infer<typeof TeamPipelineStage>

/** review-loop：maker 产出，checker 审查，最多 `maxRounds` 轮。 */
export const TeamReviewLoop = z
  .object({
    maker: Id,
    checker: Id,
    maxRounds: z.number().int().min(1).max(TEAM_MAX_REVIEW_ROUNDS),
  })
  .strict()
export type TeamReviewLoop = z.infer<typeof TeamReviewLoop>

const draftFields = {
  name: LocalizedText,
  description: LocalizedText,
  /** 主控 Agent：实际运行以它为根运行，它必须启用委派。 */
  coordinator: Id,
  /** 可被委派的 Agent；不含主控自身。 */
  members: z.array(Id).max(TEAM_MAX_MEMBERS),
  pattern: TeamPattern,
  pipeline: z.array(TeamPipelineStage).max(TEAM_MAX_PIPELINE_STAGES).optional(),
  reviewLoop: TeamReviewLoop.optional(),
  /** 模板对委派策略的覆盖；省略的字段沿用主控 Agent 的设置。 */
  delegation: DelegationPolicy.partial().optional(),
} as const

/** 草稿字段（不含 id 与时间戳）。 */
export const TeamDraftFields = z.object(draftFields).strict()
export type TeamDraftFields = z.infer<typeof TeamDraftFields>

/** 已保存的草稿。 */
export const TeamDraft = z.object({ id: Id, ...draftFields }).strict()
export type TeamDraft = z.infer<typeof TeamDraft>

/** 保存草稿的输入：新模板可以不给 id。 */
export const TeamDraftInput = z.object({ id: Id.optional(), ...draftFields }).strict()
export type TeamDraftInput = z.infer<typeof TeamDraftInput>

/** 已发布的某个版本。 */
export const AgentTeam = z
  .object({
    id: Id,
    version: z.number().int().positive(),
    ...draftFields,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
  })
  .strict()
export type AgentTeam = z.infer<typeof AgentTeam>

export const AgentTeamSummary = z.object({
  teamId: Id,
  name: LocalizedText,
  description: LocalizedText,
  pattern: TeamPattern,
  coordinator: Id,
  memberCount: z.number().int().nonnegative(),
  archived: z.boolean(),
  /** 从未发布过的模板是 `draft`。 */
  status: z.enum(['draft', 'published']),
  /** 最新的已发布版本；从未发布为 0。 */
  version: z.number().int().nonnegative(),
  hasDraft: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
})
export type AgentTeamSummary = z.infer<typeof AgentTeamSummary>

/** 校验问题：`path` 指向字段，`code` 由界面翻译。 */
export const TeamValidationIssue = z.object({
  path: z.string().min(1),
  code: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})
export type TeamValidationIssue = z.infer<typeof TeamValidationIssue>

export const TeamValidationResult = z.object({
  ok: z.boolean(),
  errors: z.array(TeamValidationIssue),
  warnings: z.array(TeamValidationIssue),
})
export type TeamValidationResult = z.infer<typeof TeamValidationResult>

/** 一份模板的当前状态：草稿优先，已发布版本用于对比与会话选择。 */
export const AgentTeamDetail = z.object({
  teamId: Id,
  archived: z.boolean(),
  draft: TeamDraft.optional(),
  published: AgentTeam.optional(),
  validation: TeamValidationResult,
})
export type AgentTeamDetail = z.infer<typeof AgentTeamDetail>

export const AgentTeamVersionSummary = z.object({
  version: z.number().int().positive(),
  publishedAt: z.number().int().nonnegative(),
  name: LocalizedText,
  description: LocalizedText,
  pattern: TeamPattern,
  memberCount: z.number().int().nonnegative(),
})
export type AgentTeamVersionSummary = z.infer<typeof AgentTeamVersionSummary>

/** 一次团队试运行（M7-09）：在草稿状态开一个隐藏会话，以主控 Agent 的草稿运行。 */
export const TeamTrialStarted = z.object({
  sessionId: Id,
  teamId: Id,
  teamDraftHash: Id,
  agent: AgentDraftRef,
  useAgentPermissions: z.boolean(),
})
export type TeamTrialStarted = z.infer<typeof TeamTrialStarted>

/** 一次团队试运行的历史摘要。 */
export const TeamTrialSummary = z.object({
  sessionId: Id,
  teamId: Id,
  agent: AgentDraftRef,
  projectPath: z.string().min(1),
  title: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type TeamTrialSummary = z.infer<typeof TeamTrialSummary>
