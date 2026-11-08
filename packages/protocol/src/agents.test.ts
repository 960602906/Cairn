import { describe, expect, it } from 'vitest'
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AgentDefinition,
  AgentDiffEndpoint,
  AgentDraftFields,
  AgentDraftInput,
} from './agents.js'

const fields = {
  name: { 'zh-CN': '评审员', 'en-US': 'Reviewer' },
  description: { 'zh-CN': '只读评审', 'en-US': 'Read-only review' },
  instructions: 'Review.',
  model: { mode: 'inherit' as const },
  tools: { allow: ['*'] },
  skills: { allow: ['*'] },
  permissions: 'ask' as const,
  limits: {},
  context: { includeProjectInstructions: true, compaction: 'auto' as const },
  memory: { scopes: ['session' as const], write: 'never' as const },
}

describe('AgentDraftFields', () => {
  it('accepts a minimal definition', () => {
    expect(AgentDraftFields.safeParse(fields).success).toBe(true)
  })

  it('rejects unknown keys (strict)', () => {
    expect(AgentDraftFields.safeParse({ ...fields, extra: true }).success).toBe(false)
  })

  it('rejects instructions over the limit', () => {
    const result = AgentDraftFields.safeParse({
      ...fields,
      instructions: 'x'.repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1),
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown permission mode', () => {
    expect(AgentDraftFields.safeParse({ ...fields, permissions: 'nope' }).success).toBe(false)
  })

  it('accepts an optional delegation policy and validates it', () => {
    expect(AgentDraftFields.safeParse({ ...fields, delegation: undefined }).success).toBe(true)
    expect(
      AgentDraftFields.safeParse({
        ...fields,
        delegation: {
          enabled: true,
          allowedAgents: ['builtin.reviewer'],
          maxDepth: 1,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      }).success,
    ).toBe(true)
    expect(
      AgentDraftFields.safeParse({
        ...fields,
        delegation: {
          enabled: true,
          allowedAgents: [],
          maxDepth: 9,
          maxChildrenPerTurn: 2,
          maxParallel: 2,
          childBudgetShare: 0.5,
          defaultWorkspace: 'shared',
          mergeReview: 'user',
        },
      }).success,
    ).toBe(false)
  })
})

describe('AgentDraftInput', () => {
  it('allows an optional id', () => {
    expect(AgentDraftInput.safeParse(fields).success).toBe(true)
    expect(AgentDraftInput.safeParse({ ...fields, id: 'user.x' }).success).toBe(true)
  })
})

describe('AgentDefinition', () => {
  it('requires version metadata and schema version 1', () => {
    expect(
      AgentDefinition.safeParse({
        ...fields,
        id: 'user.x',
        version: 1,
        source: 'user',
        status: 'published',
        createdAt: 0,
        updatedAt: 0,
        schemaVersion: 1,
      }).success,
    ).toBe(true)
    expect(
      AgentDefinition.safeParse({
        ...fields,
        id: 'user.x',
        version: 1,
        source: 'user',
        status: 'published',
        createdAt: 0,
        updatedAt: 0,
        schemaVersion: 2,
      }).success,
    ).toBe(false)
  })
})

describe('AgentDiffEndpoint', () => {
  it('accepts draft and positive integers, rejects others', () => {
    expect(AgentDiffEndpoint.safeParse('draft').success).toBe(true)
    expect(AgentDiffEndpoint.safeParse(3).success).toBe(true)
    expect(AgentDiffEndpoint.safeParse(0).success).toBe(false)
    expect(AgentDiffEndpoint.safeParse('other').success).toBe(false)
  })
})
