/**
 * 团队模板（M7-09，多 Agent 协作 §15）：草稿、发布与试运行。
 *
 * 试运行复用 Agent 试运行的基础设施：一个标记为 `trial` 的隐藏会话，默认只读，不出现在
 * `session.list`、活动中心与用量统计里。区别只在于它以**团队模板的草稿**为准：
 *
 * - 模板草稿要先通过 `validateAgentTeam`（与发布同一套规则）；
 * - 会话以主控 Agent 的草稿运行，模板的委派覆盖与协作说明在解析根定义时并入；
 * - 会话记录模板与草稿哈希，模板之后又改过时界面（未来）可以提示重启。
 */
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { applyTeamToAgentDefinition, validateAgentTeam } from '@cairn/core'
import {
  AgentTeam,
  RpcError,
  TeamDraft,
  type AgentDefinition,
  type AgentTeamDetail,
  type AgentTeamSummary,
  type AgentTeamVersionSummary,
  type SessionTeamBinding,
  type TeamDraftFields,
  type TeamDraftInput,
  type TeamTrialStarted,
  type TeamTrialSummary,
} from '@cairn/protocol'
import type { SessionRecord, Storage } from '@cairn/storage'
import type { AgentService } from './agent-service.js'
import type { SessionEventService } from './event-service.js'
import type { SessionManager, SessionTeamResolution } from './session-manager.js'
import type { TrialService } from './trial-service.js'

/** 每个模板保留的试运行条数。 */
export const TEAM_TRIAL_RETENTION = 10

export const TeamErrorCode = {
  NotFound: 'team.not_found',
  NoDraft: 'team.no_draft',
  Invalid: 'team.invalid',
} as const

export interface TeamServiceOptions {
  readonly storage: Pick<Storage, 'teams' | 'sessions' | 'projects'>
  readonly events: Pick<SessionEventService, 'publish' | 'readAfter'>
  readonly agents: Pick<AgentService, 'get' | 'trialDraft'>
  readonly sessions: Pick<SessionManager, 'isBusy' | 'refreshTeam'>
  readonly trials: Pick<TrialService, 'markElevated'>
  readonly createId?: () => string
  readonly now?: () => number
}

/** 界面可调用的团队模板命令。 */
export interface TeamCommands {
  list(input: { includeArchived?: boolean | undefined }): { teams: AgentTeamSummary[] }
  get(input: { teamId: string; version?: number | undefined }): AgentTeamDetail
  versions(input: { teamId: string }): { versions: AgentTeamVersionSummary[] }
  saveDraft(input: { definition: TeamDraftInput }): AgentTeamDetail
  publish(input: { teamId: string }): AgentTeamDetail
  archive(input: { teamId: string }): AgentTeamDetail
  unarchive(input: { teamId: string }): AgentTeamDetail
  trialStart(input: {
    teamId: string
    projectPath: string
    useAgentPermissions?: boolean | undefined
  }): TeamTrialStarted
  trialClear(input: { teamId: string }): { cleared: number }
  trialList(input: { teamId: string }): { trials: TeamTrialSummary[] }
}

export interface TeamService extends TeamCommands {
  /**
   * 普通会话可以选用的模板：需已发布、未归档，且主控 Agent 有已发布版本。
   * 返回会话要记下的绑定信息与运行使用的主控引用；不可用时返回 undefined。
   */
  resolveTeam(teamId: string): SessionTeamResolution | undefined
  /** 把会话绑定的团队并入这一轮使用的定义（试运行用草稿，普通会话用最新的已发布版本）。 */
  applySessionTeam(sessionId: string, definition: AgentDefinition): AgentDefinition
}

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    )
  }
  return value
}

/** 模板草稿的内容哈希：字段相同即哈希相同，与保存顺序无关。 */
export const teamDraftHash = (fields: TeamDraftFields): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalJson(fields)))
    .digest('hex')

export function createTeamService(options: TeamServiceOptions): TeamService {
  const { storage, events, agents, sessions, trials } = options
  const createId = options.createId ?? randomUUID
  const now = options.now ?? Date.now

  const requireRecord = (teamId: string) => {
    const record = storage.teams.get(teamId)
    if (!record) throw new RpcError(TeamErrorCode.NotFound, { teamId })
    return record
  }

  const publishedOf = (teamId: string, version?: number): AgentTeam | undefined => {
    const versions = storage.teams.versions(teamId)
    const wanted =
      version === undefined ? versions.at(-1) : versions.find((v) => v.version === version)
    return wanted ? AgentTeam.parse(wanted.definition) : undefined
  }

  const draftOf = (teamId: string): TeamDraft | undefined => {
    const record = storage.teams.get(teamId)
    if (!record || record.draft === undefined) return undefined
    return TeamDraft.parse(record.draft)
  }

  /** 普通会话最近一次选用的模板；取消选用或从未选过时返回 undefined。 */
  const latestTeamBinding = (sessionId: string): SessionTeamBinding | undefined => {
    let binding: SessionTeamBinding | undefined
    for (const event of events.readAfter(sessionId, 0)) {
      if (event.type === 'session.team.changed') binding = event.payload.team
    }
    return binding
  }

  /** 校验上下文：按 id 取最新的已发布 Agent（含内置）；不存在时返回 `undefined`。 */
  const validationContext = {
    agent: (agentId: string): AgentDefinition | undefined => {
      try {
        return agents.get({ agentId }).published
      } catch {
        return undefined
      }
    },
  }

  const validate = (fields: TeamDraftFields) => validateAgentTeam(fields, validationContext)

  const summaryOf = (
    teamId: string,
    fields: TeamDraftFields,
    draft: TeamDraft | undefined,
    published: AgentTeam | undefined,
  ): AgentTeamSummary => {
    const record = storage.teams.get(teamId)!
    return {
      teamId,
      name: fields.name,
      description: fields.description,
      pattern: fields.pattern,
      coordinator: fields.coordinator,
      memberCount: fields.members.length,
      archived: record.archived,
      status: published ? 'published' : 'draft',
      version: published?.version ?? 0,
      hasDraft: draft !== undefined,
      updatedAt: record.updatedAt,
    }
  }

  const detailOf = (teamId: string, version?: number): AgentTeamDetail => {
    const record = requireRecord(teamId)
    const draft = draftOf(teamId)
    const published = publishedOf(teamId, version)
    if (version !== undefined && !published) {
      throw new RpcError(TeamErrorCode.NotFound, { teamId, version })
    }
    const fields = draft ?? published
    if (!fields) throw new RpcError(TeamErrorCode.NotFound, { teamId })
    return {
      teamId,
      archived: record.archived,
      ...(draft ? { draft } : {}),
      ...(published ? { published } : {}),
      validation: validate(fields),
    }
  }

  /** 模板的试运行会话；只会返回带主控草稿哈希的记录（旧记录可能没有）。 */
  const trialsOf = (teamId: string): SessionRecord[] =>
    storage.sessions
      .list({ includeTrial: true })
      .filter(
        (session) =>
          session.kind === 'trial' &&
          session.trialTeamId === teamId &&
          session.trialAgentId !== undefined &&
          session.trialDraftHash !== undefined,
      )

  const prune = (teamId: string): void => {
    for (const trial of trialsOf(teamId).slice(TEAM_TRIAL_RETENTION)) {
      if (sessions.isBusy(trial.sessionId)) continue
      storage.sessions.remove(trial.sessionId)
    }
  }

  const startTrial = (
    teamId: string,
    projectPath: string,
    useAgentPermissions: boolean,
  ): TeamTrialStarted => {
    if (!isAbsolute(projectPath)) {
      throw new RpcError('rpc.invalid_params', { projectPath })
    }
    requireRecord(teamId)
    const fields = draftOf(teamId)
    if (!fields) throw new RpcError(TeamErrorCode.NoDraft, { teamId })
    const validation = validate(fields)
    if (!validation.ok) {
      throw new RpcError(TeamErrorCode.Invalid, {
        teamId,
        issues: validation.errors.map((entry) => entry.code).join(','),
      })
    }
    const coordinator = agents.trialDraft(fields.coordinator)
    const project =
      storage.projects.getByPath(projectPath) ??
      storage.projects.create({
        projectId: createId(),
        name: basename(projectPath),
        path: projectPath,
      })
    const sessionId = createId()
    const at = now()
    const hash = teamDraftHash(fields)
    storage.sessions.create({
      sessionId,
      projectId: project.projectId,
      workspacePath: project.path,
      title: '',
      kind: 'trial',
      trialAgentId: fields.coordinator,
      trialDraftHash: coordinator.draftHash,
      trialTeamId: teamId,
      trialTeamDraftHash: hash,
    })
    events.publish([
      {
        v: 1,
        sessionId,
        runId: sessionId,
        ts: at,
        type: 'session.created',
        payload: {
          projectId: project.projectId,
          projectPath: project.path,
          workspacePath: project.path,
          title: '',
        },
      },
    ])
    if (useAgentPermissions) trials.markElevated(sessionId)
    prune(teamId)
    return {
      sessionId,
      teamId,
      teamDraftHash: hash,
      agent: { id: fields.coordinator, draftHash: coordinator.draftHash },
      useAgentPermissions,
    }
  }

  return {
    list({ includeArchived = false }) {
      // 只有被外部直接创建、既没有草稿也没有已发布版本的空记录会被跳过。
      const teams = storage.teams.list().flatMap((record) => {
        if (!includeArchived && record.archived) return []
        const draft = draftOf(record.teamId)
        const published = publishedOf(record.teamId)
        const fields = draft ?? published
        return fields ? [summaryOf(record.teamId, fields, draft, published)] : []
      })
      return { teams }
    },

    get({ teamId, version }) {
      return detailOf(teamId, version)
    },

    versions({ teamId }) {
      requireRecord(teamId)
      const versions = storage.teams.versions(teamId).map((entry) => {
        const team = AgentTeam.parse(entry.definition)
        return {
          version: team.version,
          publishedAt: team.createdAt,
          name: team.name,
          description: team.description,
          pattern: team.pattern,
          memberCount: team.members.length,
        }
      })
      return { versions }
    },

    saveDraft({ definition }) {
      const { id, ...fields } = definition
      const teamId =
        id ??
        `user.team-${
          (fields.name['en-US'] ?? fields.name['zh-CN'] ?? 'team')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'team'
        }-${createId()}`
      const draft: TeamDraft = { id: teamId, ...fields }
      if (!storage.teams.get(teamId)) {
        storage.teams.create({ teamId, draft })
      } else {
        storage.teams.saveDraft(teamId, draft)
      }
      return detailOf(teamId)
    },

    publish({ teamId }) {
      const record = requireRecord(teamId)
      const fields = draftOf(teamId)
      if (!fields) throw new RpcError(TeamErrorCode.NoDraft, { teamId })
      const validation = validate(fields)
      if (!validation.ok) {
        throw new RpcError(TeamErrorCode.Invalid, {
          teamId,
          issues: validation.errors.map((entry) => entry.code).join(','),
        })
      }
      const version = (storage.teams.versions(teamId).at(-1)?.version ?? 0) + 1
      storage.teams.addVersion({
        teamId,
        version,
        definition: {
          ...fields,
          id: teamId,
          version,
          createdAt: record.createdAt,
          updatedAt: now(),
          schemaVersion: 1,
        },
      })
      storage.teams.clearDraft(teamId)
      // 已绑定这个模板的会话从下一轮起用新版本：空闲的宿主就此重建。
      sessions.refreshTeam(teamId)
      return detailOf(teamId)
    },

    archive({ teamId }) {
      requireRecord(teamId)
      storage.teams.setArchived(teamId, true)
      return detailOf(teamId)
    },

    unarchive({ teamId }) {
      requireRecord(teamId)
      storage.teams.setArchived(teamId, false)
      return detailOf(teamId)
    },

    trialStart({ teamId, projectPath, useAgentPermissions = false }) {
      return startTrial(teamId, projectPath, useAgentPermissions)
    },

    trialClear({ teamId }) {
      requireRecord(teamId)
      const trials = trialsOf(teamId)
      const busy = trials.find((trial) => sessions.isBusy(trial.sessionId))
      if (busy) throw new RpcError('run.busy', { sessionId: busy.sessionId })
      for (const trial of trials) storage.sessions.remove(trial.sessionId)
      return { cleared: trials.length }
    },

    trialList({ teamId }) {
      requireRecord(teamId)
      const trials = trialsOf(teamId).map((session) => ({
        sessionId: session.sessionId,
        teamId,
        agent: { id: session.trialAgentId!, draftHash: session.trialDraftHash! },
        projectPath: session.projectPath,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }))
      return { trials }
    },

    resolveTeam(teamId) {
      const record = storage.teams.get(teamId)
      if (!record || record.archived) return undefined
      const team = publishedOf(teamId)
      if (!team) return undefined
      const coordinator = validationContext.agent(team.coordinator)
      if (!coordinator) return undefined
      return {
        team: { teamId, name: team.name, version: team.version, pattern: team.pattern },
        coordinator: { id: coordinator.id, version: coordinator.version },
      }
    },

    applySessionTeam(sessionId, definition) {
      const session = storage.sessions.get(sessionId)
      if (!session) return definition
      if (session.kind === 'trial') {
        if (session.trialTeamId === undefined) return definition
        const fields = draftOf(session.trialTeamId)
        return fields ? applyTeamToAgentDefinition(definition, fields) : definition
      }
      if (session.kind !== 'normal') return definition
      const binding = latestTeamBinding(sessionId)
      if (binding === undefined) return definition
      // 选中的是模板这个身份，不是某一版：之后发布的修订从下一轮起生效。
      const team = publishedOf(binding.teamId)
      return team ? applyTeamToAgentDefinition(definition, team) : definition
    },
  }
}
