/**
 * 团队模板校验（M7-06，多 Agent 协作 §15）。
 *
 * 与 `validateAgentDefinition` 一样，校验只依赖传入的上下文，不读存储、不连 MCP：
 * - 主控必须存在且启用了委派；
 * - 成员去重、不能包含主控自身，未知 Agent 直接报错；
 * - `review-loop` 的 maker / checker 必须在模板引用的 Agent 里且不能是同一个；
 * - `pipeline` 的阶段 id 唯一，`dependsOn` 必须引用同一模板里的阶段并构成 DAG。
 *
 * 问题的 `path` 指向字段，`code` 由界面翻译；已存在的 Agent 但未被主控允许委派只给警告，
 * 因为运行时仍会按主控的实际策略再收敛一次。
 */
import type {
  AgentDefinition,
  AgentTeam,
  TeamDraftFields,
  TeamPipelineStage,
  TeamValidationIssue,
  TeamValidationResult,
} from '@cairn/protocol'
import {
  BUILTIN_CODER_ID,
  BUILTIN_EXPLORER_ID,
  BUILTIN_REVIEWER_ID,
  BUILTIN_TESTER_ID,
} from './agents.js'
import { resolveDelegationPolicy } from './delegation.js'

/** 校验需要的上下文：按 id 取最新的已发布定义（含内置 Agent）。 */
export interface TeamValidationContext {
  readonly agent: (agentId: string) => AgentDefinition | undefined
}

const hasText = (value: {
  readonly 'zh-CN'?: string | undefined
  readonly 'en-US'?: string | undefined
}): boolean => (value['zh-CN'] ?? '').trim() !== '' || (value['en-US'] ?? '').trim() !== ''

const issue = (
  path: string,
  code: string,
  params?: Record<string, string | number | boolean>,
): TeamValidationIssue => ({ path, code, ...(params === undefined ? {} : { params }) })

/**
 * pipeline 阶段的拓扑顺序（依赖在前）。未知依赖或环返回 `undefined`，
 * 由校验把具体问题记到对应阶段上。
 */
export function teamPipelineOrder(
  stages: readonly TeamPipelineStage[],
): TeamPipelineStage[] | undefined {
  const byId = new Map(stages.map((stage) => [stage.stage, stage]))
  const remaining = new Map(stages.map((stage) => [stage.stage, (stage.dependsOn ?? []).length]))
  const dependents = new Map<string, string[]>()
  for (const stage of stages) {
    for (const dependency of stage.dependsOn ?? []) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), stage.stage])
    }
  }
  /* v8 ignore next -- remaining 用同一组 stages 的 id 初始化，get 一定有值 */
  const ready = stages.filter((stage) => (remaining.get(stage.stage) ?? 0) === 0)
  const ordered: TeamPipelineStage[] = []
  while (ready.length > 0) {
    const stage = ready.shift()!
    ordered.push(stage)
    for (const next of dependents.get(stage.stage) ?? []) {
      /* v8 ignore next -- next 是同一组 stages 里的依赖方，remaining 一定有它的计数 */
      const left = (remaining.get(next) ?? 0) - 1
      remaining.set(next, left)
      if (left === 0) {
        const resolved = byId.get(next)
        /* v8 ignore next -- next 一定来自同一组 stages，byId 必能取到 */
        if (resolved) ready.push(resolved)
      }
    }
  }
  return ordered.length === stages.length ? ordered : undefined
}

/** 校验一份团队模板草稿。 */
export function validateAgentTeam(
  team: TeamDraftFields,
  context: TeamValidationContext,
): TeamValidationResult {
  const errors: TeamValidationIssue[] = []
  const warnings: TeamValidationIssue[] = []

  if (!hasText(team.name)) errors.push(issue('name', 'team.name_required'))
  if (!hasText(team.description)) errors.push(issue('description', 'team.description_required'))

  const coordinator = context.agent(team.coordinator)
  if (!coordinator) {
    errors.push(issue('coordinator', 'team.agent_not_found', { agent: team.coordinator }))
  } else if (coordinator.delegation?.enabled !== true) {
    errors.push(issue('coordinator', 'team.coordinator_cannot_delegate'))
  }

  const seen = new Set<string>()
  team.members.forEach((member, index) => {
    if (member === team.coordinator) {
      errors.push(issue(`members.${index}`, 'team.member_is_coordinator'))
    }
    if (seen.has(member)) {
      errors.push(issue(`members.${index}`, 'team.member_duplicate', { agent: member }))
    }
    seen.add(member)
    if (!context.agent(member)) {
      errors.push(issue(`members.${index}`, 'team.agent_not_found', { agent: member }))
    }
  })

  const referenced = new Set([team.coordinator, ...team.members])

  if (team.pattern === 'review-loop') {
    const loop = team.reviewLoop
    if (!loop) {
      errors.push(issue('reviewLoop', 'team.review_loop_required'))
    } else {
      for (const [path, agent] of [
        ['reviewLoop.maker', loop.maker],
        ['reviewLoop.checker', loop.checker],
      ] as const) {
        if (!referenced.has(agent)) {
          errors.push(issue(path, 'team.review_agent_missing', { agent }))
        }
      }
      if (loop.maker === loop.checker) errors.push(issue('reviewLoop', 'team.review_same_agent'))
    }
  }

  if (team.pattern === 'pipeline') {
    const stages = team.pipeline ?? []
    if (stages.length === 0) {
      errors.push(issue('pipeline', 'team.pipeline_required'))
    } else {
      const stageIds = new Set<string>()
      stages.forEach((stage, index) => {
        if (stageIds.has(stage.stage)) {
          errors.push(
            issue(`pipeline.${index}.stage`, 'team.stage_duplicate', { stage: stage.stage }),
          )
        }
        stageIds.add(stage.stage)
        if (!context.agent(stage.agent)) {
          errors.push(
            issue(`pipeline.${index}.agent`, 'team.agent_not_found', { agent: stage.agent }),
          )
        }
        for (const dependency of stage.dependsOn ?? []) {
          if (dependency === stage.stage) {
            errors.push(
              issue(`pipeline.${index}.dependsOn`, 'team.stage_dependency_self', {
                stage: stage.stage,
              }),
            )
          } else if (!stages.some((candidate) => candidate.stage === dependency)) {
            errors.push(
              issue(`pipeline.${index}.dependsOn`, 'team.stage_dependency_unknown', {
                stage: stage.stage,
                dependsOn: dependency,
              }),
            )
          }
        }
      })
      if (teamPipelineOrder(stages) === undefined) {
        errors.push(issue('pipeline', 'team.stage_cycle'))
      }
    }
  }

  if (team.pattern === 'delegate') {
    if (team.pipeline !== undefined && team.pipeline.length > 0) {
      warnings.push(issue('pipeline', 'team.pattern_ignores_pipeline'))
    }
    if (team.reviewLoop !== undefined) {
      warnings.push(issue('reviewLoop', 'team.pattern_ignores_review_loop'))
    }
  }

  const allowed = team.delegation?.allowedAgents
  if (allowed !== undefined) {
    allowed.forEach((agent, index) => {
      if (!context.agent(agent)) {
        errors.push(issue(`delegation.allowedAgents.${index}`, 'team.agent_not_found', { agent }))
      }
    })
    for (const member of new Set(team.members)) {
      if (!allowed.includes(member)) {
        warnings.push(
          issue('delegation.allowedAgents', 'team.member_not_allowed', { agent: member }),
        )
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 团队模板给模型的协作说明（M7-09）：接到主控 Agent 的指令后面。 */
export function teamBrief(team: TeamDraftFields): string {
  const name = team.name['zh-CN']?.trim() || team.name['en-US']?.trim() || ''
  const lines = [`# Team${name === '' ? '' : `: ${name}`}`, `Pattern: ${team.pattern}`]
  lines.push(`Members: ${team.members.length === 0 ? '(none)' : team.members.join(', ')}`)
  if (team.pattern === 'review-loop' && team.reviewLoop !== undefined) {
    const { maker, checker, maxRounds } = team.reviewLoop
    lines.push(`Review loop: maker=${maker}, checker=${checker}, maxRounds=${maxRounds}`)
    lines.push('Use the review_loop tool to run maker -> checker rounds.')
  }
  if (team.pattern === 'pipeline' && team.pipeline !== undefined) {
    const stages = team.pipeline.map((stage) => {
      const dependsOn = stage.dependsOn ?? []
      return dependsOn.length === 0
        ? `${stage.stage}(${stage.agent})`
        : `${stage.stage}(${stage.agent} after ${dependsOn.join('+')})`
    })
    lines.push(`Pipeline: ${stages.join(' -> ')}`)
    lines.push('Use the run_pipeline tool to execute the stages above.')
  }
  if (team.pattern === 'delegate') lines.push('Delegate sub-tasks with the delegate tool.')
  return lines.join('\n')
}

/**
 * 选用团队模板（M7-09）：把模板的委派覆盖与协作说明并进主控 Agent 的定义。
 * 只影响这一次运行使用的定义，不改写 Agent 本身；模板里省略的策略字段沿用主控的设置。
 */
export function applyTeamToAgentDefinition(
  definition: AgentDefinition,
  team: TeamDraftFields,
): AgentDefinition {
  // 模板的 `delegation` 是部分覆盖；显式去掉 `undefined`，让省略的字段沿用主控的设置。
  const overrides = Object.fromEntries(
    Object.entries(team.delegation ?? {}).filter(([, value]) => value !== undefined),
  )
  const policy = resolveDelegationPolicy({ ...definition.delegation, ...overrides })
  const brief = teamBrief(team)
  const instructions = definition.instructions.trim()
  return {
    ...definition,
    delegation: policy,
    instructions: instructions === '' ? brief : `${instructions}\n\n${brief}`,
  }
}

/** 内置团队模板（M7-09 补充）：与内置 Agent 一样由代码提供、只读，版本随应用。 */
export const BUILTIN_TEAM_REVIEW_LOOP_ID = 'builtin.team-review-loop'
export const BUILTIN_TEAM_EXPLORE_BUILD_ID = 'builtin.team-explore-build'
export const BUILTIN_TEAM_PIPELINE_ID = 'builtin.team-pipeline'

const builtinTeamVersion = { version: 1, createdAt: 0, updatedAt: 0, schemaVersion: 1 } as const

/**
 * 内置模板只引用内置 Agent，任何安装上都能直接选用。
 * 覆盖三种协作模式，方便用户第一次打开就有可用的范例。
 */
export const BUILTIN_TEAMS: readonly AgentTeam[] = [
  {
    ...builtinTeamVersion,
    id: BUILTIN_TEAM_REVIEW_LOOP_ID,
    name: { 'zh-CN': '代码审查小组', 'en-US': 'Code review pair' },
    description: {
      'zh-CN': '主控先实现，审查员只读检查并按严重程度指出问题；有阻塞问题就返工，最多两轮。',
      'en-US':
        'The coordinator implements while a read-only reviewer reports issues by severity; blocking findings trigger a rework round, up to two rounds.',
    },
    coordinator: BUILTIN_CODER_ID,
    members: [BUILTIN_REVIEWER_ID, BUILTIN_EXPLORER_ID],
    pattern: 'review-loop',
    reviewLoop: {
      maker: BUILTIN_CODER_ID,
      checker: BUILTIN_REVIEWER_ID,
      maxRounds: 2,
    },
  },
  {
    ...builtinTeamVersion,
    id: BUILTIN_TEAM_EXPLORE_BUILD_ID,
    name: { 'zh-CN': '探索与实现', 'en-US': 'Explore and build' },
    description: {
      'zh-CN': '主控先让探索员定位代码与依赖，再自己动手修改；需要时把补测试交给测试员。',
      'en-US':
        'The coordinator has an explorer locate the relevant code and dependencies first, then makes the changes, and hands test work to the tester when needed.',
    },
    coordinator: BUILTIN_CODER_ID,
    members: [BUILTIN_EXPLORER_ID, BUILTIN_TESTER_ID],
    pattern: 'delegate',
  },
  {
    ...builtinTeamVersion,
    id: BUILTIN_TEAM_PIPELINE_ID,
    name: { 'zh-CN': '实现流水线', 'en-US': 'Build pipeline' },
    description: {
      'zh-CN': '按探索、实现、测试三个阶段依次执行，前后依赖固定，适合边界清楚的功能开发。',
      'en-US':
        'Runs explore, build, and test as fixed dependent stages, suited to well-scoped feature work.',
    },
    coordinator: BUILTIN_CODER_ID,
    members: [BUILTIN_EXPLORER_ID, BUILTIN_TESTER_ID],
    pattern: 'pipeline',
    pipeline: [
      { stage: 'explore', agent: BUILTIN_EXPLORER_ID },
      { stage: 'build', agent: BUILTIN_CODER_ID, dependsOn: ['explore'] },
      { stage: 'test', agent: BUILTIN_TESTER_ID, dependsOn: ['build'] },
    ],
  },
]

export const builtinTeam = (teamId: string): AgentTeam | undefined =>
  BUILTIN_TEAMS.find((team) => team.id === teamId)
