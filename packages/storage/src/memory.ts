/**
 * 内存存储实现，用于测试与开发。与 SQLite 实现通过同一套契约测试（`testing/store-contract.ts`）。
 */
import { isLiveEventType, type PersistedEvent, type ProviderConfig } from '@nexus/protocol'
import {
  StorageError,
  StorageErrorCode,
  type CreateProjectInput,
  type CreateSessionInput,
  type ListSessionsOptions,
  type ProjectRecord,
  type SessionRecord,
  type Storage,
  type StorageOptions,
} from './types.js'

interface State {
  projects: Map<string, ProjectRecord>
  sessions: Map<string, SessionRecord>
  providers: ProviderConfig[]
  events: Map<string, PersistedEvent[]>
}

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    sessions: new Map(state.sessions),
    providers: state.providers,
    events: new Map([...state.events].map(([id, list]) => [id, [...list]])),
  }
}

/** 记录与事件在存入和读出时都复制，调用方修改返回值不会影响存储内容。 */
function copy<T>(value: T): T {
  return structuredClone(value)
}

export function createMemoryStorage(options: StorageOptions = {}): Storage {
  const now = options.now ?? Date.now
  let state: State = {
    projects: new Map(),
    sessions: new Map(),
    providers: [],
    events: new Map(),
  }
  let closed = false

  const live = (): State => {
    if (closed) throw new Error('storage is closed')
    return state
  }

  const requireSession = (sessionId: string): SessionRecord => {
    const session = live().sessions.get(sessionId)
    if (!session) throw new StorageError(StorageErrorCode.NotFound, { sessionId })
    return session
  }

  const updateSession = (sessionId: string, patch: Partial<SessionRecord>): SessionRecord => {
    const next = { ...requireSession(sessionId), ...patch, updatedAt: now() }
    live().sessions.set(sessionId, next)
    return copy(next)
  }

  const transaction = <T>(fn: () => T): T => {
    const snapshot = cloneState(live())
    try {
      return fn()
    } catch (error) {
      state = snapshot
      throw error
    }
  }

  return {
    projects: {
      create(input: CreateProjectInput) {
        const s = live()
        if (s.projects.has(input.projectId)) {
          throw new StorageError(StorageErrorCode.Conflict, { projectId: input.projectId })
        }
        if ([...s.projects.values()].some((p) => p.path === input.path)) {
          throw new StorageError(StorageErrorCode.Conflict, { path: input.path })
        }
        const record: ProjectRecord = { ...input, createdAt: now() }
        s.projects.set(record.projectId, record)
        return { ...record }
      },
      get(projectId) {
        const record = live().projects.get(projectId)
        return record && { ...record }
      },
      getByPath(path) {
        const record = [...live().projects.values()].find((p) => p.path === path)
        return record && { ...record }
      },
      list() {
        return [...live().projects.values()]
          .sort((a, b) => b.createdAt - a.createdAt || a.projectId.localeCompare(b.projectId))
          .map((p) => ({ ...p }))
      },
    },

    sessions: {
      create(input: CreateSessionInput) {
        const s = live()
        const project = s.projects.get(input.projectId)
        if (!project)
          throw new StorageError(StorageErrorCode.NotFound, { projectId: input.projectId })
        if (s.sessions.has(input.sessionId)) {
          throw new StorageError(StorageErrorCode.Conflict, { sessionId: input.sessionId })
        }
        const at = now()
        const { model, ...rest } = input
        const record: SessionRecord = {
          ...rest,
          ...(model ? { model: { ...model } } : {}),
          projectPath: project.path,
          archived: false,
          createdAt: at,
          updatedAt: at,
        }
        s.sessions.set(record.sessionId, record)
        return copy(record)
      },
      get(sessionId) {
        const record = live().sessions.get(sessionId)
        return record && copy(record)
      },
      list(listOptions: ListSessionsOptions = {}) {
        return [...live().sessions.values()]
          .filter((r) => listOptions.includeArchived || !r.archived)
          .filter(
            (r) => listOptions.projectId === undefined || r.projectId === listOptions.projectId,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
          .map(copy)
      },
      rename: (sessionId, title) => updateSession(sessionId, { title }),
      archive: (sessionId) => updateSession(sessionId, { archived: true }),
      touch: (sessionId) => updateSession(sessionId, {}),
    },

    providers: {
      list: () => copy(live().providers),
      get(providerId) {
        const config = live().providers.find((p) => p.id === providerId)
        return config && copy(config)
      },
      replaceAll(configs) {
        const s = live()
        const seen = new Set<string>()
        for (const config of configs) {
          if (seen.has(config.id)) {
            throw new StorageError(StorageErrorCode.Conflict, { providerId: config.id })
          }
          seen.add(config.id)
        }
        s.providers = copy([...configs])
      },
    },

    events: {
      append(events) {
        transaction(() => {
          const s = live()
          for (const event of events) {
            if (isLiveEventType(event.type)) {
              throw new StorageError(StorageErrorCode.InvalidEvent, {
                type: event.type,
                seq: event.seq,
              })
            }
            if (!s.sessions.has(event.sessionId)) {
              throw new StorageError(StorageErrorCode.InvalidEvent, { sessionId: event.sessionId })
            }
            const list = s.events.get(event.sessionId) ?? []
            const last = list.at(-1)?.seq ?? 0
            if (event.seq <= last) {
              throw new StorageError(StorageErrorCode.SeqConflict, {
                sessionId: event.sessionId,
                after: last,
                actual: event.seq,
              })
            }
            list.push(copy(event))
            s.events.set(event.sessionId, list)
          }
        })
      },
      readAfter(sessionId, afterSeq, limit) {
        const list = live().events.get(sessionId) ?? []
        // seq 严格递增但可能有空缺
        const after = list.filter((e) => e.seq > afterSeq)
        return (limit === undefined ? after : after.slice(0, Math.max(0, limit))).map(copy)
      },
      maxSeq(sessionId) {
        return live().events.get(sessionId)?.at(-1)?.seq ?? 0
      },
    },

    transaction,

    close() {
      closed = true
    },
  }
}
