/**
 * 文件改动记录（M1-08b；ADR-0008；架构 §11.1、§14.2）。
 *
 * 写类工具每次改动文件都留下一条记录：改动前后的内容存入内容寻址的 blob 存储（主进程写入），
 * 记录本身只保存 blob 的哈希与 diff 块。界面据此列出改动、整文件撤销（按块撤销在 M3）。
 */
import { z } from 'zod'
import { Id, Timestamp } from './common.js'

export const FileChangeKind = z.enum(['create', 'modify', 'delete'])
export type FileChangeKind = z.infer<typeof FileChangeKind>

/** pending：尚未处理；accepted：用户已确认（M3）；reverted：已撤销。 */
export const FileChangeStatus = z.enum(['pending', 'accepted', 'reverted'])
export type FileChangeStatus = z.infer<typeof FileChangeStatus>

const LineCount = z.number().int().nonnegative()

/** 一个 diff 块：改动前后的起始行（从 1 开始；行数为 0 时为插入或删除位置的前一行）与行数。 */
export const FileHunk = z.object({
  oldStart: LineCount,
  oldLines: LineCount,
  newStart: LineCount,
  newLines: LineCount,
})
export type FileHunk = z.infer<typeof FileHunk>

/** 改动内容的上限：与写类工具的 10 MiB 上限一致，base64 编码后约 14 MB。 */
export const FILE_CHANGE_MAX_BYTES = 10 * 1024 * 1024
const Base64Content = z
  .string()
  .max(Math.ceil(FILE_CHANGE_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)

/**
 * 宿主交给主进程的改动（`changes.record`）。内容用 base64 传递；
 * `create` 没有 `before`，`delete` 没有 `after`，`modify` 两者都有。
 */
export const FileChangeInput = z
  .object({
    /** 相对工作区根目录的路径，`/` 分隔。 */
    path: z.string().min(1),
    kind: FileChangeKind,
    before: Base64Content.optional(),
    after: Base64Content.optional(),
    turnId: Id.optional(),
    toolCallId: Id.optional(),
    hunks: z.array(FileHunk),
    /** 新增与删除的行数（二进制文件为 0）。 */
    added: LineCount,
    removed: LineCount,
  })
  .refine((c) => (c.kind === 'create') === (c.before === undefined), {
    message: 'before is required except for create',
    path: ['before'],
  })
  .refine((c) => (c.kind === 'delete') === (c.after === undefined), {
    message: 'after is required except for delete',
    path: ['after'],
  })
export type FileChangeInput = z.infer<typeof FileChangeInput>

/** 界面看到的改动记录（不含文件内容）。 */
export const FileChangeSummary = z.object({
  changeId: Id,
  path: z.string().min(1),
  kind: FileChangeKind,
  status: FileChangeStatus,
  turnId: Id.optional(),
  toolCallId: Id.optional(),
  /** 撤销产生的记录指向被撤销的改动。 */
  revertOf: Id.optional(),
  hunks: z.array(FileHunk),
  added: LineCount,
  removed: LineCount,
  createdAt: Timestamp,
})
export type FileChangeSummary = z.infer<typeof FileChangeSummary>
