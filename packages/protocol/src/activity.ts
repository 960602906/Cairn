/**
 * 活动中心（M4-06，管理界面 §9，ADR-0032）。
 *
 * 活动中心只有一个数据来源：主进程按需读取未决审批、事件日志与运行状态。这里只定义界面看到的只读
 * 结构；不引入新的事件类型，也不保存第二份运行状态。
 */
import { z } from 'zod'
import { AgentDefinitionRef, Id, RunMode, Timestamp } from './common.js'
import { ToolCategory } from './permissions.js'

/** 跨会话的未决审批：审批本身仍由审批服务持有，这里只补上会话标题与请求时间。 */
export const ActivityApproval = z.object({
  approvalId: Id,
  sessionId: Id,
  sessionTitle: z.string(),
  runId: Id,
  parentRunId: Id.optional(),
  agent: AgentDefinitionRef,
  toolName: z.string().min(1),
  toolCategory: ToolCategory,
  kind: z.enum(['tool', 'no_checkpoint']),
  /** 工具、目标或预览的简短摘要；已脱敏，不含消息正文。 */
  summary: z.string(),
  reasonCode: z.string().min(1),
  matchedRuleIds: z.array(Id),
  requestedAt: Timestamp,
})
export type ActivityApproval = z.infer<typeof ActivityApproval>

/** 正在执行的会话（以顶层运行状态为准）；等待审批的会话只出现在审批段。 */
export const ActivityRunning = z.object({
  sessionId: Id,
  sessionTitle: z.string(),
  runId: Id,
  agent: AgentDefinitionRef,
  mode: RunMode,
  state: z.enum(['thinking', 'tooling', 'awaiting_children', 'aborting']),
  /** 最近一条用户输入的简短摘要；没有时为空串。 */
  summary: z.string(),
  /** 当前步骤或工具名称；没有时省略。 */
  step: z.string().optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
})
export type ActivityRunning = z.infer<typeof ActivityRunning>

export const ActivityCompletedStatus = z.enum(['completed', 'failed', 'aborted', 'limit_reached'])
export type ActivityCompletedStatus = z.infer<typeof ActivityCompletedStatus>

/** 最近完成的轮次；保留数量由主进程限制。 */
export const ActivityCompleted = z.object({
  sessionId: Id,
  sessionTitle: z.string(),
  runId: Id,
  turnId: Id.optional(),
  agent: AgentDefinitionRef,
  status: ActivityCompletedStatus,
  summary: z.string(),
  completedAt: Timestamp,
  /** 这一轮里最近一个子运行产生的改动集；没有改动集时省略。 */
  changeSetId: Id.optional(),
})
export type ActivityCompleted = z.infer<typeof ActivityCompleted>

export const ActivityCounts = z.object({
  approvals: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
})
export type ActivityCounts = z.infer<typeof ActivityCounts>

export const ActivityListResult = z.object({
  approvals: z.array(ActivityApproval),
  running: z.array(ActivityRunning),
  completed: z.array(ActivityCompleted),
  counts: ActivityCounts,
})
export type ActivityListResult = z.infer<typeof ActivityListResult>

/** 活动中心可就地作出的决定（M4-06）：允许一次、本会话始终允许、拒绝。 */
export const ActivityDecision = z.enum(['allow_once', 'allow_session', 'deny'])
export type ActivityDecision = z.infer<typeof ActivityDecision>
