import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RpcError, type AgentDefinition, type TeamDraftInput } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createSessionEventService } from './event-service.js'
import { createTeamService, TEAM_TRIAL_RETENTION, teamDraftHash } from './team-service.js'

const projectPath = path.resolve('/work/team')

const coordinator: AgentDefinition = {
  id: 'user.coordinator',
  version: 2,
  source: 'user',
  status: 'published',
  name: { 'en-US': 'Coordinator' },
  description: { 'en-US': 'Runs the team' },
  instructions: 'Coordinate.',
  model: { mode: 'inherit' },
  tools: { allow: ['read'] },
  skills: { allow: [] },
  permissions: 'read-only',
  limits: {},
  context: { includeProjectInstructions: true, compaction: 'auto' },
  memory: { scopes: ['session'], write: 'never' },
  delegation: {
    enabled: true,
    allowedAgents: ['user.maker', 'user.checker'],
    maxDepth: 1,
    maxChildrenPerTurn: 6,
    maxParallel: 2,
    childBudgetShare: 0.5,
    defaultWorkspace: 'shared',
    mergeReview: 'user',
  },
  createdAt: 1,
  updatedAt: 1,
  schemaVersion: 1,
}

const reviewer: AgentDefinition = {
  ...coordinator,
  id: 'user.checker',
  name: { 'en-US': 'Checker' },
  delegation: { ...coordinator.delegation!, enabled: false },
}

const maker: AgentDefinition = {
  ...coordinator,
  id: 'user.maker',
  name: { 'en-US': 'Maker' },
  delegation: { ...coordinator.delegation!, enabled: false },
}

const draft = (patch: Partial<TeamDraftInput> = {}): TeamDraftInput => ({
  name: { 'zh-CN': '审查小组' },
  description: { 'zh-CN': 'maker 写、checker 审' },
  coordinator: coordinator.id,
  members: ['user.maker', 'user.checker'],
  pattern: 'review-loop',
  reviewLoop: { maker: 'user.maker', checker: 'user.checker', maxRounds: 2 },
  ...patch,
})

function setup() {
  let clock = 1_000
  let counter = 0
  const busy = new Set<string>()
  const storage = createMemoryStorage({ now: () => clock })
  const events = createSessionEventService({ storage })
  const definitions = new Map([
    [coordinator.id, coordinator],
    [reviewer.id, reviewer],
    [maker.id, maker],
  ])
  const agents = {
    get: vi.fn(({ agentId }: { agentId: string }) => {
      const published = definitions.get(agentId)
      if (!published) throw new RpcError('agent.not_found', { agentId })
      return { agentId, published }
    }),
    trialDraft: vi.fn((agentId: string) => {
      const published = definitions.get(agentId)
      if (!published) throw new RpcError('agent.not_found', { agentId })
      return { definition: { ...published, status: 'draft' as const }, draftHash: 'agent-draft' }
    }),
  }
  const elevated: string[] = []
  const refreshed: string[] = []
  const service = createTeamService({
    storage,
    events,
    agents: agents as never,
    sessions: {
      isBusy: (sessionId) => busy.has(sessionId),
      refreshTeam: (teamId) => refreshed.push(teamId),
    },
    trials: { markElevated: (sessionId) => elevated.push(sessionId) },
    createId: () => `${++counter}`,
    now: () => clock,
  })
  return {
    storage,
    events,
    agents,
    service,
    busy,
    elevated,
    refreshed,
    advance: () => {
      clock += 1
    },
  }
}

describe('团队模板命令（M7-09）', () => {
  it('新模板没有 id 时生成一个，草稿出现在列表里', () => {
    const { service } = setup()
    const detail = service.saveDraft({ definition: draft() })
    expect(detail.teamId).toMatch(/^user\.team-/)
    expect(detail.draft).toMatchObject({ id: detail.teamId, pattern: 'review-loop' })
    expect(detail.validation.ok).toBe(true)
    const list = service.list({})
    expect(list.teams).toEqual([
      expect.objectContaining({
        teamId: detail.teamId,
        pattern: 'review-loop',
        memberCount: 2,
        status: 'draft',
        version: 0,
        hasDraft: true,
      }),
    ])
  })

  it('保存草稿时校验问题照常返回，发布时才拒绝', () => {
    const { service } = setup()
    const saved = service.saveDraft({ definition: draft({ coordinator: 'user.missing' }) })
    expect(saved.validation.ok).toBe(false)
    expect(() => service.publish({ teamId: saved.teamId })).toThrowError(
      expect.objectContaining({ code: 'team.invalid' }),
    )
  })

  it('发布校验通过的草稿，版本号自增并清掉草稿', () => {
    const { service, refreshed } = setup()
    const created = service.saveDraft({ definition: draft() })
    const published = service.publish({ teamId: created.teamId })
    expect(published.draft).toBeUndefined()
    expect(published.published).toMatchObject({
      id: created.teamId,
      version: 1,
      pattern: 'review-loop',
      schemaVersion: 1,
    })
    // 已绑定这个模板的会话要重建宿主，下一轮用新版本。
    expect(refreshed).toEqual([created.teamId])
    service.saveDraft({
      definition: { ...draft({ description: { 'zh-CN': '第二版' } }), id: created.teamId },
    })
    const second = service.publish({ teamId: created.teamId })
    expect(second.published?.version).toBe(2)
    expect(service.get({ teamId: created.teamId, version: 1 }).published?.description).toEqual({
      'zh-CN': 'maker 写、checker 审',
    })
    expect(service.list({}).teams[0]).toMatchObject({
      status: 'published',
      version: 2,
      hasDraft: false,
    })
    expect(() => service.get({ teamId: created.teamId, version: 9 })).toThrowError(
      expect.objectContaining({ code: 'team.not_found' }),
    )
  })

  it('按版本号升序列出已发布版本，并带上发布时间与摘要', () => {
    const { service, advance } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(service.versions({ teamId: created.teamId })).toEqual({ versions: [] })

    advance()
    const first = service.publish({ teamId: created.teamId })
    advance()
    service.saveDraft({
      definition: { ...draft({ description: { 'zh-CN': '第二版' } }), id: created.teamId },
    })
    const second = service.publish({ teamId: created.teamId })

    const { versions } = service.versions({ teamId: created.teamId })
    expect(versions.map((version) => version.version)).toEqual([1, 2])
    expect(versions[0]).toMatchObject({
      publishedAt: first.published?.createdAt,
      pattern: 'review-loop',
      memberCount: 2,
    })
    expect(versions[1]).toMatchObject({
      publishedAt: second.published?.createdAt,
      memberCount: 2,
      description: { 'zh-CN': '第二版' },
    })
    expect(() => service.versions({ teamId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'team.not_found' }),
    )
  })

  it('归档后从默认列表隐藏，取消归档后恢复，草稿与版本都保留', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ teamId: created.teamId })
    service.saveDraft({
      definition: { ...draft({ description: { 'zh-CN': '新草稿' } }), id: created.teamId },
    })

    const archived = service.archive({ teamId: created.teamId })
    expect(archived.archived).toBe(true)
    expect(archived.published?.version).toBe(1)
    expect(archived.draft?.description).toEqual({ 'zh-CN': '新草稿' })
    expect(service.list({}).teams).toEqual([])
    expect(service.list({ includeArchived: true }).teams).toEqual([
      expect.objectContaining({ teamId: created.teamId, archived: true }),
    ])

    const restored = service.unarchive({ teamId: created.teamId })
    expect(restored.archived).toBe(false)
    expect(service.list({}).teams.map((team) => team.teamId)).toEqual([created.teamId])
    expect(() => service.archive({ teamId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'team.not_found' }),
    )
    expect(() => service.unarchive({ teamId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'team.not_found' }),
    )
  })

  it('没有草稿或模板不存在时报错', () => {
    const { service } = setup()
    expect(() => service.get({ teamId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'team.not_found' }),
    )
    const created = service.saveDraft({ definition: draft() })
    service.publish({ teamId: created.teamId })
    expect(() => service.publish({ teamId: created.teamId })).toThrowError(
      expect.objectContaining({ code: 'team.no_draft' }),
    )
    expect(() => service.trialStart({ teamId: created.teamId, projectPath })).toThrowError(
      expect.objectContaining({ code: 'team.no_draft' }),
    )
  })

  it('试运行创建隐藏会话，记录模板与草稿哈希，默认只读', () => {
    const { storage, service, elevated } = setup()
    const created = service.saveDraft({ definition: draft() })
    const started = service.trialStart({ teamId: created.teamId, projectPath })
    expect(started).toMatchObject({
      teamId: created.teamId,
      agent: { id: coordinator.id, draftHash: 'agent-draft' },
      useAgentPermissions: false,
    })
    expect(started.teamDraftHash).toBe(
      teamDraftHash(service.get({ teamId: created.teamId }).draft!),
    )
    const session = storage.sessions.get(started.sessionId)!
    expect(session).toMatchObject({
      kind: 'trial',
      trialAgentId: coordinator.id,
      trialDraftHash: 'agent-draft',
      trialTeamId: created.teamId,
      trialTeamDraftHash: started.teamDraftHash,
    })
    expect(storage.sessions.list().map((item) => item.sessionId)).toEqual([])
    expect(elevated).toEqual([])
    expect(storage.events.readAfter(started.sessionId, 0).map((event) => event.type)).toEqual([
      'session.created',
    ])
  })

  it('校验不通过时拒绝试运行，要求项目路径是绝对路径', () => {
    const { service } = setup()
    const bad = service.saveDraft({ definition: draft({ members: ['user.checker'] }) })
    expect(() => service.trialStart({ teamId: bad.teamId, projectPath })).toThrowError(
      expect.objectContaining({ code: 'team.invalid' }),
    )
    const created = service.saveDraft({ definition: draft() })
    expect(() =>
      service.trialStart({ teamId: created.teamId, projectPath: 'relative' }),
    ).toThrowError(expect.objectContaining({ code: 'rpc.invalid_params' }))
  })

  it('显式提权时登记为已提权', () => {
    const { service, elevated } = setup()
    const created = service.saveDraft({ definition: draft() })
    const started = service.trialStart({
      teamId: created.teamId,
      projectPath,
      useAgentPermissions: true,
    })
    expect(started.useAgentPermissions).toBe(true)
    expect(elevated).toEqual([started.sessionId])
  })

  it('复用已有项目，并列出与清理试运行历史', () => {
    const { storage, service, advance } = setup()
    const project = storage.projects.create({ projectId: 'p1', name: 'Team', path: projectPath })
    const created = service.saveDraft({ definition: draft() })
    const first = service.trialStart({ teamId: created.teamId, projectPath })
    advance()
    const second = service.trialStart({ teamId: created.teamId, projectPath })
    expect(storage.sessions.get(first.sessionId)?.projectId).toBe(project.projectId)
    expect(service.trialList({ teamId: created.teamId }).trials.map((t) => t.sessionId)).toEqual([
      second.sessionId,
      first.sessionId,
    ])
    expect(service.trialClear({ teamId: created.teamId })).toEqual({ cleared: 2 })
    expect(storage.sessions.list({ includeTrial: true })).toEqual([])
  })

  it('有试运行正在进行时不清理', () => {
    const { busy, service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const started = service.trialStart({ teamId: created.teamId, projectPath })
    busy.add(started.sessionId)
    expect(() => service.trialClear({ teamId: created.teamId })).toThrowError(
      expect.objectContaining({ code: 'run.busy' }),
    )
  })

  it('超过保留条数时清掉最旧的试运行', () => {
    const { storage, service, advance } = setup()
    const created = service.saveDraft({ definition: draft() })
    const sessions: string[] = []
    for (let index = 0; index < TEAM_TRIAL_RETENTION + 1; index += 1) {
      advance()
      sessions.push(service.trialStart({ teamId: created.teamId, projectPath }).sessionId)
    }
    const left = storage.sessions.list({ includeTrial: true }).map((item) => item.sessionId)
    expect(left).toHaveLength(TEAM_TRIAL_RETENTION)
    expect(left).not.toContain(sessions[0])
    expect(left).toContain(sessions.at(-1))
  })

  it('团队试运行把模板的委派覆盖与协作说明并入定义', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({ delegation: { maxChildrenPerTurn: 3 } }),
    })
    const started = service.trialStart({ teamId: created.teamId, projectPath })
    const merged = service.applySessionTeam(started.sessionId, coordinator)
    expect(merged.delegation).toMatchObject({ maxChildrenPerTurn: 3, enabled: true })
    expect(merged.instructions).toContain('# Team: 审查小组')
    expect(merged.instructions).toContain('review_loop')
    // 普通会话不受影响
    expect(service.applySessionTeam('missing', coordinator)).toBe(coordinator)
  })

  it('模板发布后草稿清空，之前的试运行沿用主控定义', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const started = service.trialStart({ teamId: created.teamId, projectPath })
    service.publish({ teamId: created.teamId })
    expect(service.applySessionTeam(started.sessionId, coordinator)).toBe(coordinator)
  })

  it('普通会话选用已发布模板后，每轮并入最新已发布版本', () => {
    const { storage, events, service } = setup()
    storage.projects.create({ projectId: 'p1', name: 'Team', path: projectPath })
    storage.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: projectPath,
      title: '',
    })
    const created = service.saveDraft({
      definition: draft({ delegation: { maxChildrenPerTurn: 3 } }),
    })
    service.publish({ teamId: created.teamId })
    // 还没有绑定：原样返回。
    expect(service.applySessionTeam('s1', coordinator)).toBe(coordinator)
    const bind = (teamId: string) =>
      events.publish([
        {
          v: 1,
          sessionId: 's1',
          runId: 's1',
          ts: 1,
          type: 'session.team.changed',
          payload: { team: { teamId, name: draft().name, version: 1, pattern: 'review-loop' } },
        },
      ])
    bind(created.teamId)
    const merged = service.applySessionTeam('s1', coordinator)
    expect(merged.delegation).toMatchObject({ maxChildrenPerTurn: 3, enabled: true })
    expect(merged.instructions).toContain('# Team: 审查小组')
    // 之后发布的新版本从下一轮起生效，不需要重新绑定。
    service.saveDraft({
      definition: draft({ id: created.teamId, delegation: { maxChildrenPerTurn: 5 } }),
    })
    service.publish({ teamId: created.teamId })
    expect(service.applySessionTeam('s1', coordinator).delegation).toMatchObject({
      maxChildrenPerTurn: 5,
    })
    // 取消选用（省略 team）后回到主控定义。
    events.publish([
      { v: 1, sessionId: 's1', runId: 's1', ts: 2, type: 'session.team.changed', payload: {} },
    ])
    expect(service.applySessionTeam('s1', coordinator)).toBe(coordinator)
  })

  it('自动修复会话不并入团队说明', () => {
    const { storage, events, service } = setup()
    storage.projects.create({ projectId: 'p1', name: 'Team', path: projectPath })
    storage.sessions.create({
      sessionId: 's1',
      projectId: 'p1',
      workspacePath: projectPath,
      title: '',
      kind: 'auto-fix',
    })
    const created = service.saveDraft({ definition: draft() })
    service.publish({ teamId: created.teamId })
    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 's1',
        ts: 1,
        type: 'session.team.changed',
        payload: {
          team: { teamId: created.teamId, name: draft().name, version: 1, pattern: 'review-loop' },
        },
      },
    ])
    expect(service.applySessionTeam('s1', coordinator)).toBe(coordinator)
  })

  it('resolveTeam 只返回已发布、未归档且主控可用的模板', () => {
    const { agents, service } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(service.resolveTeam(created.teamId)).toBeUndefined()
    service.publish({ teamId: created.teamId })
    expect(service.resolveTeam(created.teamId)).toEqual({
      team: {
        teamId: created.teamId,
        name: draft().name,
        version: 1,
        pattern: 'review-loop',
      },
      coordinator: { id: coordinator.id, version: coordinator.version },
    })
    // 主控 Agent 找不到（例如之后被删除）时不能选用。
    agents.get.mockImplementationOnce(() => {
      throw new RpcError('agent.not_found', { agentId: coordinator.id })
    })
    expect(service.resolveTeam(created.teamId)).toBeUndefined()
    // 归档后不再出现在选择器里；取消归档后恢复。
    service.archive({ teamId: created.teamId })
    expect(service.resolveTeam(created.teamId)).toBeUndefined()
    service.unarchive({ teamId: created.teamId })
    expect(service.resolveTeam(created.teamId)).toBeDefined()
    expect(service.resolveTeam('missing')).toBeUndefined()
  })

  it('definitionForTeam 返回已发布模板合并后的主控定义', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({ delegation: { maxChildrenPerTurn: 3 } }),
    })
    expect(service.definitionForTeam(created.teamId)).toBeUndefined()
    service.publish({ teamId: created.teamId })
    const merged = service.definitionForTeam(created.teamId)
    expect(merged).toMatchObject({
      id: coordinator.id,
      delegation: { enabled: true, maxChildrenPerTurn: 3 },
    })
    expect(merged?.instructions).toContain('# Team: 审查小组')
    service.archive({ teamId: created.teamId })
    expect(service.definitionForTeam(created.teamId)).toBeUndefined()
    expect(service.definitionForTeam('missing')).toBeUndefined()
  })

  it('清理最旧试运行时跳过仍在运行的会话', () => {
    const { storage, busy, service, advance } = setup()
    const created = service.saveDraft({ definition: draft() })
    const sessions: string[] = []
    for (let index = 0; index < TEAM_TRIAL_RETENTION; index += 1) {
      advance()
      sessions.push(service.trialStart({ teamId: created.teamId, projectPath }).sessionId)
    }
    busy.add(sessions[0]!)
    advance()
    service.trialStart({ teamId: created.teamId, projectPath })
    const left = storage.sessions.list({ includeTrial: true }).map((item) => item.sessionId)
    expect(left).toHaveLength(TEAM_TRIAL_RETENTION + 1)
    expect(left).toContain(sessions[0])
  })

  it('列出时跳过空记录，并可以包含已归档模板', () => {
    const { storage, service } = setup()
    storage.teams.create({ teamId: 'empty' })
    const created = service.saveDraft({ definition: draft() })
    expect(service.list({}).teams.map((team) => team.teamId)).toEqual([created.teamId])
    expect(() => service.get({ teamId: 'empty' })).toThrowError(
      expect.objectContaining({ code: 'team.not_found' }),
    )
    storage.teams.setArchived(created.teamId, true)
    expect(service.list({}).teams).toEqual([])
    expect(service.list({ includeArchived: true }).teams).toEqual([
      expect.objectContaining({ teamId: created.teamId, archived: true }),
    ])
  })

  it('生成 id 时退回名称或 team', () => {
    const { service } = setup()
    const unnamed = service.saveDraft({ definition: draft({ name: {} }) })
    expect(unnamed.teamId).toMatch(/^user\.team-team-/)
    const symbols = service.saveDraft({ definition: draft({ name: { 'zh-CN': '!!!' } }) })
    expect(symbols.teamId).toMatch(/^user\.team-team-/)
  })

  it('默认使用随机 id 与系统时钟', () => {
    const storage = createMemoryStorage()
    const events = createSessionEventService({ storage })
    const service = createTeamService({
      storage,
      events,
      agents: { get: () => undefined, trialDraft: () => ({}) } as never,
      sessions: { isBusy: () => false, refreshTeam: () => undefined },
      trials: { markElevated: () => undefined },
    })
    const detail = service.saveDraft({ definition: draft() })
    expect(detail.teamId).toMatch(/^user\.team-.*-[0-9a-f-]{36}$/)
    expect(storage.teams.get(detail.teamId)?.createdAt).toBeGreaterThan(0)
  })
})
