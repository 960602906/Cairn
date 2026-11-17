/** 两个存储实现共用的记忆条目检查（M7-01，ADR-0019）。 */
import type { MemoryScope } from '@cairn/protocol'
import { StorageError, StorageErrorCode, type ProposeMemoryInput } from './types.js'

/**
 * 范围与归属必须一一对应：会话记忆属于一个会话，项目记忆属于一个项目，全局记忆不属于任何一方。
 * 内容不能为空（只含空白字符也不行），避免写入一条读不出任何信息的记忆。
 */
export function checkMemoryOwner(input: ProposeMemoryInput): void {
  const { scope, projectId, sessionId, content } = input
  const consistent =
    scope === 'global'
      ? projectId === undefined && sessionId === undefined
      : scope === 'project'
        ? projectId !== undefined && sessionId === undefined
        : sessionId !== undefined && projectId === undefined
  if (!consistent || content.trim().length === 0) {
    throw new StorageError(StorageErrorCode.InvalidRecord, { memoryId: input.memoryId, scope })
  }
}

/** 编辑内容时的检查；编辑不改变范围与归属。 */
export function checkMemoryContent(content: string): void {
  if (content.trim().length === 0) {
    throw new StorageError(StorageErrorCode.InvalidRecord, { field: 'content' })
  }
}

/** 列表顺序：会话、项目、全局（M7-02 的上下文组装按这个顺序追加）。 */
export const MEMORY_SCOPE_ORDER: Readonly<Record<MemoryScope, number>> = {
  session: 0,
  project: 1,
  global: 2,
}
