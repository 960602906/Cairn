/**
 * 内存存储实现，用于测试与开发。与 SQLite 实现通过同一套契约测试（`testing/store-contract.ts`）。
 */
import {
  isLiveEventType,
  type FileChangeStatus,
  type PersistedEvent,
  type ProviderConfig,
  type BackgroundCommand,
  type BackgroundCommandOutput,
} from '@cairn/protocol'
import { checkMemoryContent, checkMemoryOwner, MEMORY_SCOPE_ORDER } from './memory-entries.js'
import { checkPermissionRuleOwner, SCOPE_ORDER } from './permission-rules.js'
import {
  StorageError,
  StorageErrorCode,
  type AddChangeSetFileInput,
  type AgentRecord,
  type AgentTeamRecord,
  type AgentTeamVersionRecord,
  type AgentVersionRecord,
  type AddRunSnapshotInput,
  type AutoFixJobRecord,
  type CreateAutoFixJobInput,
  type CreateWatchInput,
  type PullRequestWatchRecord,
  type UpdateAutoFixJobInput,
  type UpdateWatchInput,
  type ChangeSetFileRecord,
  type ChangeSetRecord,
  type CreateChangeSetInput,
  type CreateProjectInput,
  type CreateSessionInput,
  type FileChangeRecord,
  type ListSessionsOptions,
  type McpServerRecord,
  type MemoryEntryRecord,
  type McpToolPref,
  type PermissionRuleRecord,
  type ProjectRecord,
  type RunSnapshotRecord,
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
  /** 按提议顺序。 */
  memories: Map<string, MemoryEntryRecord>
  /** 键为 scope、source、name。 */
  skillPrefs: Map<string, SkillPref>
  mcpServers: Map<string, McpServerRecord>
  /** 键为 serverId、name。 */
  mcpToolPrefs: Map<string, McpToolPref>
  agents: Map<string, AgentRecord>
  /** 键为 agentId；值按版本号升序。 */
  agentVersions: Map<string, AgentVersionRecord[]>
  teams: Map<string, AgentTeamRecord>
  /** 键为 teamId；值按版本号升序。 */
  teamVersions: Map<string, AgentTeamVersionRecord[]>
  /** 按 snapshotId；列表按创建顺序与插入顺序。 */
  runSnapshots: Map<string, RunSnapshotRecord>
  /** 按 changeSetId；列表按创建顺序与插入顺序。 */
  changeSets: Map<string, ChangeSetRecord>
  /** 按 changeSetId → 路径 → 文件记录。 */
  changeSetFiles: Map<string, Map<string, ChangeSetFileRecord>>
  commands: Map<string, BackgroundCommand>
  commandOutputs: Map<string, BackgroundCommandOutput>
  watches: Map<string, PullRequestWatchRecord>
  autoFixJobs: Map<string, AutoFixJobRecord>
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
    memories: new Map(state.memories),
    skillPrefs: new Map(state.skillPrefs),
    mcpServers: new Map(state.mcpServers),
    mcpToolPrefs: new Map(state.mcpToolPrefs),
    agents: new Map(state.agents),
    agentVersions: new Map([...state.agentVersions].map(([id, list]) => [id, [...list]])),
    teams: new Map(state.teams),
    teamVersions: new Map([...state.teamVersions].map(([id, list]) => [id, [...list]])),
    runSnapshots: new Map(state.runSnapshots),
    changeSets: new Map(state.changeSets),
    changeSetFiles: new Map([...state.changeSetFiles].map(([id, files]) => [id, new Map(files)])),
    commands: new Map(state.commands),
    commandOutputs: new Map(state.commandOutputs),
    watches: new Map(state.watches),
    autoFixJobs: new Map(state.autoFixJobs),
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
    memories: new Map(),
    skillPrefs: new Map(),
    mcpServers: new Map(),
    mcpToolPrefs: new Map(),
    agents: new Map(),
    agentVersions: new Map(),
    teams: new Map(),
    teamVersions: new Map(),
    runSnapshots: new Map(),
    changeSets: new Map(),
    changeSetFiles: new Map(),
    commands: new Map(),
    commandOutputs: new Map(),
    watches: new Map(),
    autoFixJobs: new Map(),
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
        const { pinnedAt: currentPinnedAt, archivedAt: currentArchivedAt, ...base } = current
        const pinnedAt =
          patch.pinned === undefined ? currentPinnedAt : patch.pinned ? now() : undefined
        const archivedAt =
          patch.archived === undefined ? currentArchivedAt : patch.archived ? now() : undefined
        const next: ProjectRecord = {
          ...base,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.readAgentsMd !== undefined ? { readAgentsMd: patch.readAgentsMd } : {}),
          ...(patch.enableProjectSkills !== undefined
            ? { enableProjectSkills: patch.enableProjectSkills }
            : {}),
          ...(pinnedAt === undefined ? {} : { pinnedAt }),
          ...(archivedAt === undefined ? {} : { archivedAt }),
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
        const {
          model,
          kind,
          trialAgentId,
          trialDraftHash,
          trialTeamId,
          trialTeamDraftHash,
          ...rest
        } = input
        const record: SessionRecord = {
          ...rest,
          ...(model ? { model: { ...model } } : {}),
          kind: kind ?? 'normal',
          ...(trialAgentId === undefined ? {} : { trialAgentId }),
          ...(trialDraftHash === undefined ? {} : { trialDraftHash }),
          ...(trialTeamId === undefined ? {} : { trialTeamId }),
          ...(trialTeamDraftHash === undefined ? {} : { trialTeamDraftHash }),
          projectPath: project.path,
          archived: false,
          pinned: false,
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
          .filter((r) => listOptions.includeTrial || r.kind !== 'trial')
          .filter(
            (r) => listOptions.projectId === undefined || r.projectId === listOptions.projectId,
          )
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              b.updatedAt - a.updatedAt ||
              a.sessionId.localeCompare(b.sessionId),
          )
          .map(copy)
      },
      remove(sessionId) {
        const s = live()
        if (!s.sessions.has(sessionId)) {
          throw new StorageError(StorageErrorCode.NotFound, { sessionId })
        }
        s.sessions.delete(sessionId)
        s.events.delete(sessionId)
        for (const [changeId, change] of s.changes) {
          if (change.sessionId === sessionId) s.changes.delete(changeId)
        }
        for (const [ruleId, record] of s.rules) {
          if (record.sessionId === sessionId) s.rules.delete(ruleId)
        }
        for (const [memoryId, entry] of s.memories) {
          if (entry.sessionId === sessionId) s.memories.delete(memoryId)
        }
        for (const [snapshotId, snapshot] of s.runSnapshots) {
          if (snapshot.sessionId === sessionId) s.runSnapshots.delete(snapshotId)
        }
        for (const [changeSetId, changeSet] of s.changeSets) {
          if (changeSet.sessionId === sessionId) {
            s.changeSets.delete(changeSetId)
            s.changeSetFiles.delete(changeSetId)
          }
        }
      },
      rename: (sessionId, title) => updateSession(sessionId, { title }),
      setPinned(sessionId, pinned) {
        // 置顶不更新 updatedAt：列表顺序按置顶优先、其余按最近使用。
        const next = { ...requireSession(sessionId), pinned }
        live().sessions.set(sessionId, next)
        return copy(next)
      },
      archive: (sessionId) => updateSession(sessionId, { archived: true }),
      unarchive: (sessionId) => updateSession(sessionId, { archived: false }),
      setModel: (sessionId, model) => updateSession(sessionId, { model: { ...model } }),
      setThinkingLevel: (sessionId, thinkingLevel) => updateSession(sessionId, { thinkingLevel }),
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
        /* v8 ignore next -- create() 总会初始化版本列表，agent 存在时缺失只可能是内部状态损坏 */
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

    teams: {
      list: () => [...live().teams.values()].map(copy),
      get(teamId) {
        const record = live().teams.get(teamId)
        return record && copy(record)
      },
      create(input) {
        const s = live()
        if (s.teams.has(input.teamId)) {
          throw new StorageError(StorageErrorCode.Conflict, { teamId: input.teamId })
        }
        const at = now()
        const record: AgentTeamRecord = {
          teamId: input.teamId,
          archived: false,
          ...(input.draft === undefined ? {} : { draft: copy(input.draft) }),
          createdAt: at,
          updatedAt: at,
        }
        s.teams.set(record.teamId, record)
        s.teamVersions.set(record.teamId, [])
        return copy(record)
      },
      saveDraft(teamId, draft) {
        const s = live()
        const current = s.teams.get(teamId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { teamId })
        const next: AgentTeamRecord = { ...current, draft: copy(draft), updatedAt: now() }
        s.teams.set(teamId, next)
        return copy(next)
      },
      clearDraft(teamId) {
        const s = live()
        const current = s.teams.get(teamId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { teamId })
        const { draft: _draft, ...rest } = current
        const next: AgentTeamRecord = { ...rest, updatedAt: now() }
        s.teams.set(teamId, next)
        return copy(next)
      },
      setArchived(teamId, archived) {
        const s = live()
        const current = s.teams.get(teamId)
        if (!current) throw new StorageError(StorageErrorCode.NotFound, { teamId })
        const next: AgentTeamRecord = { ...current, archived, updatedAt: now() }
        s.teams.set(teamId, next)
        return copy(next)
      },
      remove(teamId) {
        const s = live()
        if (!s.teams.delete(teamId)) {
          throw new StorageError(StorageErrorCode.NotFound, { teamId })
        }
        s.teamVersions.delete(teamId)
      },
      versions(teamId) {
        return (live().teamVersions.get(teamId) ?? []).map(copy)
      },
      version(teamId, version) {
        const found = (live().teamVersions.get(teamId) ?? []).find(
          (item) => item.version === version,
        )
        return found && copy(found)
      },
      addVersion(input) {
        const s = live()
        if (!s.teams.has(input.teamId)) {
          throw new StorageError(StorageErrorCode.NotFound, { teamId: input.teamId })
        }
        /* v8 ignore next -- create() 总会初始化版本列表，team 存在时缺失只可能是内部状态损坏 */
        const list = s.teamVersions.get(input.teamId) ?? []
        if (list.some((item) => item.version === input.version)) {
          throw new StorageError(StorageErrorCode.Conflict, {
            teamId: input.teamId,
            version: input.version,
          })
        }
        const record: AgentTeamVersionRecord = {
          teamId: input.teamId,
          version: input.version,
          definition: copy(input.definition),
          publishedAt: now(),
        }
        const next = [...list, record].sort((a, b) => a.version - b.version)
        s.teamVersions.set(input.teamId, next)
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

    memories: {
      propose(input) {
        checkMemoryOwner(input)
        const s = live()
        if (input.sessionId !== undefined) requireSession(input.sessionId)
        if (input.projectId !== undefined && !s.projects.has(input.projectId)) {
          throw new StorageError(StorageErrorCode.NotFound, { projectId: input.projectId })
        }
        if (s.memories.has(input.memoryId)) {
          throw new StorageError(StorageErrorCode.Conflict, { memoryId: input.memoryId })
        }
        const record: MemoryEntryRecord = {
          memoryId: input.memoryId,
          scope: input.scope,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          content: input.content,
          status: 'proposed',
          ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
          ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: input.sourceAgentId }),
          createdAt: now(),
          updatedAt: now(),
        }
        s.memories.set(record.memoryId, record)
        return copy(record)
      },
      get(memoryId) {
        const record = live().memories.get(memoryId)
        return record && copy(record)
      },
      list(listOptions = {}) {
        return [...live().memories.values()]
          .filter(
            (entry) =>
              entry.scope === 'global' ||
              (entry.scope === 'project' && entry.projectId === listOptions.projectId) ||
              (entry.scope === 'session' && entry.sessionId === listOptions.sessionId),
          )
          .filter(
            (entry) => listOptions.status === undefined || entry.status === listOptions.status,
          )
          .sort(
            (a, b) =>
              MEMORY_SCOPE_ORDER[a.scope] - MEMORY_SCOPE_ORDER[b.scope] ||
              a.createdAt - b.createdAt,
          )
          .map(copy)
      },
      listAll(allOptions = {}) {
        return [...live().memories.values()]
          .filter((entry) => allOptions.scope === undefined || entry.scope === allOptions.scope)
          .filter((entry) => allOptions.status === undefined || entry.status === allOptions.status)
          .sort(
            (a, b) =>
              MEMORY_SCOPE_ORDER[a.scope] - MEMORY_SCOPE_ORDER[b.scope] ||
              a.createdAt - b.createdAt,
          )
          .map(copy)
      },
      confirm(memoryId) {
        const s = live()
        const record = s.memories.get(memoryId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { memoryId })
        if (record.status === 'active') return copy(record)
        const next: MemoryEntryRecord = { ...record, status: 'active', updatedAt: now() }
        s.memories.set(memoryId, next)
        return copy(next)
      },
      update(memoryId, content) {
        const s = live()
        const record = s.memories.get(memoryId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { memoryId })
        checkMemoryContent(content)
        const next: MemoryEntryRecord = { ...record, content, updatedAt: now() }
        s.memories.set(memoryId, next)
        return copy(next)
      },
      delete(memoryId) {
        const s = live()
        const record = s.memories.get(memoryId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { memoryId })
        s.memories.delete(memoryId)
        return copy(record)
      },
    },

    runSnapshots: {
      add(input: AddRunSnapshotInput) {
        const s = live()
        requireSession(input.sessionId)
        if (s.runSnapshots.has(input.snapshotId)) {
          throw new StorageError(StorageErrorCode.Conflict, { snapshotId: input.snapshotId })
        }
        const record: RunSnapshotRecord = { ...copy(input), createdAt: now() }
        s.runSnapshots.set(record.snapshotId, record)
        const forRun = [...s.runSnapshots.values()]
          .filter((item) => item.runId === input.runId)
          .sort((a, b) => a.createdAt - b.createdAt)
        for (const old of forRun.slice(0, Math.max(0, forRun.length - 20))) {
          s.runSnapshots.delete(old.snapshotId)
        }
        return copy(record)
      },
      list(runId, limit = 20) {
        return [...live().runSnapshots.values()]
          .filter((item) => item.runId === runId)
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, limit)
          .map(copy)
      },
    },

    changeSets: {
      create(input: CreateChangeSetInput) {
        const s = live()
        requireSession(input.sessionId)
        if (s.changeSets.has(input.changeSetId)) {
          throw new StorageError(StorageErrorCode.Conflict, { changeSetId: input.changeSetId })
        }
        const record: ChangeSetRecord = {
          changeSetId: input.changeSetId,
          sessionId: input.sessionId,
          runId: input.runId,
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          baseCommit: input.baseCommit,
          ...(input.baseCreatedAt === undefined ? {} : { baseCreatedAt: input.baseCreatedAt }),
          gitDir: input.gitDir,
          workspacePath: input.workspacePath,
          status: 'pending',
          createdAt: now(),
        }
        s.changeSets.set(record.changeSetId, record)
        s.changeSetFiles.set(record.changeSetId, new Map())
        return copy(record)
      },
      get(changeSetId) {
        const record = live().changeSets.get(changeSetId)
        return record && copy(record)
      },
      listBySession(sessionId) {
        return [...live().changeSets.values()]
          .filter((item) => item.sessionId === sessionId)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(copy)
      },
      setStatus(changeSetId, status) {
        const s = live()
        const record = s.changeSets.get(changeSetId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { changeSetId })
        const next: ChangeSetRecord = {
          ...record,
          status,
          ...(status === 'applied' ? { mergedAt: now() } : {}),
        }
        s.changeSets.set(changeSetId, next)
        return copy(next)
      },
      setCheckpointCommit(changeSetId, commit) {
        const s = live()
        const record = s.changeSets.get(changeSetId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { changeSetId })
        const next: ChangeSetRecord = { ...record, checkpointCommit: commit }
        s.changeSets.set(changeSetId, next)
        return copy(next)
      },
      addFile(input: AddChangeSetFileInput) {
        const s = live()
        if (!s.changeSets.has(input.changeSetId)) {
          throw new StorageError(StorageErrorCode.NotFound, { changeSetId: input.changeSetId })
        }
        const files = s.changeSetFiles.get(input.changeSetId)!
        if (files.has(input.path)) {
          throw new StorageError(StorageErrorCode.Conflict, {
            changeSetId: input.changeSetId,
            path: input.path,
          })
        }
        const record: ChangeSetFileRecord = {
          changeSetId: input.changeSetId,
          path: input.path,
          status: 'pending',
          kind: input.kind,
          added: input.added,
          removed: input.removed,
          ...(input.patch === undefined ? {} : { patch: input.patch }),
          binary: input.binary,
          large: input.large,
          ...(input.baseHash === undefined ? {} : { baseHash: input.baseHash }),
          ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
        }
        files.set(record.path, record)
        return copy(record)
      },
      listFiles(changeSetId) {
        const files = live().changeSetFiles.get(changeSetId)
        if (!files) return []
        return [...files.values()]
          .sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))
          .map(copy)
      },
      setFileStatus(changeSetId, path, status) {
        const s = live()
        const files = s.changeSetFiles.get(changeSetId)
        if (!files) throw new StorageError(StorageErrorCode.NotFound, { changeSetId })
        const record = files.get(path)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { changeSetId, path })
        const next: ChangeSetFileRecord = { ...record, status }
        files.set(path, next)
        return copy(next)
      },
    },

    commands: {
      create(record) {
        requireSession(record.sessionId)
        if (live().commands.has(record.commandId)) {
          throw new StorageError(StorageErrorCode.Conflict, { commandId: record.commandId })
        }
        live().commands.set(record.commandId, copy(record))
        return copy(record)
      },
      get(commandId) {
        const record = live().commands.get(commandId)
        return record && copy(record)
      },
      list() {
        return [...live().commands.values()].sort((a, b) => b.startedAt - a.startedAt).map(copy)
      },
      finish(commandId, status, exitCode, endedAt) {
        const record = live().commands.get(commandId)
        if (!record) throw new StorageError(StorageErrorCode.NotFound, { commandId })
        const next = { ...record, status, exitCode, endedAt }
        live().commands.set(commandId, next)
        return copy(next)
      },
      saveOutput(commandId, output) {
        if (!live().commands.has(commandId))
          throw new StorageError(StorageErrorCode.NotFound, { commandId })
        live().commandOutputs.set(commandId, copy(output))
      },
      output(commandId) {
        const result = live().commandOutputs.get(commandId)
        return result && copy(result)
      },
    },

    autoFix: {
      watches: {
        list: () =>
          [...live().watches.values()]
            .sort((a, b) => a.createdAt - b.createdAt || a.watchId.localeCompare(b.watchId))
            .map(copy),
        get(watchId) {
          const record = live().watches.get(watchId)
          return record && copy(record)
        },
        findByPullRequest(repo, prNumber) {
          const record = [...live().watches.values()].find(
            (item) => item.repo === repo && item.prNumber === prNumber,
          )
          return record && copy(record)
        },
        create(input: CreateWatchInput) {
          const s = live()
          const duplicate = [...s.watches.values()].some(
            (item) =>
              item.watchId === input.watchId ||
              (item.repo === input.repo && item.prNumber === input.prNumber),
          )
          if (duplicate) {
            throw new StorageError(StorageErrorCode.Conflict, {
              watchId: input.watchId,
              repo: input.repo,
              prNumber: input.prNumber,
            })
          }
          const record: PullRequestWatchRecord = {
            ...input,
            triggers: [...input.triggers],
            enabled: true,
            attempts: 0,
            createdAt: now(),
          }
          s.watches.set(record.watchId, record)
          return copy(record)
        },
        update(watchId, patch: UpdateWatchInput) {
          const s = live()
          const current = s.watches.get(watchId)
          if (!current) throw new StorageError(StorageErrorCode.NotFound, { watchId })
          const { lastSignature, triggers, ...rest } = patch
          const { lastSignature: _previous, ...base } = current
          const next: PullRequestWatchRecord = {
            ...base,
            ...rest,
            ...(triggers === undefined ? {} : { triggers: [...triggers] }),
            ...(typeof lastSignature === 'string' ? { lastSignature } : {}),
          }
          s.watches.set(watchId, next)
          return copy(next)
        },
        remove(watchId) {
          const s = live()
          if (!s.watches.has(watchId)) {
            throw new StorageError(StorageErrorCode.NotFound, { watchId })
          }
          s.watches.delete(watchId)
          for (const [jobId, job] of s.autoFixJobs) {
            if (job.watchId === watchId) s.autoFixJobs.delete(jobId)
          }
        },
      },
      jobs: {
        create(input: CreateAutoFixJobInput) {
          const s = live()
          if (!s.watches.has(input.watchId)) {
            throw new StorageError(StorageErrorCode.NotFound, { watchId: input.watchId })
          }
          if (s.autoFixJobs.has(input.jobId)) {
            throw new StorageError(StorageErrorCode.Conflict, { jobId: input.jobId })
          }
          const at = now()
          const record: AutoFixJobRecord = { ...input, createdAt: at, updatedAt: at }
          s.autoFixJobs.set(record.jobId, record)
          return copy(record)
        },
        update(jobId, patch: UpdateAutoFixJobInput) {
          const s = live()
          const current = s.autoFixJobs.get(jobId)
          if (!current) throw new StorageError(StorageErrorCode.NotFound, { jobId })
          const { detail, ...rest } = patch
          const { detail: _previous, ...base } = current
          const next: AutoFixJobRecord = {
            ...base,
            ...rest,
            ...(typeof detail === 'string' ? { detail } : {}),
            updatedAt: now(),
          }
          s.autoFixJobs.set(jobId, next)
          return copy(next)
        },
        get(jobId) {
          const record = live().autoFixJobs.get(jobId)
          return record && copy(record)
        },
        getBySession(sessionId) {
          const record = [...live().autoFixJobs.values()]
            .filter((job) => job.sessionId === sessionId)
            .sort((a, b) => b.createdAt - a.createdAt)[0]
          return record && copy(record)
        },
        list(options = {}) {
          return [...live().autoFixJobs.values()]
            .filter((job) => options.watchId === undefined || job.watchId === options.watchId)
            .sort((a, b) => b.createdAt - a.createdAt || b.jobId.localeCompare(a.jobId))
            .slice(0, options.limit ?? 100)
            .map(copy)
        },
        activeForWatch(watchId) {
          const record = [...live().autoFixJobs.values()]
            .filter((job) => job.watchId === watchId)
            .sort((a, b) => b.createdAt - a.createdAt)
            .find((job) => job.status === 'queued' || job.status === 'running')
          return record && copy(record)
        },
        interruptActive() {
          const s = live()
          let count = 0
          for (const [jobId, job] of s.autoFixJobs) {
            if (job.status !== 'queued' && job.status !== 'running') continue
            s.autoFixJobs.set(jobId, {
              ...job,
              status: 'failed',
              detail: 'interrupted',
              updatedAt: now(),
            })
            count++
          }
          return count
        },
      },
    },

    transaction,

    backup() {
      throw new Error('memory storage does not support backup')
    },

    close() {
      closed = true
    },
  }
}
