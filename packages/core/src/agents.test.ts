import { describe, expect, it } from 'vitest'
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  type AgentDraftFields,
  type SkillCatalogEntry,
} from '@cairn/protocol'
import {
  BUILTIN_AGENTS,
  BUILTIN_CODER,
  BUILTIN_CODER_ID,
  BUILTIN_EXPLORER,
  BUILTIN_EXPLORER_ID,
  BUILTIN_REVIEWER,
  BUILTIN_REVIEWER_ID,
  BUILTIN_TESTER,
  BUILTIN_TESTER_ID,
  builtinAgent,
  selectSkills,
  skillSelected,
  toolSelected,
  validateAgentDefinition,
  type AgentValidationContext,
  type ToolLike,
} from './agents.js'

const readFile: ToolLike = { name: 'read_file', category: 'read' }
const writeFile: ToolLike = { name: 'write_file', category: 'write' }
const runCommand: ToolLike = { name: 'run_command', category: 'execute' }
const mcpEcho: ToolLike = {
  name: 'mcp_demo_echo',
  category: 'network',
  source: { kind: 'mcp', serverId: 'demo' },
}
const mcpOther: ToolLike = {
  name: 'mcp_other_ping',
  category: 'network',
  source: { kind: 'mcp', serverId: 'other' },
}

describe('toolSelected', () => {
  it('selects everything when there is no selection', () => {
    expect(toolSelected(undefined, readFile)).toBe(true)
    expect(toolSelected(undefined, mcpEcho)).toBe(true)
  })

  it('selects nothing when allow is empty', () => {
    expect(toolSelected({ allow: [] }, readFile)).toBe(false)
  })

  it('matches a wildcard, a category, a tool name and mcp:<serverId>', () => {
    expect(toolSelected({ allow: ['*'] }, runCommand)).toBe(true)
    expect(toolSelected({ allow: ['read'] }, readFile)).toBe(true)
    expect(toolSelected({ allow: ['read'] }, writeFile)).toBe(false)
    expect(toolSelected({ allow: ['write_file'] }, writeFile)).toBe(true)
    expect(toolSelected({ allow: ['write_file'] }, readFile)).toBe(false)
    expect(toolSelected({ allow: ['mcp:demo'] }, mcpEcho)).toBe(true)
    expect(toolSelected({ allow: ['mcp:demo'] }, mcpOther)).toBe(false)
  })

  it('lets deny win over allow', () => {
    expect(toolSelected({ allow: ['*'], deny: ['run_command'] }, runCommand)).toBe(false)
    expect(toolSelected({ allow: ['*'], deny: ['execute'] }, runCommand)).toBe(false)
    expect(toolSelected({ allow: ['*'], deny: ['mcp:demo'] }, mcpEcho)).toBe(false)
    expect(toolSelected({ allow: ['*'], deny: ['mcp:demo'] }, readFile)).toBe(true)
  })
})

const skill = (name: string, pinned = false): SkillCatalogEntry => ({
  name,
  description: `${name} skill`,
  sha256: 'a'.repeat(64),
  source: 'user',
  pinned,
  root: `/skills/${name}`,
  body: `# ${name}`,
  hasScripts: false,
  files: [],
})

describe('skillSelected and selectSkills', () => {
  it('selects everything when there is no selection', () => {
    expect(skillSelected(undefined, { name: 'review' })).toBe(true)
  })

  it('matches wildcard, explicit name, and lets deny win', () => {
    expect(skillSelected({ allow: ['*'] }, { name: 'review' })).toBe(true)
    expect(skillSelected({ allow: ['review'] }, { name: 'review' })).toBe(true)
    expect(skillSelected({ allow: ['review'] }, { name: 'other' })).toBe(false)
    expect(skillSelected({ allow: ['*'], deny: ['review'] }, { name: 'review' })).toBe(false)
  })

  it('merges pinned selections into the catalog', () => {
    const catalog = [skill('alpha'), skill('beta', true), skill('gamma')]
    const selected = selectSkills({ allow: ['alpha', 'beta'], pinned: ['alpha'] }, catalog)
    expect(selected.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
    expect(selected.map((entry) => entry.pinned)).toEqual([true, true])
  })

  it('does not add a pinned skill that is not selected', () => {
    const catalog = [skill('alpha'), skill('beta')]
    const selected = selectSkills({ allow: ['alpha'], pinned: ['beta'] }, catalog)
    expect(selected.map((entry) => entry.name)).toEqual(['alpha'])
  })
})

const baseFields = (): AgentDraftFields => ({
  name: { 'zh-CN': '评审员', 'en-US': 'Reviewer' },
  description: { 'zh-CN': '只读代码评审', 'en-US': 'Read-only review' },
  instructions: 'Review the diff.',
  model: { mode: 'inherit' },
  tools: { allow: ['read'] },
  skills: { allow: ['*'] },
  permissions: 'ask',
  limits: {},
  context: { includeProjectInstructions: true, compaction: 'auto' },
  memory: { scopes: ['session'], write: 'never' },
})

const context = (overrides: Partial<AgentValidationContext> = {}): AgentValidationContext => ({
  knownTools: ['read_file', 'write_file', 'run_command'],
  mcpServers: ['demo'],
  mcpTools: ['mcp_demo_echo'],
  skillNames: ['review', 'release'],
  hasModel: (model) => model.providerId === 'openai' && model.modelId === 'gpt',
  ...overrides,
})

describe('validateAgentDefinition', () => {
  it('accepts a valid definition', () => {
    const result = validateAgentDefinition(baseFields(), context())
    expect(result).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('requires a name and a description in at least one language', () => {
    const result = validateAgentDefinition(
      {
        ...baseFields(),
        name: {},
        description: { 'zh-CN': '   ' },
      },
      context(),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.map((issue) => issue.code)).toEqual([
      'name_required',
      'description_required',
    ])
  })

  it('rejects instructions over the character limit', () => {
    const result = validateAgentDefinition(
      { ...baseFields(), instructions: 'x'.repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1) },
      context(),
    )
    expect(result.errors).toContainEqual({ path: 'instructions', code: 'instructions_too_long' })
  })

  it('rejects unknown tools and skills in allow lists', () => {
    const result = validateAgentDefinition(
      {
        ...baseFields(),
        tools: { allow: ['read', 'nope_tool'] },
        skills: { allow: ['review', 'nope_skill'] },
      },
      context(),
    )
    expect(result.errors).toContainEqual({
      path: 'tools.allow.1',
      code: 'unknown_tool',
      params: { tool: 'nope_tool' },
    })
    expect(result.errors).toContainEqual({
      path: 'skills.allow.1',
      code: 'unknown_skill',
      params: { skill: 'nope_skill' },
    })
  })

  it('accepts a known mcp selector and a known mcp tool', () => {
    const result = validateAgentDefinition(
      { ...baseFields(), tools: { allow: ['mcp:demo', 'mcp_demo_echo'] } },
      context(),
    )
    expect(result.ok).toBe(true)
  })

  it('requires a primary model when fixed and rejects unknown ones', () => {
    const missing = validateAgentDefinition(
      { ...baseFields(), model: { mode: 'fixed' } },
      context(),
    )
    expect(missing.errors).toContainEqual({ path: 'model.primary', code: 'model_required' })

    const unknown = validateAgentDefinition(
      { ...baseFields(), model: { mode: 'fixed', primary: { providerId: 'other', modelId: 'x' } } },
      context(),
    )
    expect(unknown.errors).toContainEqual({ path: 'model.primary', code: 'unknown_model' })
  })

  it('accepts a fixed primary model that exists', () => {
    const result = validateAgentDefinition(
      {
        ...baseFields(),
        model: { mode: 'fixed', primary: { providerId: 'openai', modelId: 'gpt' } },
      },
      context(),
    )
    expect(result.ok).toBe(true)
  })

  it('only warns about unknown deny selectors, fallbacks, auxiliary models and memory writes', () => {
    const result = validateAgentDefinition(
      {
        ...baseFields(),
        tools: { allow: ['read'], deny: ['nope_tool'] },
        skills: { allow: ['*'], pinned: ['nope_skill'] },
        model: {
          mode: 'fixed',
          primary: { providerId: 'openai', modelId: 'gpt' },
          fallbacks: [{ providerId: 'other', modelId: 'x' }],
          auxiliary: { providerId: 'other', modelId: 'x' },
        },
        memory: { scopes: ['session'], write: 'propose' },
      },
      context(),
    )
    expect(result.ok).toBe(true)
    expect(result.warnings.map((issue) => issue.code)).toEqual([
      'unknown_tool',
      'unknown_skill',
      'unknown_model',
      'unknown_model',
      'memory_write_reserved',
    ])
  })

  it('accepts known deny selectors and known fallback models without warnings', () => {
    const result = validateAgentDefinition(
      {
        ...baseFields(),
        tools: { allow: ['read'], deny: ['write_file', 'mcp:demo'] },
        model: {
          mode: 'fixed',
          primary: { providerId: 'openai', modelId: 'gpt' },
          fallbacks: [{ providerId: 'openai', modelId: 'gpt' }],
        },
      },
      context(),
    )
    expect(result).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('requires at least one published target when delegation is enabled', () => {
    const required = validateAgentDefinition(
      {
        ...baseFields(),
        delegation: {
          enabled: true,
          allowedAgents: [],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      },
      context({ publishedAgentIds: [] }),
    )
    expect(required.errors).toContainEqual({
      path: 'delegation.allowedAgents',
      code: 'delegation_agents_required',
    })

    const unpublished = validateAgentDefinition(
      {
        ...baseFields(),
        delegation: {
          enabled: true,
          allowedAgents: ['user.draft-only'],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      },
      context({ publishedAgentIds: [BUILTIN_REVIEWER_ID] }),
    )
    expect(unpublished.errors).toContainEqual({
      path: 'delegation.allowedAgents.0',
      code: 'delegation_agent_not_published',
      params: { agent: 'user.draft-only' },
    })

    const withoutPublishedContext = validateAgentDefinition(
      {
        ...baseFields(),
        delegation: {
          enabled: true,
          allowedAgents: ['user.unknown'],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      },
      context(),
    )
    expect(withoutPublishedContext.ok).toBe(true)
  })
})

describe('builtin agents (M4-11)', () => {
  const context: AgentValidationContext = {
    knownTools: ['read_file', 'list_dir', 'search', 'write_file', 'edit_file', 'run_command'],
    mcpServers: [],
    mcpTools: [],
    skillNames: [],
    hasModel: () => false,
    publishedAgentIds: BUILTIN_AGENTS.map((agent) => agent.id),
  }

  it('publishes the coder first and resolves every builtin by id', () => {
    expect(BUILTIN_AGENTS.map((agent) => agent.id)).toEqual([
      BUILTIN_CODER_ID,
      BUILTIN_EXPLORER_ID,
      BUILTIN_REVIEWER_ID,
      BUILTIN_TESTER_ID,
    ])
    expect(builtinAgent(BUILTIN_CODER_ID)).toBe(BUILTIN_CODER)
    expect(builtinAgent('user.custom')).toBeUndefined()
  })

  it('validates all builtin definitions and their default delegation policy', () => {
    for (const agent of BUILTIN_AGENTS) {
      expect(validateAgentDefinition(agent, context)).toEqual({
        ok: true,
        errors: [],
        warnings: [],
      })
    }
    expect(BUILTIN_CODER.delegation).toEqual({
      enabled: true,
      allowedAgents: [BUILTIN_EXPLORER_ID, BUILTIN_REVIEWER_ID, BUILTIN_TESTER_ID],
      maxDepth: 1,
      maxChildrenPerTurn: 6,
      maxParallel: 3,
      childBudgetShare: 0.5,
      defaultWorkspace: 'auto',
      mergeReview: 'user',
    })
  })

  it('keeps the explorer and reviewer strictly read-only', () => {
    for (const agent of [BUILTIN_EXPLORER, BUILTIN_REVIEWER]) {
      expect(agent.permissions).toBe('read-only')
      expect(agent.tools.allow).toEqual(['read_file', 'list_dir', 'search'])
      expect(agent.tools.deny).toBeUndefined()
    }
    expect(BUILTIN_REVIEWER.outputSchema).toMatchObject({
      required: ['issues'],
    })
  })

  it('constrains the tester to test paths and keeps execution behind approval', () => {
    expect(BUILTIN_TESTER.permissions).toBe('ask')
    expect(BUILTIN_TESTER.tools.allow).toEqual([
      'read_file',
      'list_dir',
      'search',
      'write_file',
      'edit_file',
      'run_command',
    ])
    expect(BUILTIN_TESTER.pathPolicy?.write).toEqual(
      expect.arrayContaining(['**/*.{test,spec}.*', '**/tests/**', '**/e2e/**']),
    )
  })
})
