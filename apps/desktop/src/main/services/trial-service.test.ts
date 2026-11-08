import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { RpcError, type PermissionRule } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createSessionEventService } from './event-service.js'
import { createTrialService, TRIAL_RETENTION } from './trial-service.js'

const projectPath = path.resolve('/work/demo')

const rule: PermissionRule = {
  id: 'r1',
  scope: 'session',
  effect: 'allow',
  match: { tool: 'run_command' },
  source: 'user',
}

function setup() {
  let clock = 1_000
  let counter = 0
  const busy = new Set<string>()
  const storage = createMemoryStorage({ now: () => clock })
  const events = createSessionEventService({ storage })
  const definition = {
    id: 'user.reviewer',
    version: 1,
    source: 'user' as const,
    status: 'draft' as const,
    name: { 'en-US': 'Reviewer' },
    description: {},
    instructions: 'Review.',
    model: { mode: 'inherit' as const },
    tools: { allow: ['read'] },
    skills: { allow: [] },
    permissions: 'read-only' as const,
    limits: {},
    context: { includeProjectInstructions: true, compaction: 'auto' as const },
    memory: { scopes: ['session' as const], write: 'never' as const },
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1 as const,
  }
  const agents = {
    trialDraft: vi.fn((agentId: string) => {
      if (agentId !== definition.id) throw new RpcError('agent.not_found', { agentId })
      return { definition, draftHash: `hash-${clock}` }
    }),
    permissionRulesFor: vi.fn((_agent, rules: readonly PermissionRule[]) => [
      ...rules,
      { ...rule, id: 'agent-rule' },
    ]),
  }
  const service = createTrialService({
    storage,
    events,
    agents,
    sessions: { isBusy: (sessionId) => busy.has(sessionId) },
    createId: () => `${++counter}`,
    now: () => clock,
  })
  return {
    storage,
    events,
    agents,
    service,
    busy,
    advance: () => {
      clock += 1
    },
  }
}

describe('trial service', () => {
  it('creates a hidden trial session from an unpublished draft', () => {
    const { storage, events, service } = setup()
    const started = service.start({
      agentId: 'user.reviewer',
      projectPath,
    })
    expect(started).toMatchObject({
      sessionId: '2',
      agent: { id: 'user.reviewer', draftHash: 'hash-1000' },
      draftHash: 'hash-1000',
      useAgentPermissions: false,
    })
    const record = storage.sessions.get(started.sessionId)
    expect(record).toMatchObject({
      kind: 'trial',
      trialAgentId: 'user.reviewer',
      trialDraftHash: 'hash-1000',
      projectPath,
    })
    expect(storage.sessions.list().map((session) => session.sessionId)).toEqual([])
    expect(storage.sessions.list({ includeTrial: true })).toHaveLength(1)
    expect(events.readAfter(started.sessionId, 0)).toMatchObject([
      { type: 'session.created', payload: { projectPath } },
    ])
  })

  it('restarts with a new draft hash while keeping the previous history', () => {
    const { storage, service, advance } = setup()
    const first = service.start({
      agentId: 'user.reviewer',
      projectPath,
    })
    advance()
    const second = service.restart({ sessionId: first.sessionId, useAgentPermissions: true })
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.draftHash).toBe('hash-1001')
    expect(second.useAgentPermissions).toBe(true)
    expect(storage.sessions.get(first.sessionId)?.kind).toBe('trial')
    expect(storage.sessions.get(second.sessionId)?.trialDraftHash).toBe('hash-1001')
  })

  it('does not carry elevated permissions into a restart without explicit consent', () => {
    const { service, agents } = setup()
    const elevated = service.start({
      agentId: 'user.reviewer',
      projectPath,
      useAgentPermissions: true,
    })
    const restarted = service.restart({ sessionId: elevated.sessionId })

    expect(restarted.useAgentPermissions).toBe(false)
    expect(service.permissionRulesFor(restarted.sessionId, restarted.agent, [rule])).toContainEqual(
      expect.objectContaining({ id: 'preset.read-only.write', effect: 'deny' }),
    )
    expect(agents.permissionRulesFor).not.toHaveBeenCalled()
  })

  it('keeps the latest trials and skips busy ones while pruning', () => {
    const { service, storage, busy, advance } = setup()
    const ids: string[] = []
    for (let index = 0; index < TRIAL_RETENTION; index++) {
      ids.push(
        service.start({
          agentId: 'user.reviewer',
          projectPath,
        }).sessionId,
      )
      advance()
    }
    const oldest = ids[0]!
    busy.add(oldest)
    service.start({ agentId: 'user.reviewer', projectPath })
    expect(storage.sessions.list({ includeTrial: true })).toHaveLength(TRIAL_RETENTION + 1)
    busy.delete(oldest)
    advance()
    service.start({ agentId: 'user.reviewer', projectPath })
    expect(service.list({ agentId: 'user.reviewer' }).trials).toHaveLength(TRIAL_RETENTION)
    expect(storage.sessions.get(oldest)).toBeUndefined()
  })

  it('clears all trials for one agent and rejects clearing a busy trial', () => {
    const { service, storage, busy } = setup()
    const first = service.start({
      agentId: 'user.reviewer',
      projectPath,
    })
    service.start({ agentId: 'user.reviewer', projectPath })
    busy.add(first.sessionId)
    expect(() => service.clear({ agentId: 'user.reviewer' })).toThrow('run.busy')
    busy.delete(first.sessionId)
    expect(service.clear({ agentId: 'user.reviewer' })).toEqual({ cleared: 2 })
    expect(storage.sessions.list({ includeTrial: true })).toEqual([])
    expect(service.clear({ agentId: 'user.reviewer' })).toEqual({ cleared: 0 })
  })

  it('uses read-only rules by default and the agent rules after elevation', () => {
    const { service, agents } = setup()
    const trial = service.start({
      agentId: 'user.reviewer',
      projectPath,
    })
    const ref = trial.agent
    const readOnly = service.permissionRulesFor(trial.sessionId, ref, [rule])
    expect(readOnly.some((entry) => entry.effect === 'deny')).toBe(true)
    expect(readOnly.at(-1)).toEqual(rule)
    expect(agents.permissionRulesFor).not.toHaveBeenCalled()

    const elevated = service.start({
      agentId: 'user.reviewer',
      projectPath,
      useAgentPermissions: true,
    })
    expect(service.permissionRulesFor(elevated.sessionId, elevated.agent, [rule])).toContainEqual(
      expect.objectContaining({ id: 'agent-rule' }),
    )
    expect(agents.permissionRulesFor).toHaveBeenCalledTimes(1)

    const normal = service.permissionRulesFor('missing', ref, [rule])
    expect(normal).toContainEqual(expect.objectContaining({ id: 'agent-rule' }))
  })

  it('reports invalid projects, unknown agents and missing trial sessions', () => {
    const { service } = setup()
    expect(() => service.start({ agentId: 'user.reviewer', projectPath: 'relative/path' })).toThrow(
      'rpc.invalid_params',
    )
    expect(() => service.start({ agentId: 'missing', projectPath })).toThrow('agent.not_found')
    expect(() => service.restart({ sessionId: 'missing' })).toThrow('trial.not_found')
  })

  it('ignores normal sessions and trial rows without a draft hash', () => {
    const { service, storage } = setup()
    const project = storage.projects.create({
      projectId: 'p1',
      name: 'demo',
      path: projectPath,
    })
    storage.sessions.create({
      sessionId: 'normal',
      projectId: project.projectId,
      workspacePath: project.path,
      title: 'normal',
    })
    storage.sessions.create({
      sessionId: 'orphan',
      projectId: project.projectId,
      workspacePath: project.path,
      title: '',
      kind: 'trial',
      trialAgentId: 'user.reviewer',
    })
    expect(service.list({ agentId: 'user.reviewer' }).trials).toEqual([])
  })

  it('restarts a trial created outside this service with read-only permissions', () => {
    const { service, storage } = setup()
    const project = storage.projects.create({
      projectId: 'p1',
      name: 'demo',
      path: projectPath,
    })
    storage.sessions.create({
      sessionId: 'external',
      projectId: project.projectId,
      workspacePath: project.path,
      title: '',
      kind: 'trial',
      trialAgentId: 'user.reviewer',
      trialDraftHash: 'old',
    })
    expect(service.restart({ sessionId: 'external' })).toMatchObject({
      useAgentPermissions: false,
    })
  })

  it('uses random ids and the wall clock by default', () => {
    const storage = createMemoryStorage()
    const events = createSessionEventService({ storage })
    const agents = {
      trialDraft: () => ({ definition: {} as never, draftHash: 'hash' }),
      permissionRulesFor: (_agent: unknown, rules: readonly PermissionRule[]) => [...rules],
    }
    const service = createTrialService({
      storage,
      events,
      agents: agents as never,
      sessions: { isBusy: () => false },
    })
    const started = service.start({ agentId: 'user.reviewer', projectPath })
    expect(started.sessionId).not.toBe('')
    expect(storage.sessions.get(started.sessionId)?.createdAt).toBeGreaterThan(0)
  })
})
