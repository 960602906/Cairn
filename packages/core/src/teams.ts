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
  TeamDraftFields,
  TeamPipelineStage,
  TeamValidationIssue,
  TeamValidationResult,
} from '@cairn/protocol'

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
  const ready = stages.filter((stage) => (remaining.get(stage.stage) ?? 0) === 0)
  const ordered: TeamPipelineStage[] = []
  while (ready.length > 0) {
    const stage = ready.shift()!
    ordered.push(stage)
    for (const next of dependents.get(stage.stage) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1
      remaining.set(next, left)
      if (left === 0) {
        const resolved = byId.get(next)
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
