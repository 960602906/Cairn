/**
 * 内存存储实现，用于测试与开发。与 SQLite 实现通过同一套契约测试（`testing/store-contract.ts`）。
 */
import {
  isLiveEventType,
  type FileChangeStatus,
  type PersistedEvent,
  type ProviderConfig,
} from '@cairn/protocol'
import { checkPermissionRuleOwner, SCOPE_ORDER } from './permission-rules.js'
import {
  StorageError,
  StorageErrorCode,
  type AgentRecord,
  type AgentVersionRecord,
  type CreateProjectInput,
  type CreateSessionInput,
  type FileChangeRecord,
  type ListSessionsOptions,
  type McpServerRecord,
  type McpToolPref,
  type PermissionRuleRecord,
  type ProjectRecord,
  type SessionRecord,
  type SkillPref,
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
  /** 键为 scope、source、name。 */
  skillPrefs: Map<string, SkillPref>
  mcpServers: Map<string, McpServerRecord>
  /** 键为 serverId、name。 */
  mcpToolPrefs: Map<string, McpToolPref>
  agents: Map<string, AgentRecord>
  /** 键为 agentId；值按版本号升序。 */
  agentVersions: Map<string, AgentVersionRecord[]>
}

const prefKey = (scope: string, source: string, name: string) => `${scope}\0${source}\0${name}`
const mcpToolKey = (serverId: string, name: string) => `${serverId}\0${name}`

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    sessions: new Map(state.sessions),
    providers: state.providers,
    events: new Map([...state.events].map(([id, list]) => [id, [...list]])),
    changes: new Map(state.changes),
    rules: new Map(state.rules),
    skillPrefs: new Map(state.skillPrefs),
    mcpServers: new Map(state.mcpServers),
    mcpToolPrefs: new Map(state.mcpToolPrefs),
    agents: new Map(state.agents),
    agentVersions: new Map([...state.agentVersions].map(([id, list]) => [id, [...list]])),
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
    skillPrefs: new Map(),
    mcpServers: new Map(),
    mcpToolPrefs: new Map(),
    agents: new Map(),
    agentVersions: new Map(),
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
          enableProjectSkills: true,
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
      setHunkStatus(changeId, hunkIndex, status) {
        const s = live()
        const record = s.changes.get(changeId)
        const hunk = record?.hunks[hunkIndex]
        if (!record || !Number.isInteger(hunkIndex) || hunkIndex < 0 || !hunk) {
          throw new StorageError(StorageErrorCode.NotFound, { changeId, hunkIndex })
        }
        const hunks = record.hunks.map((item, index) =>
          index === hunkIndex ? { ...item, status } : item,
        )
        const allReverted = hunks.every((item) => item.status === 'reverted')
        const nextStatus: FileChangeStatus = allReverted
          ? 'reverted'
          : record.status === 'reverted'
            ? 'pending'
            : record.status
        const next = { ...record, status: nextStatus, hunks }
        s.changes.set(changeId, next)
        return copy(next)
      },
    },

    skillPrefs: {
      get(scope, source, name) {
        const pref = live().skillPrefs.get(prefKey(scope, source, name))
        return pref && copy(pref)
      },
      list(scope) {
        return [...live().skillPrefs.values()].filter((pref) => pref.scope === scope).map(copy)
      },
      set(pref) {
        const record = copy(pref)
        live().skillPrefs.set(prefKey(pref.scope, pref.source, pref.name), record)
        return copy(record)
      },
      delete(scope, source, name) {
        live().skillPrefs.delete(prefKey(scope, source, name))
      },
    },

    mcpServers: {
      list: () => [...live().mcpServers.values()].map(copy),
      get(serverId) {
        const record = live().mcpServers.get(serverId)
        return record && copy(record)
      },
      create(input) {
        const s = live()
        if (s.mcpServers.has(input.serverId)) {
          throw new StorageError(StorageErrorCode.Conflict, { serverId: input.serverId })
        }
        const at = now()
        const record: McpServerRecord = {
          serverId: input.serverId,
          name: input.name,
          kind: input.kind,
          ...(input.command === undefined ? {} : { command: input.command }),
          args: [...(input.args ?? [])],
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.url === undefined ? {} : { url: input.url }),
          auth: input.auth ?? 'none',
          ...(input.headerName === undefined ? {} : { headerName: input.headerName }),
          ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
          env: copy([...(input.env ?? [])]),
          enabled: input.enabled !== false,
          createdAt: at,
          updatedAt: at,
        }
        s.mcpServers.set(record.serverId, record)
        return copy(record)
      },
      update(serverId, patch) {
        const s = live()
        const current = s.mcpServers.get(serverId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { serverId })
        const next: McpServerRecord = {
          ...current,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.kind === undefined ? {} : { kind: patch.kind }),
          ...(patch.command === undefined
            ? {}
            : patch.command === null
              ? { command: undefined }
              : { command: patch.command }),
          ...(patch.args === undefined ? {} : { args: [...patch.args] }),
          ...(patch.cwd === undefined
            ? {}
            : patch.cwd === null
              ? { cwd: undefined }
              : { cwd: patch.cwd }),
          ...(patch.url === undefined
            ? {}
            : patch.url === null
              ? { url: undefined }
              : { url: patch.url }),
          ...(patch.auth === undefined ? {} : { auth: patch.auth }),
          ...(patch.headerName === undefined
            ? {}
            : patch.headerName === null
              ? { headerName: undefined }
              : { headerName: patch.headerName }),
          ...(patch.credentialRef === undefined
            ? {}
            : patch.credentialRef === null
              ? { credentialRef: undefined }
              : { credentialRef: patch.credentialRef }),
          ...(patch.env === undefined ? {} : { env: copy([...patch.env]) }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          updatedAt: now(),
        }
        s.mcpServers.set(serverId, next)
        return copy(next)
      },
      remove(serverId) {
        const s = live()
        if (!s.mcpServers.delete(serverId)) {
          throw new StorageError(StorageErrorCode.NotFound, { serverId })
        }
        for (const [key, pref] of s.mcpToolPrefs) {
          if (pref.serverId === serverId) s.mcpToolPrefs.delete(key)
        }
      },
    },

    mcpToolPrefs: {
      get(serverId, name) {
        const pref = live().mcpToolPrefs.get(mcpToolKey(serverId, name))
        return pref && copy(pref)
      },
      list(serverId) {
        return [...live().mcpToolPrefs.values()]
          .filter((pref) => pref.serverId === serverId)
          .map(copy)
      },
      set(pref) {
        const s = live()
        if (!s.mcpServers.has(pref.serverId)) {
          throw new StorageError(StorageErrorCode.NotFound, { serverId: pref.serverId })
        }
        const record = copy(pref)
        s.mcpToolPrefs.set(mcpToolKey(pref.serverId, pref.name), record)
        return copy(record)
      },
      deleteForServer(serverId) {
        const s = live()
        for (const [key, pref] of s.mcpToolPrefs) {
          if (pref.serverId === serverId) s.mcpToolPrefs.delete(key)
        }
      },
    },

    agents: {
      list: () => [...live().agents.values()].map(copy),
      get(agentId) {
        const record = live().agents.get(agentId)
        return record && copy(record)
      },
      create(input) {
        const s = live()
        if (s.agents.has(input.agentId)) {
          throw new StorageError(StorageErrorCode.Conflict, { agentId: input.agentId })
        }
        const at = now()
        const record: AgentRecord = {
          agentId: input.agentId,
          source: input.source,
          archived: false,
          ...(input.draft === undefined ? {} : { draft: copy(input.draft) }),
          createdAt: at,
          updatedAt: at,
        }
        s.agents.set(record.agentId, record)
        s.agentVersions.set(record.agentId, [])
        return copy(record)
      },
      saveDraft(agentId, draft) {
        const s = live()
        const current = s.agents.get(agentId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { agentId })
        const next: AgentRecord = { ...current, draft: copy(draft), updatedAt: now() }
        s.agents.set(agentId, next)
        return copy(next)
      },
      clearDraft(agentId) {
        const s = live()
        const current = s.agents.get(agentId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { agentId })
        const { draft: _draft, ...rest } = current
        const next: AgentRecord = { ...rest, updatedAt: now() }
        s.agents.set(agentId, next)
        return copy(next)
      },
      setArchived(agentId, archived) {
        const s = live()
        const current = s.agents.get(agentId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { agentId })
        const next: AgentRecord = { ...current, archived, updatedAt: now() }
        s.agents.set(agentId, next)
        return copy(next)
      },
      remove(agentId) {
        const s = live()
        if (!s.agents.delete(agentId)) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId })
        }
        s.agentVersions.delete(agentId)
      },
      versions(agentId) {
        const list = live().agentVersions.get(agentId) ?? []
        return list.map(copy)
      },
      version(agentId, version) {
        const found = (live().agentVersions.get(agentId) ?? []).find(
          (item) => item.version === version,
        )
        return found && copy(found)
      },
      addVersion(input) {
        const s = live()
        if (!s.agents.has(input.agentId)) {
          throw new StorageError(StorageErrorCode.NotFound, { agentId: input.agentId })
        }
        const list = s.agentVersions.get(input.agentId) ?? []
        if (list.some((item) => item.version === input.version)) {
          throw new StorageError(StorageErrorCode.Conflict, {
            agentId: input.agentId,
            version: input.version,
          })
        }
        const record: AgentVersionRecord = {
          agentId: input.agentId,
          version: input.version,
          definition: copy(input.definition),
          publishedAt: now(),
        }
        const next = [...list, record].sort((a, b) => a.version - b.version)
        s.agentVersions.set(input.agentId, next)
        return copy(record)
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
