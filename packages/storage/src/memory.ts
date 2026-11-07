/**
 * 内存存储实现，用于测试与开发。与 SQLite 实现通过同一套契约测试（`testing/store-contract.ts`）。
 */
import { isLiveEventType, type PersistedEvent, type ProviderConfig } from '@cairn/protocol'
import { checkPermissionRuleOwner, SCOPE_ORDER } from './permission-rules.js'
import {
  StorageError,
  StorageErrorCode,
  type CreateProjectInput,
  type CreateSessionInput,
  type FileChangeRecord,
  type ListSessionsOptions,
  type PermissionRuleRecord,
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
  /** 按记录顺序（Map 保持插入顺序）。 */
  changes: Map<string, FileChangeRecord>
  /** 按添加顺序。 */
  rules: Map<string, PermissionRuleRecord>
}

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    sessions: new Map(state.sessions),
    providers: state.providers,
    events: new Map([...state.events].map(([id, list]) => [id, [...list]])),
    changes: new Map(state.changes),
    rules: new Map(state.rules),
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
    changes: new Map(),
    rules: new Map(),
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
        const record: ProjectRecord = {
          ...input,
          createdAt: now(),
          readAgentsMd: true,
          enableProjectSkills: false,
        }
        s.projects.set(record.projectId, record)
        return copy(record)
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
          .filter((p) => p.removedAt === undefined)
          .sort((a, b) => b.createdAt - a.createdAt || a.projectId.localeCompare(b.projectId))
          .map((p) => copy(p))
      },
      update(projectId, patch) {
        const current = live().projects.get(projectId)
        if (!current || current.removedAt !== undefined) {
          throw new StorageError(StorageErrorCode.NotFound, { projectId })
        }
        const next: ProjectRecord = {
          ...current,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.readAgentsMd !== undefined ? { readAgentsMd: patch.readAgentsMd } : {}),
          ...(patch.enableProjectSkills !== undefined
            ? { enableProjectSkills: patch.enableProjectSkills }
            : {}),
        }
        live().projects.set(projectId, next)
        return copy(next)
      },
      remove(projectId) {
        const current = live().projects.get(projectId)
        if (!current || current.removedAt !== undefined) {
          throw new StorageError(StorageErrorCode.NotFound, { projectId })
        }
        const next: ProjectRecord = { ...current, removedAt: now() }
        live().projects.set(projectId, next)
        return copy(next)
      },
      restore(projectId) {
        const current = live().projects.get(projectId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { projectId })
        const { removedAt: _removed, ...rest } = current
        const next: ProjectRecord = rest
        live().projects.set(projectId, next)
        return copy(next)
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
      setModel: (sessionId, model) => updateSession(sessionId, { model: { ...model } }),
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

    changes: {
      create(input) {
        const s = live()
        if (!s.sessions.has(input.sessionId)) {
          throw new StorageError(StorageErrorCode.NotFound, { sessionId: input.sessionId })
        }
        if (s.changes.has(input.changeId)) {
          throw new StorageError(StorageErrorCode.Conflict, { changeId: input.changeId })
        }
        if (input.revertOf !== undefined && !s.changes.has(input.revertOf)) {
          throw new StorageError(StorageErrorCode.NotFound, { changeId: input.revertOf })
        }
        const record: FileChangeRecord = {
          ...copy(input),
          status: 'pending',
          hunks: input.hunks.map((h) => ({ ...h, status: 'pending' as const })),
          createdAt: now(),
        }
        s.changes.set(record.changeId, record)
        return copy(record)
      },
      get(changeId) {
        const record = live().changes.get(changeId)
        return record && copy(record)
      },
      list(sessionId) {
        return [...live().changes.values()].filter((c) => c.sessionId === sessionId).map(copy)
      },
      setStatus(changeId, status) {
        const s = live()
        const record = s.changes.get(changeId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { changeId })
        const next = { ...record, status, hunks: record.hunks.map((h) => ({ ...h, status })) }
        s.changes.set(changeId, next)
        return copy(next)
      },
    },

    permissionRules: {
      add(input) {
        checkPermissionRuleOwner(input)
        const s = live()
        if (input.projectId !== undefined && !s.projects.has(input.projectId)) {
          throw new StorageError(StorageErrorCode.NotFound, { projectId: input.projectId })
        }
        if (input.sessionId !== undefined) requireSession(input.sessionId)
        if (s.rules.has(input.rule.id)) {
          throw new StorageError(StorageErrorCode.Conflict, { ruleId: input.rule.id })
        }
        const record: PermissionRuleRecord = { ...copy(input), createdAt: now() }
        s.rules.set(input.rule.id, record)
        return copy(record)
      },
      get(ruleId) {
        const record = live().rules.get(ruleId)
        return record && copy(record)
      },
      list(listOptions = {}) {
        return [...live().rules.values()]
          .filter(
            (r) =>
              r.rule.scope === 'global' ||
              (r.rule.scope === 'project' && r.projectId === listOptions.projectId) ||
              (r.rule.scope === 'session' && r.sessionId === listOptions.sessionId),
          )
          .sort((a, b) => SCOPE_ORDER[a.rule.scope] - SCOPE_ORDER[b.rule.scope])
          .map(copy)
      },
      delete(ruleId) {
        if (!live().rules.delete(ruleId)) {
          throw new StorageError(StorageErrorCode.NotFound, { ruleId })
        }
      },
    },

    transaction,

    close() {
      closed = true
    },
  }
}
