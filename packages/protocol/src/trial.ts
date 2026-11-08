import { z } from 'zod'
import { AgentDraftRef, Id, Timestamp } from './common.js'

/** 一次试运行（M4-12）：普通会话的隐藏子集，引用 Agent 草稿而不是已发布版本。 */
export const TrialSummary = z.object({
  sessionId: Id,
  agent: AgentDraftRef,
  projectPath: z.string().min(1),
  title: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type TrialSummary = z.infer<typeof TrialSummary>

export const TrialStarted = z.object({
  sessionId: Id,
  agent: AgentDraftRef,
  draftHash: Id,
  useAgentPermissions: z.boolean(),
})
export type TrialStarted = z.infer<typeof TrialStarted>
