import type { AgentDefinition, TeamDraftFields, TeamPipelineStage } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CODER,
  BUILTIN_EXPLORER,
  BUILTIN_REVIEWER,
  BUILTIN_TESTER,
  builtinAgent,
} from './agents.js'
import {
  applyTeamToAgentDefinition,
  BUILTIN_TEAMS,
  builtinTeam,
  teamBrief,
  teamPipelineOrder,
  validateAgentTeam,
  type TeamValidationContext,
} from './teams.js'

const noDelegation: AgentDefinition = {
  ...BUILTIN_CODER,
  id: 'user.solo',
  delegation: { ...BUILTIN_CODER.delegation!, enabled: false },
}

const context: TeamValidationContext = {
  agent: (agentId) =>
    [BUILTIN_CODER, BUILTIN_EXPLORER, BUILTIN_REVIEWER, BUILTIN_TESTER, noDelegation].find(
      (agent) => agent.id === agentId,
    ),
}

const delegateTeam: TeamDraftFields = {
  name: { 'zh-CN': '日常协作' },
  description: { 'zh-CN': '主控分派给只读探索员' },
  coordinator: BUILTIN_CODER.id,
  members: [BUILTIN_EXPLORER.id],
  pattern: 'delegate',
}

const stage = (
  stageId: string,
  agent: string,
  dependsOn?: readonly string[],
): TeamPipelineStage => ({
  stage: stageId,
  agent,
  ...(dependsOn === undefined ? {} : { dependsOn: [...dependsOn] }),
})

const codes = (result: { errors: { code: string }[]; warnings: { code: string }[] }): string[] => [
  ...result.errors.map((item) => item.code),
  ...result.warnings.map((item) => item.code),
]

describe('validateAgentTeam（M7-06）', () => {
  it('接受一份完整的 delegate 模板', () => {
    expect(validateAgentTeam(delegateTeam, context)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    })
  })

  it('要求名称与描述至少一种语言', () => {
    const result = validateAgentTeam(
      { ...delegateTeam, name: {}, description: { 'en-US': '   ' } },
      context,
    )
    expect(codes(result)).toEqual(['team.name_required', 'team.description_required'])
  })

  it('要求主控存在且启用了委派', () => {
    const missing = validateAgentTeam({ ...delegateTeam, coordinator: 'user.missing' }, context)
    expect(missing.errors).toContainEqual({
      path: 'coordinator',
      code: 'team.agent_not_found',
      params: { agent: 'user.missing' },
    })
    const solo = validateAgentTeam({ ...delegateTeam, coordinator: noDelegation.id }, context)
    expect(solo.errors).toContainEqual({
      path: 'coordinator',
      code: 'team.coordinator_cannot_delegate',
    })
  })

  it('成员去重、不能是主控自身、必须存在', () => {
    const result = validateAgentTeam(
      {
        ...delegateTeam,
        members: [BUILTIN_EXPLORER.id, BUILTIN_EXPLORER.id, BUILTIN_CODER.id, 'user.missing'],
      },
      context,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.map((item) => [item.path, item.code])).toEqual([
      ['members.1', 'team.member_duplicate'],
      ['members.2', 'team.member_is_coordinator'],
      ['members.3', 'team.agent_not_found'],
    ])
  })

  it('review-loop 需要 maker 与 checker，且不能是同一个', () => {
    const base: TeamDraftFields = {
      ...delegateTeam,
      pattern: 'review-loop',
      members: [BUILTIN_TESTER.id, BUILTIN_REVIEWER.id],
    }
    expect(codes(validateAgentTeam(base, context))).toEqual(['team.review_loop_required'])

    const missing = validateAgentTeam(
      {
        ...base,
        reviewLoop: { maker: BUILTIN_TESTER.id, checker: BUILTIN_EXPLORER.id, maxRounds: 2 },
      },
      context,
    )
    expect(missing.errors).toContainEqual({
      path: 'reviewLoop.checker',
      code: 'team.review_agent_missing',
      params: { agent: BUILTIN_EXPLORER.id },
    })

    const same = validateAgentTeam(
      {
        ...base,
        reviewLoop: { maker: BUILTIN_TESTER.id, checker: BUILTIN_TESTER.id, maxRounds: 2 },
      },
      context,
    )
    expect(codes(same)).toEqual(['team.review_same_agent'])

    const ok = validateAgentTeam(
      {
        ...base,
        reviewLoop: { maker: BUILTIN_TESTER.id, checker: BUILTIN_REVIEWER.id, maxRounds: 2 },
      },
      context,
    )
    expect(ok).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('pipeline 要求阶段唯一、依赖存在且构成 DAG', () => {
    const base: TeamDraftFields = {
      ...delegateTeam,
      pattern: 'pipeline',
      members: [BUILTIN_TESTER.id, BUILTIN_REVIEWER.id],
    }
    expect(codes(validateAgentTeam({ ...base, pipeline: [] }, context))).toEqual([
      'team.pipeline_required',
    ])
    expect(codes(validateAgentTeam({ ...base, pipeline: undefined }, context))).toEqual([
      'team.pipeline_required',
    ])

    const broken = validateAgentTeam(
      {
        ...base,
        pipeline: [
          stage('build', BUILTIN_TESTER.id, ['missing']),
          stage('build', 'user.missing', ['build']),
          stage('check', BUILTIN_REVIEWER.id, ['build']),
        ],
      },
      context,
    )
    expect(broken.errors.map((item) => [item.path, item.code])).toEqual([
      ['pipeline.0.dependsOn', 'team.stage_dependency_unknown'],
      ['pipeline.1.stage', 'team.stage_duplicate'],
      ['pipeline.1.agent', 'team.agent_not_found'],
      ['pipeline.1.dependsOn', 'team.stage_dependency_self'],
      ['pipeline', 'team.stage_cycle'],
    ])

    const ok = validateAgentTeam(
      {
        ...base,
        pipeline: [
          stage('build', BUILTIN_TESTER.id),
          stage('check', BUILTIN_REVIEWER.id, ['build']),
        ],
      },
      context,
    )
    expect(ok).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('delegate 模板里多余的 pipeline / reviewLoop 只给警告', () => {
    const result = validateAgentTeam(
      {
        ...delegateTeam,
        pipeline: [stage('build', BUILTIN_EXPLORER.id)],
        reviewLoop: { maker: BUILTIN_EXPLORER.id, checker: BUILTIN_CODER.id, maxRounds: 1 },
      },
      context,
    )
    expect(result.ok).toBe(true)
    expect(result.warnings.map((item) => item.code)).toEqual([
      'team.pattern_ignores_pipeline',
      'team.pattern_ignores_review_loop',
    ])
  })

  it('模板的委派覆盖要引用存在的 Agent，成员不在名单里只给警告', () => {
    const unknown = validateAgentTeam(
      { ...delegateTeam, delegation: { allowedAgents: ['user.missing'] } },
      context,
    )
    expect(unknown.errors).toContainEqual({
      path: 'delegation.allowedAgents.0',
      code: 'team.agent_not_found',
      params: { agent: 'user.missing' },
    })

    const notAllowed = validateAgentTeam(
      { ...delegateTeam, delegation: { allowedAgents: [BUILTIN_REVIEWER.id] } },
      context,
    )
    expect(notAllowed.ok).toBe(true)
    expect(notAllowed.warnings).toContainEqual({
      path: 'delegation.allowedAgents',
      code: 'team.member_not_allowed',
      params: { agent: BUILTIN_EXPLORER.id },
    })

    const allowed = validateAgentTeam(
      { ...delegateTeam, delegation: { allowedAgents: [BUILTIN_EXPLORER.id] } },
      context,
    )
    expect(allowed).toEqual({ ok: true, errors: [], warnings: [] })
  })
})

describe('teamPipelineOrder（M7-06）', () => {
  it('把依赖排在前面，并保留无依赖阶段的原始顺序', () => {
    const stages = [
      stage('check', BUILTIN_REVIEWER.id, ['build', 'test']),
      stage('build', BUILTIN_TESTER.id),
      stage('test', BUILTIN_TESTER.id, ['build']),
      stage('docs', BUILTIN_EXPLORER.id),
    ]
    expect(teamPipelineOrder(stages)?.map((item) => item.stage)).toEqual([
      'build',
      'docs',
      'test',
      'check',
    ])
  })

  it('依赖成环时返回 undefined', () => {
    expect(
      teamPipelineOrder([
        stage('a', BUILTIN_TESTER.id, ['b']),
        stage('b', BUILTIN_TESTER.id, ['a']),
      ]),
    ).toBeUndefined()
  })
})

describe('团队模板的定义合并（M7-09）', () => {
  const loopTeam: TeamDraftFields = {
    name: { 'zh-CN': '审查小组', 'en-US': 'Review crew' },
    description: { 'zh-CN': '审查循环' },
    coordinator: BUILTIN_CODER.id,
    members: [BUILTIN_REVIEWER.id, BUILTIN_TESTER.id],
    pattern: 'review-loop',
    reviewLoop: { maker: BUILTIN_TESTER.id, checker: BUILTIN_REVIEWER.id, maxRounds: 2 },
    delegation: { maxChildrenPerTurn: 4 },
  }

  it('用模板的委派覆盖收紧主控策略，省略的字段沿用主控', () => {
    const merged = applyTeamToAgentDefinition(BUILTIN_CODER, loopTeam)
    expect(merged.delegation).toMatchObject({
      enabled: true,
      maxChildrenPerTurn: 4,
      allowedAgents: BUILTIN_CODER.delegation?.allowedAgents,
      maxDepth: BUILTIN_CODER.delegation?.maxDepth,
    })
    expect(merged.id).toBe(BUILTIN_CODER.id)
  })

  it('把协作方式写进指令，原有指令保留在前', () => {
    const merged = applyTeamToAgentDefinition(
      { ...BUILTIN_CODER, instructions: '先看需求。' },
      loopTeam,
    )
    expect(merged.instructions.startsWith('先看需求。')).toBe(true)
    expect(merged.instructions).toContain('# Team: 审查小组')
    expect(merged.instructions).toContain(`maker=${BUILTIN_TESTER.id}`)
    expect(merged.instructions).toContain('review_loop')
    const briefOnly = applyTeamToAgentDefinition({ ...BUILTIN_CODER, instructions: '  ' }, loopTeam)
    expect(briefOnly.instructions).toBe(teamBrief(loopTeam))
  })

  it('pipeline 与 delegate 的说明各自列出阶段或委派方式', () => {
    const pipelineTeam: TeamDraftFields = {
      ...loopTeam,
      pattern: 'pipeline',
      reviewLoop: undefined,
      pipeline: [
        { stage: 'build', agent: BUILTIN_TESTER.id },
        { stage: 'check', agent: BUILTIN_REVIEWER.id, dependsOn: ['build'] },
      ],
    }
    const brief = teamBrief(pipelineTeam)
    expect(brief).toContain('build(builtin.tester)')
    expect(brief).toContain('check(builtin.reviewer after build)')
    expect(brief).toContain('run_pipeline')
    expect(teamBrief(delegateTeam)).toContain('delegate tool')
    expect(brief).not.toContain('delegate tool')
  })

  it('团队说明在没有名称、没有成员时也能生成，并优先使用中文名', () => {
    const empty = teamBrief({
      ...delegateTeam,
      name: {},
      members: [],
      delegation: undefined,
    })
    expect(empty).toContain('# Team\nPattern: delegate')
    expect(empty).toContain('Members: (none)')

    const english = teamBrief({ ...delegateTeam, name: { 'en-US': '  Crew  ' } })
    expect(english.startsWith('# Team: Crew\n')).toBe(true)
    expect(teamBrief({ ...delegateTeam, name: { 'zh-CN': ' 中文 ', 'en-US': 'Crew' } })).toContain(
      '# Team: 中文',
    )
  })

  it('模板里显式 undefined 的委派字段不覆盖主控设置', () => {
    const merged = applyTeamToAgentDefinition(BUILTIN_CODER, {
      ...loopTeam,
      delegation: { maxChildrenPerTurn: undefined, maxDepth: 2 },
    })
    expect(merged.delegation).toMatchObject({
      maxChildrenPerTurn: BUILTIN_CODER.delegation?.maxChildrenPerTurn,
      maxDepth: 2,
    })
  })

  it('模板没有委派覆盖时沿用主控策略', () => {
    const merged = applyTeamToAgentDefinition(BUILTIN_CODER, delegateTeam)
    expect(merged.delegation).toEqual(BUILTIN_CODER.delegation)
  })
})

describe('内置团队模板', () => {
  it('每个内置模板都能通过校验，且覆盖三种协作模式', () => {
    for (const team of BUILTIN_TEAMS) {
      expect(validateAgentTeam(team, context), team.id).toEqual({
        ok: true,
        errors: [],
        warnings: [],
      })
    }
    expect(BUILTIN_TEAMS.map((team) => team.pattern).sort()).toEqual([
      'delegate',
      'pipeline',
      'review-loop',
    ])
  })

  it('全部引用内置 Agent，id 唯一且从 1 版开始', () => {
    const ids = BUILTIN_TEAMS.map((team) => team.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const team of BUILTIN_TEAMS) {
      expect(team.version).toBe(1)
      expect([team.coordinator, ...team.members].every((agent) => builtinAgent(agent))).toBe(true)
    }
  })

  it('按 id 查找内置模板', () => {
    expect(builtinTeam(BUILTIN_TEAMS[0]!.id)).toBe(BUILTIN_TEAMS[0])
    expect(builtinTeam('user.team-1')).toBeUndefined()
  })
})
