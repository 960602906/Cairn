import { describe, expect, it } from 'vitest'
import type { AgentSummary, SkillCatalogEntry } from '@cairn/protocol'
import {
  AGENT_CONTEXT_HEADER,
  expandPromptAgents,
  expandPromptSkills,
  SKILL_CONTEXT_HEADER,
} from './prompt-context.js'

const skill = (name: string, body = `${name} body`): SkillCatalogEntry => ({
  name,
  description: `${name} description`,
  sha256: 'a'.repeat(64),
  source: 'user',
  pinned: false,
  root: `/skills/${name}`,
  body,
  hasScripts: false,
  files: [],
})

const agent = (agentId: string, archived = false): AgentSummary => ({
  agentId,
  name: { 'zh-CN': agentId, 'en-US': agentId },
  description: { 'zh-CN': '描述', 'en-US': 'Description' },
  source: 'user',
  archived,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
})

describe('expandPromptSkills', () => {
  it('keeps only known skills and wraps their bodies', () => {
    expect(
      expandPromptSkills(
        [skill('review'), skill('empty', '  ')],
        [{ name: ' review ' }, { name: 'missing' }, { name: 'review' }],
      ),
    ).toEqual({
      skills: [{ name: 'review' }],
      context: `${SKILL_CONTEXT_HEADER}\n\n<skill name="review">\nreview body\n</skill>`,
    })
  })

  it('has no context when nothing resolves or the body is empty', () => {
    expect(expandPromptSkills([], [{ name: 'review' }])).toEqual({ skills: [], context: undefined })
    expect(expandPromptSkills([skill('empty', '  ')], [{ name: 'empty' }])).toEqual({
      skills: [{ name: 'empty' }],
      context: undefined,
    })
    expect(expandPromptSkills([skill('review')], [])).toEqual({ skills: [], context: undefined })
    expect(expandPromptSkills([skill('review')], [{ name: '   ' }])).toEqual({
      skills: [],
      context: undefined,
    })
  })

  it('escapes attribute text', () => {
    const result = expandPromptSkills([skill('a"b')], [{ name: 'a"b' }])
    expect(result.context).toContain('name="a&quot;b"')
  })
})

describe('expandPromptAgents', () => {
  it('keeps available agents and builds a delegation hint', () => {
    expect(
      expandPromptAgents(
        [agent('user.review'), agent('user.gone', true)],
        [
          { agentId: 'user.review', name: '审查员' },
          { agentId: 'user.gone', name: '已归档' },
          { agentId: 'unknown', name: 'x' },
          { agentId: 'user.review', name: '审查员' },
        ],
      ),
    ).toEqual({
      agents: [{ agentId: 'user.review', name: '审查员' }],
      context: `${AGENT_CONTEXT_HEADER}\n\n<agent id="user.review" name="审查员"/>`,
    })
  })

  it('falls back to the id and ignores everything unknown', () => {
    expect(expandPromptAgents([agent('user.x')], [{ agentId: 'user.x', name: ' ' }])).toEqual({
      agents: [{ agentId: 'user.x', name: 'user.x' }],
      context: `${AGENT_CONTEXT_HEADER}\n\n<agent id="user.x" name="user.x"/>`,
    })
    expect(expandPromptAgents([], [{ agentId: 'user.x', name: 'x' }])).toEqual({
      agents: [],
      context: undefined,
    })
  })
})
