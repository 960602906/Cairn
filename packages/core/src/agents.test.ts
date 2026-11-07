import { describe, expect, it } from 'vitest'
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  type AgentDraftFields,
  type SkillCatalogEntry,
} from '@cairn/protocol'
import {
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
})
