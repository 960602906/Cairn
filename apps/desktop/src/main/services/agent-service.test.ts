import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENTS,
  BUILTIN_CODER_ID,
  BUILTIN_EXPLORER_ID,
  BUILTIN_REVIEWER_ID,
  BUILTIN_TESTER_ID,
} from '@cairn/core'
import type {
  AgentDraftInput,
  McpToolExposure,
  PermissionRule,
  SkillCatalogEntry,
  SkillSummary,
} from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createSessionEventService } from './event-service.js'
import { agentPresetRules, createAgentService, type AgentServiceOptions } from './agent-service.js'

let clock = 1_000
let counter = 0

function setup(overrides: Partial<AgentServiceOptions> = {}) {
  clock = 1_000
  counter = 0
  const storage = createMemoryStorage({ now: () => clock })
  storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: '/work/demo',
    title: 'S',
  })
  storage.mcpServers.create({ serverId: 'demo', name: 'Demo', kind: 'stdio', command: 'node' })
  const events = createSessionEventService({ storage })

  const skill: SkillSummary = {
    name: 'review',
    description: 'Review code',
    sha256: 'a'.repeat(64),
    source: 'user',
    enabled: true,
    pinned: false,
    tokens: { index: 5, pinned: 12 },
    shadowed: false,
    hasScripts: false,
    files: [],
  }
  const catalog: SkillCatalogEntry[] = [
    {
      name: 'review',
      description: 'Review code',
      sha256: 'a'.repeat(64),
      source: 'user',
      pinned: false,
      root: '/skills/review',
      body: '# review',
      hasScripts: false,
      files: [],
    },
    {
      name: 'release',
      description: 'Release notes',
      sha256: 'b'.repeat(64),
      source: 'user',
      pinned: false,
      root: '/skills/release',
      body: '# release',
      hasScripts: false,
      files: [],
    },
  ]
  const exposures: McpToolExposure[] = [
    {
      name: 'mcp_demo_echo',
      description: 'Echo',
      inputSchema: { type: 'object' },
      serverId: 'demo',
      originalName: 'echo',
      category: 'network',
    },
  ]
  const service = createAgentService({
    storage,
    events,
    skills: {
      list: () => ({ skills: [skill] }),
      catalog: () => catalog,
    },
    mcp: { exposures: () => exposures },
    models: { has: (model) => model.providerId === 'openai' && model.modelId === 'gpt' },
    now: () => clock,
    createId: () => `${++counter}`,
    ...overrides,
  })
  return { storage, events, service, skill, catalog, exposures }
}

const draft = (overrides: Partial<AgentDraftInput> = {}): AgentDraftInput => ({
  name: { 'zh-CN': '评审员', 'en-US': 'Reviewer' },
  description: { 'zh-CN': '只读评审', 'en-US': 'Read-only review' },
  instructions: 'Review the diff.',
  model: { mode: 'inherit' },
  tools: { allow: ['read'] },
  skills: { allow: ['*'] },
  permissions: 'ask',
  limits: {},
  context: { includeProjectInstructions: true, compaction: 'auto' },
  memory: { scopes: ['session'], write: 'never' },
  ...overrides,
})

const rule: PermissionRule = {
  id: 'r1',
  scope: 'session',
  effect: 'deny',
  match: { tool: 'run_command' },
  source: 'user',
}

describe('agent-service drafts and versions', () => {
  it('lists the builtin coder first and creates a user draft', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(created.agentId).toMatch(/^user\..+-/u)
    expect(created.draft?.instructions).toBe('Review the diff.')
    expect(created.published).toBeUndefined()
    expect(created.validation.ok).toBe(true)

    const list = service.list({})
    expect(list.agents.map((agent) => agent.agentId)).toEqual([
      BUILTIN_CODER_ID,
      BUILTIN_EXPLORER_ID,
      BUILTIN_REVIEWER_ID,
      BUILTIN_TESTER_ID,
      created.agentId,
    ])
    expect(list.agents[0]).toMatchObject({ source: 'builtin', status: 'published', version: 1 })
    expect(list.agents.at(-1)).toMatchObject({
      source: 'user',
      status: 'draft',
      version: 0,
      hasDraft: true,
    })
  })

  it('summarizes the model mode for the list (M3-12)', () => {
    const { service } = setup()
    // 内置编程助手跟随会话：没有固定模型。
    const builtin = service.list({}).agents[0]!
    expect(builtin.modelMode).toBe('inherit')
    expect(builtin.model).toBeUndefined()

    // 跟随会话的用户 Agent 同样只报模式。
    const inherit = service.saveDraft({ definition: draft() })
    const inheritSummary = service.list({}).agents.find((a) => a.agentId === inherit.agentId)!
    expect(inheritSummary.modelMode).toBe('inherit')
    expect(inheritSummary.model).toBeUndefined()

    // 固定模型时带出主模型，列表里可以显示 “provider · model”。
    const fixed = service.saveDraft({
      definition: draft({
        model: { mode: 'fixed', primary: { providerId: 'openai', modelId: 'gpt' } },
      }),
    })
    expect(fixed.validation.ok).toBe(true)
    const fixedSummary = service.list({}).agents.find((a) => a.agentId === fixed.agentId)!
    expect(fixedSummary.modelMode).toBe('fixed')
    expect(fixedSummary.model).toEqual({ providerId: 'openai', modelId: 'gpt' })
  })

  it('publishes a draft as version 1 and keeps the draft/published versions apart', () => {
    const { service, storage } = setup()
    const created = service.saveDraft({ definition: draft() })
    const agentId = created.agentId

    clock = 2_000
    const published = service.publish({ agentId })
    expect(published.published?.version).toBe(1)
    expect(published.draft).toBeUndefined()
    expect(published.validation.ok).toBe(true)
    expect(storage.agents.versions(agentId)).toHaveLength(1)

    // Editing the draft does not change the published version.
    const edited = service.saveDraft({
      definition: { ...draft(), id: agentId, instructions: 'Second pass.' },
    })
    expect(edited.draft?.instructions).toBe('Second pass.')
    expect(edited.published?.instructions).toBe('Review the diff.')

    clock = 3_000
    const second = service.publish({ agentId })
    expect(second.published?.version).toBe(2)
    expect(second.draft).toBeUndefined()
    expect(service.get({ agentId, version: 1 }).published?.instructions).toBe('Review the diff.')
  })

  it('blocks publishing when validation fails', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ tools: { allow: ['nope'] } }) })
    expect(created.validation.ok).toBe(false)
    expect(() => service.publish({ agentId: created.agentId })).toThrow('agent.invalid')
  })

  it('reports no_draft when publishing without a draft', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    expect(() => service.publish({ agentId: created.agentId })).toThrow('agent.no_draft')
  })

  it('rejects unsaved input that does not match the schema', () => {
    const { service } = setup()
    expect(() =>
      service.saveDraft({
        definition: { ...draft(), instructions: 7 } as unknown as AgentDraftInput,
      }),
    ).toThrow('agent.invalid')
  })

  it('duplicates an agent with a localized copy name and a fresh id', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const copy = service.duplicate({ agentId: created.agentId })
    expect(copy.agentId).not.toBe(created.agentId)
    expect(copy.draft?.name['zh-CN']).toContain('副本')
    expect(copy.draft?.name['en-US']).toContain('copy')
    expect(copy.draft?.instructions).toBe('Review the diff.')
  })

  it('duplicates builtins with their delegation and path policy intact', () => {
    const { service } = setup()
    const coder = service.duplicate({ agentId: BUILTIN_CODER_ID })
    expect(coder.source).toBe('user')
    expect(coder.draft?.delegation?.allowedAgents).toEqual([
      BUILTIN_EXPLORER_ID,
      BUILTIN_REVIEWER_ID,
      BUILTIN_TESTER_ID,
    ])
    const tester = service.duplicate({ agentId: BUILTIN_TESTER_ID })
    expect(tester.draft?.pathPolicy?.write).toEqual(
      expect.arrayContaining(['**/*.{test,spec}.*', '**/tests/**']),
    )
    expect(tester.draft?.tools.allow).toContain('write_file')
  })

  it('rejects duplicate names supplied explicitly without id', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const copy = service.duplicate({
      agentId: created.agentId,
      name: { 'zh-CN': '另一个', 'en-US': 'Another' },
    })
    expect(copy.draft?.name['en-US']).toBe('Another')
  })

  it('archives and unarchives custom agents', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(service.archive({ agentId: created.agentId }).archived).toBe(true)
    expect(service.list({}).agents.map((agent) => agent.agentId)).not.toContain(created.agentId)
    expect(service.list({ includeArchived: true }).agents.map((agent) => agent.agentId)).toContain(
      created.agentId,
    )
    expect(service.unarchive({ agentId: created.agentId }).archived).toBe(false)
  })

  it('filters by source, status and query', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(service.list({ source: 'user' }).agents.map((agent) => agent.agentId)).toEqual([
      created.agentId,
    ])
    expect(service.list({ source: 'builtin' }).agents.map((agent) => agent.agentId)).toEqual([
      BUILTIN_CODER_ID,
      BUILTIN_EXPLORER_ID,
      BUILTIN_REVIEWER_ID,
      BUILTIN_TESTER_ID,
    ])
    expect(service.list({ status: 'draft' }).agents.map((agent) => agent.agentId)).toEqual([
      created.agentId,
    ])
    expect(service.list({ query: '评审' }).agents.map((agent) => agent.agentId)).toEqual([
      created.agentId,
    ])
    expect(service.list({ query: 'nothing' }).agents).toEqual([])
  })

  it('lists and reads every builtin as published read-only definitions', () => {
    const { service } = setup()
    const builtins = service.list({ source: 'builtin' }).agents
    expect(builtins).toHaveLength(BUILTIN_AGENTS.length)
    for (const summary of builtins) {
      const detail = service.get({ agentId: summary.agentId })
      expect(detail.source).toBe('builtin')
      expect(detail.draft).toBeUndefined()
      expect(detail.published?.id).toBe(summary.agentId)
      expect(detail.validation).toEqual({ ok: true, errors: [], warnings: [] })
    }
    expect(service.get({ agentId: BUILTIN_REVIEWER_ID }).published?.outputSchema).toMatchObject({
      required: ['issues'],
    })
    expect(service.get({ agentId: BUILTIN_TESTER_ID }).published?.pathPolicy?.write).toEqual(
      expect.arrayContaining(['**/*.{test,spec}.*', '**/tests/**']),
    )
  })

  it('validates delegation targets against published agents only', () => {
    const { service } = setup()
    const draftOnly = service.saveDraft({ definition: draft() })
    const invalid = service.saveDraft({
      definition: draft({
        delegation: {
          enabled: true,
          allowedAgents: [draftOnly.agentId],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      }),
    })
    expect(invalid.validation.errors).toContainEqual({
      path: 'delegation.allowedAgents.0',
      code: 'delegation_agent_not_published',
      params: { agent: draftOnly.agentId },
    })
    expect(() => service.publish({ agentId: invalid.agentId })).toThrow('agent.invalid')

    const valid = service.saveDraft({
      definition: draft({
        delegation: {
          enabled: true,
          allowedAgents: [BUILTIN_EXPLORER_ID, BUILTIN_REVIEWER_ID],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'auto',
          mergeReview: 'user',
        },
      }),
    })
    expect(valid.validation).toEqual({ ok: true, errors: [], warnings: [] })

    const empty = service.saveDraft({
      definition: draft({
        delegation: {
          enabled: true,
          allowedAgents: [],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'auto',
          mergeReview: 'user',
        },
      }),
    })
    expect(empty.validation.errors).toContainEqual({
      path: 'delegation.allowedAgents',
      code: 'delegation_agents_required',
    })
  })
})

describe('agent-service deletion and versions', () => {
  it('deletes an unused agent but blocks one used by a run', () => {
    const { service, events } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })

    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 'run-1',
        ts: clock,
        type: 'run.created',
        payload: {
          agent: { id: created.agentId, version: 1 },
          model: { providerId: 'openai', modelId: 'gpt' },
          mode: 'interactive',
          limits: {},
        },
      },
    ])
    expect(() => service.delete({ agentId: created.agentId })).toThrow('agent.in_use')
    expect(service.versions({ agentId: created.agentId }).versions[0]?.usedBySessions).toBe(1)

    const unused = service.duplicate({ agentId: created.agentId })
    service.delete({ agentId: unused.agentId })
    expect(service.list({}).agents.map((agent) => agent.agentId)).not.toContain(unused.agentId)
  })

  it('reports builtin versions and blocks editing builtins', () => {
    const { service } = setup()
    for (const agent of BUILTIN_AGENTS) {
      const versions = service.versions({ agentId: agent.id }).versions
      expect(versions).toHaveLength(1)
      expect(versions[0]?.version).toBe(1)
      expect(() => service.archive({ agentId: agent.id })).toThrow('agent.readonly')
      expect(() => service.publish({ agentId: agent.id })).toThrow('agent.readonly')
      expect(() => service.delete({ agentId: agent.id })).toThrow('agent.readonly')
      expect(() => service.saveDraft({ definition: { ...draft(), id: agent.id } })).toThrow(
        'agent.readonly',
      )
    }
  })

  it('reports not_found for unknown agents and versions', () => {
    const { service } = setup()
    expect(() => service.get({ agentId: 'missing' })).toThrow('agent.not_found')
    const created = service.saveDraft({ definition: draft() })
    expect(() => service.get({ agentId: created.agentId, version: 9 })).toThrow('agent.not_found')
    expect(() => service.versions({ agentId: 'missing' })).toThrow('agent.not_found')
  })
})

describe('agent-service diff, export and import', () => {
  it('diffs the draft against a published version', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    service.saveDraft({
      definition: {
        ...draft(),
        id: created.agentId,
        instructions: 'Now harder.',
        permissions: 'auto',
      },
    })
    const diff = service.diff({ agentId: created.agentId, from: 1, to: 'draft' })
    expect(diff.fields.map((field) => field.path)).toEqual(['permissions'])
    expect(diff.instructions).toEqual({ from: 'Review the diff.', to: 'Now harder.' })
  })

  it('round-trips export and import through YAML front matter', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const { markdown } = service.export({ agentId: created.agentId })
    expect(markdown.startsWith('---\n')).toBe(true)
    expect(markdown).toContain('Review the diff.')

    const imported = service.import({ markdown })
    expect(imported.source).toBe('imported')
    expect(imported.agentId).toMatch(/^imported\./u)
    expect(imported.draft?.name['en-US']).toBe('Reviewer')
    expect(imported.draft?.instructions.trim()).toBe('Review the diff.')
    expect(imported.draft?.tools).toEqual({ allow: ['read'] })
  })

  it('round-trips delegation and path policy through YAML front matter', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({
        pathPolicy: { write: ['tests/**'] },
        delegation: {
          enabled: true,
          allowedAgents: [BUILTIN_EXPLORER_ID],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      }),
    })
    const imported = service.import({
      markdown: service.export({ agentId: created.agentId }).markdown,
    })
    expect(imported.draft?.pathPolicy).toEqual({ write: ['tests/**'] })
    expect(imported.draft?.delegation).toMatchObject({
      enabled: true,
      allowedAgents: [BUILTIN_EXPLORER_ID],
    })
  })

  it('includes delegation and path policy in drafts diffs', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    service.saveDraft({
      definition: {
        ...draft(),
        id: created.agentId,
        pathPolicy: { write: ['tests/**'] },
        delegation: {
          enabled: true,
          allowedAgents: [BUILTIN_REVIEWER_ID],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      },
    })
    expect(
      service
        .diff({ agentId: created.agentId, from: 1, to: 'draft' })
        .fields.map((field) => field.path),
    ).toEqual(['pathPolicy', 'delegation'])
  })

  it('rejects import without front matter or with an invalid body', () => {
    const { service } = setup()
    expect(() => service.import({ markdown: 'no front matter' })).toThrow('agent.invalid')
    expect(() => service.import({ markdown: '---\n{ invalid: [\n---\nbody\n' })).toThrow(
      'agent.invalid',
    )
    expect(() =>
      service.import({
        markdown:
          '---\nname:\n  en-US: X\nmodel:\n  mode: inherit\ntools:\n  allow: []\nskills:\n  allow: []\npermissions: ask\nlimits: {}\ncontext:\n  includeProjectInstructions: true\n  compaction: auto\nmemory:\n  scopes: [session]\n  write: never\n---\nbody\n',
      }),
    ).toThrow('agent.invalid')
  })
})

describe('agent-service runtime helpers', () => {
  it('only returns published definitions', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(service.definition({ id: created.agentId, version: 1 })).toBeUndefined()
    service.publish({ agentId: created.agentId })
    expect(service.definition({ id: created.agentId, version: 1 })?.instructions).toBe(
      'Review the diff.',
    )
    expect(service.definition({ id: BUILTIN_CODER_ID, version: 1 })?.id).toBe(BUILTIN_CODER_ID)
  })

  it('filters skills and MCP tools by the agent selection', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({ tools: { allow: ['read'] }, skills: { allow: ['review'] } }),
    })
    service.publish({ agentId: created.agentId })
    const ref = { id: created.agentId, version: 1 }
    expect(service.skillsFor(ref, 's1').map((skill) => skill.name)).toEqual(['review'])
    expect(service.mcpToolsFor(ref)).toEqual([])
  })

  it('falls back to everything when the referenced agent is missing', () => {
    const { service, catalog, exposures } = setup()
    const ref = { id: 'gone', version: 1 }
    expect(service.skillsFor(ref, 's1')).toEqual(catalog)
    expect(service.mcpToolsFor(ref)).toEqual(exposures)
    expect(service.permissionRulesFor(ref, [rule])).toEqual([rule])
  })

  it('adds preset permission rules ahead of the app rules', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ permissions: 'read-only' }) })
    service.publish({ agentId: created.agentId })
    const rules = service.permissionRulesFor({ id: created.agentId, version: 1 }, [rule])
    expect(rules.at(-1)).toEqual(rule)
    expect(rules.length).toBeGreaterThan(1)
    expect(rules.some((entry) => entry.effect === 'deny')).toBe(true)
  })

  it('resolves unpublished drafts by content hash for trial runs', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({ instructions: 'Draft instruction.', skills: { allow: ['review'] } }),
    })
    const trial = service.trialDraft(created.agentId)
    expect(trial.definition).toMatchObject({
      id: created.agentId,
      status: 'draft',
      instructions: 'Draft instruction.',
    })
    expect(trial.draftHash).toMatch(/^[a-f0-9]{64}$/)
    expect(service.trialDraft(created.agentId).draftHash).toBe(trial.draftHash)
    const ref = { id: created.agentId, draftHash: trial.draftHash }
    expect(service.definition(ref)?.instructions).toBe('Draft instruction.')
    expect(service.skillsFor(ref, 's1').map((skill) => skill.name)).toEqual(['review'])
    expect(service.permissionRulesFor(ref, [rule]).at(-1)).toEqual(rule)
    expect(service.definition({ ...ref, draftHash: 'stale' })).toBeUndefined()
    expect(() => service.trialDraft('missing')).toThrow('agent.not_found')
  })

  it('trial-runs builtin agents without inventing a published version', () => {
    const { service } = setup()
    const trial = service.trialDraft(BUILTIN_CODER_ID)
    expect(trial.definition.id).toBe(BUILTIN_CODER_ID)
    expect(trial.draftHash).toMatch(/^[a-f0-9]{64}$/)
    expect(service.definition({ id: BUILTIN_CODER_ID, draftHash: trial.draftHash })?.id).toBe(
      BUILTIN_CODER_ID,
    )
  })

  it('trial-runs a published agent after its draft is cleared', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ instructions: 'Published.' }) })
    service.publish({ agentId: created.agentId })
    const trial = service.trialDraft(created.agentId)
    expect(trial.definition).toMatchObject({
      id: created.agentId,
      version: 1,
      status: 'published',
      instructions: 'Published.',
    })
  })

  it('counts only published runs in version usage', () => {
    const { service, events } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    const model = { providerId: 'openai', modelId: 'gpt' }
    const limits = {
      maxStepsPerTurn: 10,
      maxTurnDurationMs: 1000,
      maxConsecutiveToolErrors: 1,
    }
    const run = (agent: { id: string; version: number } | { id: string; draftHash: string }) => ({
      v: 1 as const,
      sessionId: 's1',
      runId: `run-${Math.random()}`,
      ts: 1,
      type: 'run.created' as const,
      payload: { agent, model, mode: 'interactive' as const, limits },
    })
    events.publish([
      run({ id: created.agentId, version: 1 }),
      run({ id: created.agentId, draftHash: 'draft-hash' }),
    ])
    expect(service.versions({ agentId: created.agentId }).versions[0]?.usedBySessions).toBe(1)
  })
})

describe('agentPresetRules', () => {
  it('only keeps deny rules: an agent can tighten the global mode but never loosen it', () => {
    expect(agentPresetRules('auto')).toEqual([])
    expect(agentPresetRules('ask')).toEqual([])
    const readOnly = agentPresetRules('read-only')
    expect(readOnly.length).toBeGreaterThan(0)
    expect(readOnly.every((rule) => rule.effect === 'deny')).toBe(true)
  })

  it('an auto agent adds no allow rules on top of the app rules', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ permissions: 'auto' }) })
    service.publish({ agentId: created.agentId })
    expect(service.permissionRulesFor({ id: created.agentId, version: 1 }, [rule])).toEqual([rule])
  })
})

describe('agent-service effective config', () => {
  it('builds the system prompt, tools, skills, rules and budget', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({
        instructions: 'Be concise.',
        tools: { allow: ['read'] },
        skills: { allow: ['review'], pinned: ['review'] },
      }),
    })
    const config = service.effectiveConfig({ agentId: created.agentId, sessionId: 's1' })
    expect(config.source).toBe('draft')
    expect(config.systemPrompt).toContain('Be concise.')
    expect(config.tools.every((tool) => tool.category === 'read')).toBe(true)
    expect(config.skills.map((skill) => skill.name)).toEqual(['review'])
    expect(config.skills[0]?.pinned).toBe(true)
    expect(config.budget.contextWindow).toBeGreaterThan(0)
    expect(config.budget.systemPromptTokens).toBeGreaterThan(0)
  })

  it('returns published config for a published agent', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    const config = service.effectiveConfig({ agentId: created.agentId })
    expect(config.source).toBe('published')
    expect(config.version).toBe(1)
  })

  it('returns the builtin coder config', () => {
    const { service } = setup()
    const config = service.effectiveConfig({ agentId: BUILTIN_CODER_ID })
    expect(config.version).toBe(1)
    expect(config.source).toBe('published')
    expect(config.tools.length).toBeGreaterThan(0)
  })

  it('uses the session project skills when given a session', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const config = service.effectiveConfig({ agentId: created.agentId, sessionId: 's1' })
    expect(config.tools.length).toBeGreaterThan(0)
  })

  it('omits the instructions section when they are blank', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ instructions: '   ' }) })
    const config = service.effectiveConfig({ agentId: created.agentId })
    expect(config.systemPrompt).not.toContain('Agent instructions')
  })
})

describe('agent-service defaults and edge paths', () => {
  it('falls back to Date.now and random ids when not injected', () => {
    const storage = createMemoryStorage()
    storage.projects.create({ projectId: 'p1', name: 'Demo', path: '/work/demo' })
    const events = createSessionEventService({ storage })
    const service = createAgentService({
      storage,
      events,
      skills: { list: () => ({ skills: [] }), catalog: () => [] },
      mcp: { exposures: () => [] },
      models: { has: () => false },
    })
    const created = service.saveDraft({ definition: draft() })
    expect(created.agentId).toMatch(/^user\./u)
  })

  it('generates a fallback slug when the name has no latin text', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ name: {} }) })
    expect(created.agentId).toMatch(/^user\.agent-/u)
  })

  it('generates a slug from the Chinese name when English is missing', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ name: { 'zh-CN': '评审' } }) })
    expect(created.agentId).toMatch(/^user\./u)
  })

  it('reports not_found for a builtin version that does not exist', () => {
    const { service } = setup()
    expect(() => service.get({ agentId: BUILTIN_CODER_ID, version: 2 })).toThrow('agent.not_found')
    expect(service.definition({ id: BUILTIN_CODER_ID, version: 2 })).toBeUndefined()
    expect(() => service.export({ agentId: BUILTIN_CODER_ID, version: 2 })).toThrow(
      'agent.not_found',
    )
  })

  it('excludes runs whose agent version repeats uses within a session', () => {
    const { service, events } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    for (const runId of ['r1', 'r2']) {
      events.publish([
        {
          v: 1,
          sessionId: 's1',
          runId,
          ts: clock,
          type: 'run.created',
          payload: {
            agent: { id: created.agentId, version: 1 },
            model: { providerId: 'openai', modelId: 'gpt' },
            mode: 'interactive',
            limits: {},
          },
        },
      ])
    }
    expect(service.versions({ agentId: created.agentId }).versions[0]?.usedBySessions).toBe(1)
  })

  it('exports optional fields and round-trips them', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({
        icon: 'code',
        color: 'agent-blue',
        tags: ['review'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'string' },
      }),
    })
    const { markdown } = service.export({ agentId: created.agentId })
    expect(markdown).toContain('icon: code')
    expect(markdown).toContain('tags:')
    const imported = service.import({ markdown })
    expect(imported.draft?.icon).toBe('code')
    expect(imported.draft?.tags).toEqual(['review'])
    expect(imported.draft?.inputSchema).toEqual({ type: 'object' })
  })

  it('exports the builtin coder', () => {
    const { service } = setup()
    const { markdown } = service.export({ agentId: BUILTIN_CODER_ID })
    expect(markdown).toContain('Coder')
    expect(markdown).not.toContain('id:')
  })

  it('throws not_found diffing an unknown version', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    expect(() => service.diff({ agentId: created.agentId, from: 1, to: 'draft' })).toThrow(
      'agent.not_found',
    )
  })

  it('rejects import with a non-object YAML header', () => {
    const { service } = setup()
    expect(() => service.import({ markdown: '---\njust a string\n---\nbody\n' })).toThrow(
      'agent.invalid',
    )
  })

  it('reports a not_found record that has neither draft nor version', () => {
    const { service, storage } = setup()
    storage.agents.create({ agentId: 'user.empty', source: 'user' })
    expect(() => service.get({ agentId: 'user.empty' })).toThrow('agent.not_found')
    expect(() => service.versions({ agentId: 'user.empty' })).not.toThrow()
    expect(service.versions({ agentId: 'user.empty' }).versions).toEqual([])
  })

  it('throws not_found cloning an empty record', () => {
    const { service, storage } = setup()
    storage.agents.create({ agentId: 'user.empty', source: 'user' })
    expect(() => service.duplicate({ agentId: 'user.empty' })).toThrow('agent.not_found')
    expect(() => service.effectiveConfig({ agentId: 'user.empty' })).toThrow('agent.not_found')
  })

  it('uses the other language when one is missing for a copy name', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ name: { 'en-US': 'Only En' } }) })
    const copy = service.duplicate({ agentId: created.agentId })
    expect(copy.draft?.name['zh-CN']).toContain('Only En')
    expect(copy.draft?.name['en-US']).toContain('Only En')
  })

  it('unarchive reports readonly on the builtin', () => {
    const { service } = setup()
    expect(() => service.unarchive({ agentId: BUILTIN_CODER_ID })).toThrow('agent.readonly')
  })

  it('reports invalid on import with a schema error', () => {
    const { service } = setup()
    expect(() =>
      service.import({
        markdown:
          '---\nname:\n  en-US: X\nmodel:\n  mode: inherit\ntools:\n  allow: [nope]\nskills:\n  allow: []\npermissions: ask\nlimits: {}\ncontext:\n  includeProjectInstructions: true\n  compaction: auto\nmemory:\n  scopes: [session]\n  write: never\n---\nbody\n',
      }),
    ).toThrow('agent.invalid')
  })

  it('omits permission and skill selections when there are none', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({ tools: { allow: [] }, skills: { allow: [] } }),
    })
    const config = service.effectiveConfig({ agentId: created.agentId })
    expect(config.tools).toEqual([])
    expect(config.skills).toEqual([])
  })

  it('uses an empty workspace path when there is no session', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    const config = service.effectiveConfig({ agentId: created.agentId })
    expect(config.budget.contextWindow).toBe(128_000)
  })

  it('returns builtin detail for a matching version and rejects others', () => {
    const { service } = setup()
    const detail = service.get({ agentId: BUILTIN_CODER_ID, version: 1 })
    expect(detail.published?.version).toBe(1)
    expect(detail.validation.ok).toBe(true)
    expect(() => service.get({ agentId: BUILTIN_CODER_ID, version: 2 })).toThrow('agent.not_found')
  })

  it('lists icon and color from the current fields', () => {
    const { service } = setup()
    const created = service.saveDraft({
      definition: draft({ icon: 'code', color: 'agent-blue' }),
    })
    const listed = service.list({}).agents.find((agent) => agent.agentId === created.agentId)
    expect(listed).toMatchObject({ icon: 'code', color: 'agent-blue' })
  })

  it('validates a fixed model through the model catalog', () => {
    const { service } = setup()
    const known = service.saveDraft({
      definition: draft({
        model: { mode: 'fixed', primary: { providerId: 'openai', modelId: 'gpt' } },
      }),
    })
    expect(known.validation.ok).toBe(true)
    const unknown = service.saveDraft({
      definition: draft({
        model: { mode: 'fixed', primary: { providerId: 'other', modelId: 'x' } },
      }),
    })
    expect(unknown.validation.ok).toBe(false)
    expect(unknown.validation.errors.map((issue) => issue.code)).toContain('unknown_model')
  })

  it('throws when listing a record that has neither draft nor version', () => {
    const { service, storage } = setup()
    storage.agents.create({ agentId: 'user.empty', source: 'user' })
    expect(() => service.list({})).toThrow('agent.not_found')
  })

  it('reports a root-level schema error as the definition path', () => {
    const { service } = setup()
    expect(() =>
      service.saveDraft({ definition: 'not an object' as unknown as AgentDraftInput }),
    ).toThrow('agent.invalid')
  })

  it('falls back to a generic copy name when both languages are empty', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft({ name: {} }) })
    const copy = service.duplicate({ agentId: created.agentId })
    expect(copy.draft?.name['zh-CN']).toBe('Agent 副本')
    expect(copy.draft?.name['en-US']).toBe('Agent copy')
  })

  it('exports a published version by number', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    const { markdown } = service.export({ agentId: created.agentId, version: 1 })
    expect(markdown).toContain('Review the diff.')
    expect(() => service.export({ agentId: created.agentId, version: 2 })).toThrow(
      'agent.not_found',
    )
  })

  it('reports zero used sessions for a published version nobody ran', () => {
    const { service } = setup()
    const created = service.saveDraft({ definition: draft() })
    service.publish({ agentId: created.agentId })
    expect(service.versions({ agentId: created.agentId }).versions[0]?.usedBySessions).toBe(0)
  })

  it('rejects an import that passes the schema but fails validation', () => {
    const { service } = setup()
    expect(() =>
      service.import({
        markdown:
          '---\nname:\n  en-US: X\ndescription:\n  en-US: Y\nmodel:\n  mode: inherit\ntools:\n  allow: [nope]\nskills:\n  allow: []\npermissions: ask\nlimits: {}\ncontext:\n  includeProjectInstructions: true\n  compaction: auto\nmemory:\n  scopes: [session]\n  write: never\n---\nbody\n',
      }),
    ).toThrow('agent.invalid')
  })
})
