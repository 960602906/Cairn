/**
 * 目标模式（ADR-0047）：可验证的完成条件、判定结果与判定证据。
 *
 * 目标是会话级持久状态（`goal.*` 事件），不是 `PromptMode`，也不改变权限。
 * 判定由主进程的独立辅助补全完成，宿主只接收当前目标的提示词片段。
 */
import { z } from 'zod'
import { DurationMs, Id } from './common.js'

/** 目标条件的最大字符数。超过时命令层拒绝，不发送给模型。 */
export const GOAL_CONDITION_MAX = 4_000
/** 判定理由与暂停 / 结束说明的最大字符数。 */
export const GOAL_REASON_MAX = 2_000
/** 一次判定最多引用的证据条数。 */
export const GOAL_EVIDENCE_MAX = 20
/** 目标轮次预算的默认值与上限。 */
export const GOAL_MAX_TURNS_DEFAULT = 20
export const GOAL_MAX_TURNS_LIMIT = 100
/** 目标活动时长预算的默认值与上限（2 小时 / 24 小时）。 */
export const GOAL_MAX_DURATION_MS_DEFAULT = 2 * 60 * 60 * 1_000
export const GOAL_MAX_DURATION_MS_LIMIT = 24 * 60 * 60 * 1_000

/** 独立判定者的结论：达成、未达成、条件不可满足。 */
export const GoalVerdict = z.enum(['met', 'not_met', 'impossible'])
export type GoalVerdict = z.infer<typeof GoalVerdict>

/**
 * 暂停原因。暂停保留目标与预算，用户可恢复；与结束原因分开。
 * `turn_failed` 也用于宿主崩溃（detail 区分）。
 */
export const GoalPauseReason = z.enum([
  'user',
  'restart',
  'interrupted',
  'plan_mode',
  'turn_failed',
  'limit_reached',
  'judge_error',
  'stalled',
  'archive',
  'rewind',
  'project_removed',
])
export type GoalPauseReason = z.infer<typeof GoalPauseReason>

/** 结束原因。结束后不能恢复，要重新开始需新建目标。 */
export const GoalEndReason = z.enum(['met', 'impossible', 'user', 'budget'])
export type GoalEndReason = z.infer<typeof GoalEndReason>

/** 写入 `goal.created` 的是解析后的实际预算，不是“缺省时再说”。 */
export const GoalLimits = z.object({
  maxTurns: z.number().int().min(1).max(GOAL_MAX_TURNS_LIMIT),
  maxDurationMs: DurationMs.max(GOAL_MAX_DURATION_MS_LIMIT),
})
export type GoalLimits = z.infer<typeof GoalLimits>

/** 判定引用的一条证据；`ref` 必须出现在本次证据包里。 */
export const GoalEvidence = z.object({
  /** tool:<toolCallId> / file:<path> / message:<messageId> / turn:<turnId> / judge:<n>。 */
  kind: z.enum(['tool', 'file', 'message', 'turn', 'judge']),
  ref: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
})
export type GoalEvidence = z.infer<typeof GoalEvidence>

/** `host.prompt` 里的当前目标；`turn` 从 1 起，便于系统提示词写“第 N / 上限轮”。 */
export const ActiveGoal = z.object({
  goalId: Id,
  condition: z.string().min(1).max(GOAL_CONDITION_MAX),
  limits: GoalLimits,
  turn: z.number().int().positive(),
})
export type ActiveGoal = z.infer<typeof ActiveGoal>
