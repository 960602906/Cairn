import { BUILTIN_CODER, BUILTIN_EXPLORER, BUILTIN_REVIEWER, BUILTIN_TESTER } from '@cairn/core'
import { describe, expect, it } from 'vitest'
import type {
  AgentDefinition,
  AgentSummary,
  AgentTeam,
  AgentTeamSummary,
  TeamDraft,
  TeamDraftFields,
  TeamPipelineStage,
} from '@cairn/protocol'
import {
  appendStage,
  coordinatorCandidates,
  defaultTeamDraft,
  memberCandidates,
  normalizeTeamFields,
  referencedAgents,
  removeStage,
  sameTeamFields,
  seedPipeline,
  setStageDependencies,
  stageDependencyOptions,
  teamFieldDiffs,
  teamFieldsOf,
  teamIssues,
  teamSectionOf,
  teamStatus,
  toggleMember,
  validateTeamFields,
} from './model.js'

const summary = (agentId: string, overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId,
  name: { 'zh-CN': agentId },
  description: {},
  source: 'user',
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
  ...overrides,
})

const fields = (overrides: Partial<TeamDraftFields> = {}): TeamDraftFields => ({
  name: { 'zh-CN': '日常协作' },
  description: { 'zh-CN': '说明' },
  coordinator: BUILTIN_CODER.id,
  members: [BUILTIN_EXPLORER.id],
  pattern: 'delegate',
  ...overrides,
})

const stage = (
  stageId: string,
  agent: string,
  dependsOn?: readonly string[],
): TeamPipelineStage => ({
  stage: stageId,
  agent,
  ...(dependsOn === undefined ? {} : { dependsOn: [...dependsOn] }),
})

const definitions: Readonly<Record<string, AgentDefinition>> = {
  [BUILTIN_CODER.id]: BUILTIN_CODER,
  [BUILTIN_EXPLORER.id]: BUILTIN_EXPLORER,
  [BUILTIN_REVIEWER.id]: BUILTIN_REVIEWER,
  [BUILTIN_TESTER.id]: BUILTIN_TESTER,
}

const teamSummary = (overrides: Partial<AgentTeamSummary> = {}): AgentTeamSummary => ({
  teamId: 'user.team-1',
  name: { 'zh-CN': '团队' },
  description: {},
  pattern: 'delegate',
  coordinator: BUILTIN_CODER.id,
  memberCount: 2,
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  updatedAt: 1,
  ...overrides,
})

const draft = (overrides: Partial<TeamDraft> = {}): TeamDraft => ({
  id: 'user.team-1',
  ...fields(),
  ...overrides,
})

const published = (overrides: Partial<AgentTeam> = {}): AgentTeam => ({
  id: 'user.team-1',
  version: 2,
  ...fields(),
  createdAt: 1,
  updatedAt: 2,
  schemaVersion: 1,
  ...overrides,
})

describe('team model', () => {
  it('derives list status from draft / unpublished changes', () => {
    expect(teamStatus(teamSummary({ status: 'draft', hasDraft: true }))).toBe('draft')
    expect(teamStatus(teamSummary({ hasDraft: true }))).toBe('dirty')
    expect(teamStatus(teamSummary())).toBe('published')
    expect(teamStatus(teamSummary({ archived: true, hasDraft: true }))).toBe('archived')
  })

  it('builds a default draft from the built-in agents', () => {
    expect(
      defaultTeamDraft([
        { agentId: BUILTIN_CODER.id },
        { agentId: BUILTIN_EXPLORER.id },
        { agentId: BUILTIN_REVIEWER.id },
        { agentId: BUILTIN_TESTER.id },
      ]),
    ).toEqual({
      name: {},
      description: {},
      coordinator: BUILTIN_CODER.id,
      members: [BUILTIN_EXPLORER.id, BUILTIN_REVIEWER.id, BUILTIN_TESTER.id],
      pattern: 'delegate',
    })
    expect(defaultTeamDraft([])).toMatchObject({ coordinator: '', members: [] })
    expect(defaultTeamDraft([{ agentId: 'user.a' }, { agentId: 'user.b' }])).toMatchObject({
      coordinator: 'user.a',
      members: ['user.b'],
    })
  })

  it('deduplicates referenced agents and drops the empty coordinator', () => {
    expect(
      referencedAgents(
        fields({ coordinator: '', members: [BUILTIN_EXPLORER.id, BUILTIN_EXPLORER.id] }),
      ),
    ).toEqual([BUILTIN_EXPLORER.id])
    expect(referencedAgents(fields({ members: [BUILTIN_CODER.id] }))).toEqual([BUILTIN_CODER.id])
  })

  it('seeds and repairs a review loop', () => {
    expect(
      normalizeTeamFields(fields({ pattern: 'review-loop', members: [BUILTIN_REVIEWER.id] }))
        .reviewLoop,
    ).toEqual({ maker: BUILTIN_CODER.id, checker: BUILTIN_REVIEWER.id, maxRounds: 3 })
    expect(
      normalizeTeamFields(
        fields({ pattern: 'review-loop', coordinator: '', members: [BUILTIN_TESTER.id] }),
      ).reviewLoop,
    ).toEqual({ maker: BUILTIN_TESTER.id, checker: BUILTIN_TESTER.id, maxRounds: 3 })
    expect(
      normalizeTeamFields(fields({ pattern: 'review-loop', coordinator: '', members: [] }))
        .reviewLoop,
    ).toBeUndefined()

    // 引用的成员变了：maker / checker 自动换成仍在引用里的 Agent。
    const stale = fields({
      pattern: 'review-loop',
      members: [BUILTIN_REVIEWER.id],
      reviewLoop: { maker: BUILTIN_EXPLORER.id, checker: BUILTIN_EXPLORER.id, maxRounds: 2 },
    })
    expect(normalizeTeamFields(stale).reviewLoop).toEqual({
      maker: BUILTIN_CODER.id,
      checker: BUILTIN_REVIEWER.id,
      maxRounds: 2,
    })
    expect(
      normalizeTeamFields(
        fields({
          pattern: 'review-loop',
          members: [BUILTIN_TESTER.id],
          reviewLoop: { maker: BUILTIN_CODER.id, checker: BUILTIN_TESTER.id, maxRounds: 2 },
        }),
      ),
    ).toEqual(
      fields({
        pattern: 'review-loop',
        members: [BUILTIN_TESTER.id],
        reviewLoop: { maker: BUILTIN_CODER.id, checker: BUILTIN_TESTER.id, maxRounds: 2 },
      }),
    )

    // 没有任何引用时保留原样，交给校验提示；只剩一个引用时 checker 退回 maker。
    const noRefs = fields({
      pattern: 'review-loop',
      coordinator: '',
      members: [],
      reviewLoop: { maker: 'user.a', checker: 'user.b', maxRounds: 2 },
    })
    expect(normalizeTeamFields(noRefs)).toBe(noRefs)
    expect(
      normalizeTeamFields(
        fields({
          pattern: 'review-loop',
          members: [],
          reviewLoop: { maker: BUILTIN_EXPLORER.id, checker: BUILTIN_EXPLORER.id, maxRounds: 2 },
        }),
      ).reviewLoop,
    ).toEqual({ maker: BUILTIN_CODER.id, checker: BUILTIN_CODER.id, maxRounds: 2 })
  })

  it('seeds a linear pipeline from referenced agents', () => {
    const normalized = normalizeTeamFields(
      fields({ pattern: 'pipeline', members: [BUILTIN_EXPLORER.id, BUILTIN_TESTER.id] }),
    )
    expect(normalized.pipeline).toEqual([
      { stage: 'stage-1', agent: BUILTIN_CODER.id },
      { stage: 'stage-2', agent: BUILTIN_EXPLORER.id, dependsOn: ['stage-1'] },
      { stage: 'stage-3', agent: BUILTIN_TESTER.id, dependsOn: ['stage-2'] },
    ])
    expect(normalizeTeamFields(fields({ pattern: 'pipeline', members: [] }))).toMatchObject({
      pipeline: [{ stage: 'stage-1', agent: BUILTIN_CODER.id }],
    })
    expect(
      normalizeTeamFields(fields({ pattern: 'pipeline', coordinator: '', members: [] })).pipeline,
    ).toEqual([])
    const existing = fields({ pattern: 'pipeline', pipeline: [stage('a', 'user.a')] })
    expect(normalizeTeamFields(existing)).toBe(existing)
  })

  it('appends, removes, and rewires pipeline stages', () => {
    expect(seedPipeline([])).toEqual([])
    expect(appendStage([], 'user.a')).toEqual([{ stage: 'stage-1', agent: 'user.a' }])
    expect(appendStage([stage('stage-1', 'user.a')], 'user.b')).toEqual([
      { stage: 'stage-1', agent: 'user.a' },
      { stage: 'stage-2', agent: 'user.b', dependsOn: ['stage-1'] },
    ])

    const chain = [
      stage('stage-1', 'user.a'),
      stage('stage-2', 'user.b', ['stage-1']),
      stage('stage-3', 'user.c', ['stage-1', 'stage-2']),
    ]
    expect(removeStage(chain, 'stage-1')).toEqual([
      { stage: 'stage-2', agent: 'user.b' },
      { stage: 'stage-3', agent: 'user.c', dependsOn: ['stage-2'] },
    ])
    expect(removeStage(chain, 'stage-2')).toEqual([
      { stage: 'stage-1', agent: 'user.a' },
      { stage: 'stage-3', agent: 'user.c', dependsOn: ['stage-1'] },
    ])
    expect(removeStage([stage('a', 'user.a')], 'missing')).toEqual([stage('a', 'user.a')])

    expect(setStageDependencies(chain, 'stage-3', ['stage-1', 'stage-3', 'missing'])).toEqual([
      stage('stage-1', 'user.a'),
      stage('stage-2', 'user.b', ['stage-1']),
      stage('stage-3', 'user.c', ['stage-1']),
    ])
    expect(setStageDependencies(chain, 'stage-3', [])).toEqual([
      stage('stage-1', 'user.a'),
      stage('stage-2', 'user.b', ['stage-1']),
      { stage: 'stage-3', agent: 'user.c' },
    ])
    expect(setStageDependencies(chain, 'missing', ['stage-1'])).toEqual(chain)
    expect(stageDependencyOptions(chain, 'stage-1')).toEqual([])
    expect(stageDependencyOptions(chain, 'stage-3')).toEqual(chain.slice(0, 2))
    expect(stageDependencyOptions(chain, 'missing')).toEqual([])
  })

  it('validates locally against published definitions', () => {
    expect(validateTeamFields(fields(), definitions)).toMatchObject({ ok: true })
    const missing = validateTeamFields(fields({ coordinator: 'user.missing' }), definitions)
    expect(missing.errors).toContainEqual({
      path: 'coordinator',
      code: 'team.agent_not_found',
      params: { agent: 'user.missing' },
    })
    expect(teamSectionOf('name')).toBe('basic')
    expect(teamSectionOf('description.en-US')).toBe('basic')
    expect(teamSectionOf('members.0')).toBe('members')
    expect(teamSectionOf('reviewLoop.maker')).toBe('pattern')
    expect(teamIssues(missing, 'members', 'errors')).toHaveLength(1)
    expect(teamIssues(missing, 'basic', 'errors')).toEqual([])
    expect(teamIssues(undefined, 'pattern', 'warnings')).toEqual([])
  })

  it('filters coordinator and member candidates', () => {
    const agents = [
      summary(BUILTIN_CODER.id, { source: 'builtin' }),
      summary('user.archived', { archived: true }),
      summary('user.draft', { status: 'draft', hasDraft: true }),
      summary('user.member'),
    ]
    expect(coordinatorCandidates(agents).map((agent) => agent.agentId)).toEqual([
      BUILTIN_CODER.id,
      'user.member',
    ])
    expect(memberCandidates(agents, BUILTIN_CODER.id).map((agent) => agent.agentId)).toEqual([
      'user.member',
    ])
    expect(memberCandidates(agents, 'user.member').map((agent) => agent.agentId)).toEqual([
      BUILTIN_CODER.id,
    ])
  })

  it('toggles members and compares drafts', () => {
    expect(toggleMember([], 'user.a')).toEqual(['user.a'])
    expect(toggleMember(['user.a'], 'user.a')).toEqual([])
    expect(sameTeamFields(fields(), fields())).toBe(true)
    expect(sameTeamFields(fields(), fields({ members: [] }))).toBe(false)
  })

  it('diffs a published version against the current draft', () => {
    expect(teamFieldDiffs(fields(), fields())).toEqual([])
    const current = fields({
      name: { 'zh-CN': '新名字', 'en-US': 'New name' },
      description: { 'en-US': 'English only' },
      coordinator: BUILTIN_TESTER.id,
      members: [BUILTIN_REVIEWER.id],
      pattern: 'review-loop',
      reviewLoop: { maker: BUILTIN_REVIEWER.id, checker: BUILTIN_REVIEWER.id, maxRounds: 2 },
      pipeline: [stage('stage-1', BUILTIN_CODER.id)],
      delegation: { maxDepth: 2 },
    })
    const rows = teamFieldDiffs(fields(), current)
    expect(rows.map((row) => row.path)).toEqual([
      'nameZh',
      'nameEn',
      'descriptionZh',
      'descriptionEn',
      'coordinator',
      'members',
      'pattern',
      'reviewLoop',
      'pipeline',
      'delegation',
    ])
    expect(rows[0]).toEqual({ path: 'nameZh', from: '日常协作', to: '新名字' })
    expect(rows[4]).toEqual({
      path: 'coordinator',
      from: BUILTIN_CODER.id,
      to: BUILTIN_TESTER.id,
    })
    expect(rows[9]).toEqual({ path: 'delegation', from: undefined, to: { maxDepth: 2 } })
  })

  it('extracts editable fields from a draft or the published version', () => {
    expect(teamFieldsOf({ draft: draft() })).toEqual(fields())
    expect(teamFieldsOf({ published: published() })).toEqual(fields())
    expect(teamFieldsOf({ draft: draft(), published: published() })).toEqual(fields())
    expect(teamFieldsOf({})).toBeUndefined()

    const full = draft({
      pattern: 'pipeline',
      pipeline: [stage('stage-1', 'user.a', ['stage-0'])],
      reviewLoop: { maker: 'user.a', checker: 'user.b', maxRounds: 2 },
      delegation: { maxDepth: 2 },
    })
    const extracted = teamFieldsOf({ draft: full })
    expect(extracted).toMatchObject({
      pipeline: [{ stage: 'stage-1', agent: 'user.a', dependsOn: ['stage-0'] }],
      reviewLoop: { maker: 'user.a', checker: 'user.b', maxRounds: 2 },
      delegation: { maxDepth: 2 },
    })
    // 返回的是副本，改它不会碰到原对象。
    extracted!.pipeline![0]!.dependsOn!.push('x')
    expect(full.pipeline![0]!.dependsOn).toEqual(['stage-0'])
  })
})
