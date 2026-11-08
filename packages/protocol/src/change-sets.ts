/**
 * 改动集（M4-09，ADR-0031，多 Agent 协作 §7.3）：隔离工作区里子运行产生的文件级改动。
 *
 - 一个改动集对应一次委派：记录基线提交（父工作区在委派时刻的检查点）与子运行改动的文件；
 - 审阅时按文件接受或拒绝；合并前主工作区会先建检查点，因此合并可以回退；
 - 冲突：主工作区在基线之后改过同一个路径时，文件标记为 `conflict`，由用户选择保留哪一方；
 - 二进制与过大的文件只记录元数据（`binary` / `large`），不把内容放进模型上下文。
 */
import { z } from 'zod'
import { Id, Timestamp } from './common.js'

/** 改动集的整体状态。 */
export const ChangeSetStatus = z.enum(['pending', 'applied', 'rejected'])
export type ChangeSetStatus = z.infer<typeof ChangeSetStatus>

/** 改动集中单个文件的状态。 */
export const ChangeSetFileStatus = z.enum(['pending', 'accepted', 'rejected', 'conflict', 'manual'])
export type ChangeSetFileStatus = z.infer<typeof ChangeSetFileStatus>

/** 相对基线的文件变化类型。 */
export const ChangeSetFileKind = z.enum(['added', 'modified', 'removed'])
export type ChangeSetFileKind = z.infer<typeof ChangeSetFileKind>

/** 冲突的处理方式：保留主工作区、采用子运行版本，或交给用户手动处理。 */
export const ChangeSetConflictResolution = z.enum(['keep-main', 'take-child', 'manual'])
export type ChangeSetConflictResolution = z.infer<typeof ChangeSetConflictResolution>

/** 改动集中的一个文件。 */
export const ChangeSetFileInfo = z.object({
  /** 相对工作区根目录的路径，`/` 分隔。 */
  path: z.string().min(1),
  status: ChangeSetFileStatus,
  kind: ChangeSetFileKind,
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** 文本文件的 unified diff；二进制或过大的文件没有。 */
  patch: z.string().optional(),
  /** 二进制文件：只记录元数据，不提供 diff。 */
  binary: z.boolean(),
  /** 过大的文件：只记录元数据，不提供 diff。 */
  large: z.boolean(),
})
export type ChangeSetFileInfo = z.infer<typeof ChangeSetFileInfo>

/** 改动集详情。 */
export const ChangeSetInfo = z.object({
  changeSetId: Id,
  sessionId: Id,
  /** 产生改动的子运行 id。 */
  runId: Id,
  /** 父运行 id；事件与界面按它归属。 */
  parentRunId: Id.optional(),
  /** 基线提交：父工作区在委派时刻的检查点。 */
  baseCommit: z.string().min(1),
  /** 基线快照的创建时间；旧数据没有这个字段。 */
  baseCreatedAt: Timestamp.optional(),
  status: ChangeSetStatus,
  createdAt: Timestamp,
  /** 合并完成时间。 */
  mergedAt: Timestamp.optional(),
  /** 合并前在主工作区创建的检查点；恢复它即可回退这次合并。 */
  checkpointCommit: z.string().optional(),
  files: z.array(ChangeSetFileInfo),
  /** 处于 `conflict` 的文件数。 */
  conflicts: z.number().int().nonnegative(),
})
export type ChangeSetInfo = z.infer<typeof ChangeSetInfo>

/** 改动集列表项：不带文件明细。 */
export const ChangeSetSummary = z.object({
  changeSetId: Id,
  runId: Id,
  parentRunId: Id.optional(),
  status: ChangeSetStatus,
  createdAt: Timestamp,
  /** 基线快照的创建时间；旧数据没有这个字段。 */
  baseCreatedAt: Timestamp.optional(),
  mergedAt: Timestamp.optional(),
  /** 文件数。 */
  files: z.number().int().nonnegative(),
  /** 冲突文件数。 */
  conflicts: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
})
export type ChangeSetSummary = z.infer<typeof ChangeSetSummary>

/** 应用改动集的结果：合并了哪些文件，哪些文件冲突。 */
export const ChangeSetApplyResult = z.object({
  changeSet: ChangeSetInfo,
  /** 已合并的路径。 */
  applied: z.array(z.string()),
  /** 冲突的路径（没有写入主工作区）。 */
  conflicts: z.array(z.string()),
})
export type ChangeSetApplyResult = z.infer<typeof ChangeSetApplyResult>
