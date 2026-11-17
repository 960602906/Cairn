/**
 * 记忆条目（M7-04，ADR-0019）：用户可见的记忆数据，供设置页与会话信息面板管理。
 *
 * Agent 读取记忆走内部查询（`host.memory`），不经过这些协议；这里只给界面列出、编辑与删除。
 */
import { z } from 'zod'
import { Id, Timestamp } from './common.js'
import { MemoryScope } from './agents.js'

/** 单条记忆的正文上限，与 `remember` 工具一致。 */
export const MEMORY_CONTENT_MAX = 2_000

export const MemoryStatus = z.enum(['proposed', 'active'])
export type MemoryStatus = z.infer<typeof MemoryStatus>

/**
 * 一条记忆。`sessionId` 只出现在会话范围，`projectId` 只出现在项目范围；
 * `sourceRunId` / `sourceAgentId` 说明是哪次运行的哪个 Agent 写入的。
 */
export const MemoryEntry = z.object({
  memoryId: Id,
  scope: MemoryScope,
  content: z.string().min(1),
  status: MemoryStatus,
  sessionId: Id.optional(),
  projectId: Id.optional(),
  sourceRunId: Id.optional(),
  sourceAgentId: Id.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type MemoryEntry = z.infer<typeof MemoryEntry>
