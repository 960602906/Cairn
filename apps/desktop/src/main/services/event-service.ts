/**
 * 存储服务（M0-13a，ADR-0005，架构 §7.3、§8）：会话事件唯一的写入方。
 *
 * - 为宿主（或主进程自己）产生的事件分配 seq。每个会话一个递增计数器，持久化事件与实时增量事件
 *   共用（M0-06c 约定），因此数据库中的 seq 严格递增但可能有空缺。计数器从数据库的 `maxSeq` 起。
 * - 持久化事件在一个事务中落库（同时更新会话的 `updatedAt`），**提交成功后**才转发给订阅者；
 *   落库失败时抛出，不转发任何事件，已分配的 seq 回滚。
 * - 增量事件（`*.delta`）不落库，分配 seq 后直接转发。
 *
 * 不依赖 Electron；订阅者是 IPC 网关（M0-13b）与会话管理器。
 */
import {
  isPersistedEvent,
  type EventEnvelope,
  type PersistedEvent,
  type UnsequencedEvent,
} from '@nexus/protocol'
import { StorageError, StorageErrorCode, type Storage } from '@nexus/storage'

/** 收到某个会话新分配 seq 的事件（按 seq 升序）。 */
export type SessionEventsListener = (sessionId: string, events: readonly EventEnvelope[]) => void

export interface SessionEventService {
  /**
   * 分配 seq 并发布一组事件（可以跨会话，各会话内保持原有顺序）。返回分配了 seq 的事件。
   * 持久化事件落库失败时抛出 `StorageError`，此时不转发任何事件。
   */
  publish(events: readonly UnsequencedEvent[]): EventEnvelope[]
  /** 已持久化的事件（补发用），按 seq 升序。 */
  readAfter(sessionId: string, afterSeq: number, limit?: number): PersistedEvent[]
  /** 最近分配的 seq（含增量事件）；会话没有事件时为数据库中的 `maxSeq`，即 0。 */
  lastSeq(sessionId: string): number
  /** 订阅发布的事件，返回取消订阅的函数。订阅者在事务提交后同步调用。 */
  subscribe(listener: SessionEventsListener): () => void
}

export interface SessionEventServiceOptions {
  readonly storage: Storage
  /** 订阅者抛错时调用（默认忽略）；一个订阅者出错不影响其他订阅者与发布方。 */
  readonly onListenerError?: (error: unknown) => void
}

export function createSessionEventService(
  options: SessionEventServiceOptions,
): SessionEventService {
  const { storage, onListenerError } = options
  const counters = new Map<string, number>()
  const listeners = new Set<SessionEventsListener>()

  const counterOf = (sessionId: string): number => {
    const known = counters.get(sessionId)
    if (known !== undefined) return known
    if (!storage.sessions.get(sessionId)) {
      throw new StorageError(StorageErrorCode.InvalidEvent, { sessionId })
    }
    const initial = storage.events.maxSeq(sessionId)
    counters.set(sessionId, initial)
    return initial
  }

  const notify = (sessionId: string, events: readonly EventEnvelope[]) => {
    for (const listener of [...listeners]) {
      try {
        listener(sessionId, events)
      } catch (error) {
        onListenerError?.(error)
      }
    }
  }

  return {
    publish(input) {
      if (input.length === 0) return []
      const before = new Map<string, number>()
      const sequenced: EventEnvelope[] = []
      try {
        for (const event of input) {
          const current = counterOf(event.sessionId)
          if (!before.has(event.sessionId)) before.set(event.sessionId, current)
          const seq = current + 1
          counters.set(event.sessionId, seq)
          sequenced.push({ ...event, seq } as EventEnvelope)
        }
        const persisted = sequenced.filter(isPersistedEvent)
        if (persisted.length > 0) {
          storage.transaction(() => {
            storage.events.append(persisted)
            for (const sessionId of new Set(persisted.map((e) => e.sessionId))) {
              storage.sessions.touch(sessionId)
            }
          })
        }
      } catch (error) {
        for (const [sessionId, seq] of before) counters.set(sessionId, seq)
        throw error
      }

      const bySession = new Map<string, EventEnvelope[]>()
      for (const event of sequenced) {
        const list = bySession.get(event.sessionId)
        if (list) list.push(event)
        else bySession.set(event.sessionId, [event])
      }
      for (const [sessionId, events] of bySession) notify(sessionId, events)
      return sequenced
    },

    readAfter: (sessionId, afterSeq, limit) => storage.events.readAfter(sessionId, afterSeq, limit),

    lastSeq: (sessionId) => counters.get(sessionId) ?? storage.events.maxSeq(sessionId),

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
