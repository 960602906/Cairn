/**
 * 记忆读取（M7-02，ADR-0019）：按 Agent 声明的范围，取当前会话可读的 `active` 条目。
 *
 * 查询层就带会话与项目：会话记忆只属于这个会话，项目记忆只属于这个会话所在的项目，全局记忆谁都能读，
 * 其他项目或其他会话的条目根本查不到。`proposed` 要等用户确认，不进入模型请求。
 */
import { buildMemoryContext } from '@cairn/core'
import type { MemoryScope } from '@cairn/protocol'
import type { Storage } from '@cairn/storage'

export interface SessionMemory {
  readonly text: string
  readonly entries: number
  readonly dropped: number
  readonly truncated: boolean
}

/** 没有声明范围、会话不存在或没有可读条目时返回 undefined。 */
export function loadSessionMemory(
  storage: Pick<Storage, 'sessions' | 'memories'>,
  sessionId: string,
  scopes: readonly MemoryScope[],
): SessionMemory | undefined {
  if (scopes.length === 0) return undefined
  const session = storage.sessions.get(sessionId)
  if (!session) return undefined
  const entries = storage.memories
    .list({ sessionId, projectId: session.projectId, status: 'active' })
    .filter((entry) => scopes.includes(entry.scope))
  const built = buildMemoryContext(entries)
  if (built.text === undefined) return undefined
  return {
    text: built.text,
    entries: built.included,
    dropped: built.dropped,
    truncated: built.truncated,
  }
}
