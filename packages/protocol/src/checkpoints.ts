/**
 * 检查点（M1-12c；ADR-0008；架构 §11）。
 *
 * 检查点是项目影子仓库中的提交，id 即提交 id；列表由会话的 `checkpoint.created` 事件得出。
 * 恢复前先预览将改动的文件，恢复时先再建一个检查点（`before_restore`），使恢复本身可以撤销。
 */
import { z } from 'zod'
import { Id, Timestamp } from './common.js'

/** 检查点 id：完整的 Git 提交 id（SHA-1 或 SHA-256）。 */
export const CheckpointId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

export const CheckpointReason = z.enum([
  'turn_start',
  'before_command',
  'before_restore',
  'before_merge',
])
export type CheckpointReason = z.infer<typeof CheckpointReason>

/** 会话的一个检查点（一条 `checkpoint.created` 事件）。工作区没有变化时，相邻的检查点 id 可能相同。 */
export const CheckpointSummary = z.object({
  checkpointId: CheckpointId,
  reason: CheckpointReason,
  /** 事件的序号，按它排序。 */
  seq: z.number().int().nonnegative(),
  runId: Id,
  /** 创建时所在的轮次；恢复前创建的检查点没有。 */
  turnId: Id.optional(),
  createdAt: Timestamp,
})
export type CheckpointSummary = z.infer<typeof CheckpointSummary>

/** 恢复将改动的一个文件（相对工作区，`/` 分隔），状态相对于恢复后的结果。 */
export const CheckpointFileChange = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted']),
})
export type CheckpointFileChange = z.infer<typeof CheckpointFileChange>

/** 预览与恢复的结果：`before` 是恢复前创建的检查点，恢复到它即可撤销这次恢复。 */
export const CheckpointRestorePlan = z.object({
  before: CheckpointId,
  files: z.array(CheckpointFileChange),
})
export type CheckpointRestorePlan = z.infer<typeof CheckpointRestorePlan>
