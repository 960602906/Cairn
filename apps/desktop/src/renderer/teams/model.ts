/**
 * 团队模板页面的纯数据辅助（M7-09）：默认草稿、协作模式配置、校验分组与状态。
 *
 * 表单直接使用 `TeamDraftFields`（协议里的形状），编辑器只做不可变更新；校验复用
 * `@cairn/core` 的 `validateAgentTeam`，与主进程保存 / 发布时同一套规则。
 */
import {
  BUILTIN_CODER_ID,
  BUILTIN_EXPLORER_ID,
  BUILTIN_REVIEWER_ID,
  BUILTIN_TESTER_ID,
} from '@cairn/core'
import type {
  AgentDefinition,
  AgentSummary,
  AgentTeam,
  AgentTeamSummary,
  TeamDraft,
  TeamDraftFields,
  TeamPattern,
  TeamPipelineStage,
  TeamValidationIssue,
  TeamValidationResult,
} from '@cairn/protocol'
import { validateAgentTeam } from '@cairn/core'

export type TeamStatus = 'draft' | 'dirty' | 'published'
export type TeamSection = 'basic' | 'members' | 'pattern'

export const TEAM_PATTERNS: readonly TeamPattern[] = ['delegate', 'review-loop', 'pipeline']

/** 列表状态：归档优先（将来有归档入口时），其次草稿 / 有未发布修改 / 已发布。 */
export function teamStatus(team: AgentTeamSummary): TeamStatus {
  if (team.status === 'draft') return 'draft'
  return team.hasDraft ? 'dirty' : 'published'
}

/** 新建模板的默认草稿：主控用内置编程助手，成员预填内置的探索 / 审查 / 测试。 */
export function defaultTeamDraft(
  agents: readonly Pick<AgentSummary, 'agentId'>[],
): TeamDraftFields {
  const ids = new Set(agents.map((agent) => agent.agentId))
  const coordinator = ids.has(BUILTIN_CODER_ID) ? BUILTIN_CODER_ID : (agents[0]?.agentId ?? '')
  const preferred = [BUILTIN_EXPLORER_ID, BUILTIN_REVIEWER_ID, BUILTIN_TESTER_ID].filter(
    (agentId) => ids.has(agentId) && agentId !== coordinator,
  )
  return {
    name: {},
    description: {},
    coordinator,
    members: preferred.length > 0 ? preferred : agents.slice(1, 4).map((agent) => agent.agentId),
    pattern: 'delegate',
  }
}

/** 当前引用的 Agent（主控 + 成员），去重、去掉空 id。 */
export function referencedAgents(fields: TeamDraftFields): string[] {
  return [...new Set([fields.coordinator, ...fields.members])].filter((id) => id !== '')
}

/**
 * 补齐协作模式必需的配置：
 * - `review-loop` 至少要有 maker / checker，默认从主控与成员里挑；
 * - `pipeline` 至少是一组阶段，首次切换时按主控 + 成员生成一条线。
 * 都无法生成时保持缺省，交给校验提示。
 */
export function normalizeTeamFields(fields: TeamDraftFields): TeamDraftFields {
  const referenced = referencedAgents(fields)
  if (fields.pattern === 'review-loop') {
    const current = fields.reviewLoop
    if (current === undefined) {
      const maker = fields.coordinator !== '' ? fields.coordinator : (referenced[0] ?? '')
      if (maker === '') return fields
      const checker = referenced.find((agent) => agent !== maker) ?? maker
      return { ...fields, reviewLoop: { maker, checker, maxRounds: 3 } }
    }
    // 主控或成员变化后，maker / checker 必须仍在引用里，否则换一个可用的。
    if (referenced.length === 0) return fields
    const maker = referenced.includes(current.maker) ? current.maker : referenced[0]!
    const checker = referenced.includes(current.checker)
      ? current.checker
      : (referenced.find((agent) => agent !== maker) ?? maker)
    if (maker === current.maker && checker === current.checker) return fields
    return { ...fields, reviewLoop: { ...current, maker, checker } }
  }
  if (fields.pattern === 'pipeline' && fields.pipeline === undefined) {
    return { ...fields, pipeline: seedPipeline(referenced) }
  }
  return fields
}

/** 按引用顺序生成线性流水线；没有引用时为空数组（校验会提示）。 */
export function seedPipeline(agents: readonly string[]): TeamPipelineStage[] {
  return agents.map((agent, index) => ({
    stage: `stage-${index + 1}`,
    agent,
    ...(index > 0 ? { dependsOn: [`stage-${index}`] } : {}),
  }))
}

/** 新增一个阶段：挂在最后，默认依赖前一个阶段。 */
export function appendStage(
  stages: readonly TeamPipelineStage[],
  agent: string,
): TeamPipelineStage[] {
  const next = stages.length + 1
  const previous = stages.at(-1)?.stage
  return [
    ...stages,
    {
      stage: `stage-${next}`,
      agent,
      ...(previous === undefined ? {} : { dependsOn: [previous] }),
    },
  ]
}

/** 删除阶段，同时从其他阶段的依赖里去掉它。 */
export function removeStage(
  stages: readonly TeamPipelineStage[],
  stageId: string,
): TeamPipelineStage[] {
  return stages
    .filter((stage) => stage.stage !== stageId)
    .map((stage) => {
      const dependsOn = (stage.dependsOn ?? []).filter((dependency) => dependency !== stageId)
      if ((stage.dependsOn ?? []).length === dependsOn.length) return stage
      return dependsOn.length === 0
        ? { stage: stage.stage, agent: stage.agent }
        : { ...stage, dependsOn }
    })
}

/** 设置一个阶段的依赖；只允许依赖排在它前面的阶段，天然不会成环。 */
export function setStageDependencies(
  stages: readonly TeamPipelineStage[],
  stageId: string,
  dependsOn: readonly string[],
): TeamPipelineStage[] {
  const index = stages.findIndex((stage) => stage.stage === stageId)
  if (index < 0) return [...stages]
  const allowed = new Set(stages.slice(0, index).map((stage) => stage.stage))
  const filtered = dependsOn.filter((dependency) => allowed.has(dependency))
  return stages.map((stage, position) => {
    if (position !== index) return stage
    return filtered.length === 0
      ? { stage: stage.stage, agent: stage.agent }
      : { ...stage, dependsOn: filtered }
  })
}

/** 依赖候选：只能选排在这个阶段之前的阶段。 */
export function stageDependencyOptions(
  stages: readonly TeamPipelineStage[],
  stageId: string,
): TeamPipelineStage[] {
  const index = stages.findIndex((stage) => stage.stage === stageId)
  return index <= 0 ? [] : stages.slice(0, index)
}

/** 用已发布的 Agent 定义做本地校验；缺失的定义按“找不到该 Agent”处理。 */
export function validateTeamFields(
  fields: TeamDraftFields,
  definitions: Readonly<Record<string, AgentDefinition>>,
): TeamValidationResult {
  return validateAgentTeam(fields, { agent: (agentId) => definitions[agentId] })
}

/** 校验问题的字段归属。 */
export function teamSectionOf(path: string): TeamSection {
  const head = path.split('.')[0] ?? ''
  if (head === 'name' || head === 'description') return 'basic'
  if (head === 'coordinator' || head === 'members') return 'members'
  return 'pattern'
}

/** 某个分区内的错误 / 警告。 */
export function teamIssues(
  validation: TeamValidationResult | undefined,
  section: TeamSection,
  kind: 'errors' | 'warnings',
): readonly TeamValidationIssue[] {
  return (validation?.[kind] ?? []).filter((issue) => teamSectionOf(issue.path) === section)
}

/** 主控候选：有已发布版本且未归档的 Agent（校验与试运行都读已发布版本）。 */
export function coordinatorCandidates(agents: readonly AgentSummary[]): readonly AgentSummary[] {
  return agents.filter((agent) => !agent.archived && agent.status === 'published')
}

/** 成员候选：除主控外的已发布 Agent。 */
export function memberCandidates(
  agents: readonly AgentSummary[],
  coordinator: string,
): readonly AgentSummary[] {
  return coordinatorCandidates(agents).filter((agent) => agent.agentId !== coordinator)
}

/** 在主控 / 成员之间切换一个成员。 */
export function toggleMember(members: readonly string[], agentId: string): string[] {
  return members.includes(agentId)
    ? members.filter((member) => member !== agentId)
    : [...members, agentId]
}

/** 草稿是否与基线不同（用于“有未发布修改”与离开确认）。 */
export function sameTeamFields(a: TeamDraftFields, b: TeamDraftFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 从详情里取出可编辑字段：草稿优先，其次最新的已发布版本。 */
export function teamFieldsOf(detail: {
  readonly draft?: TeamDraft | undefined
  readonly published?: AgentTeam | undefined
}): TeamDraftFields | undefined {
  const source = detail.draft ?? detail.published
  if (source === undefined) return undefined
  return {
    name: { ...source.name },
    description: { ...source.description },
    coordinator: source.coordinator,
    members: [...source.members],
    pattern: source.pattern,
    ...(source.pipeline === undefined
      ? {}
      : {
          pipeline: source.pipeline.map((stage) => ({
            stage: stage.stage,
            agent: stage.agent,
            ...(stage.dependsOn === undefined ? {} : { dependsOn: [...stage.dependsOn] }),
          })),
        }),
    ...(source.reviewLoop === undefined ? {} : { reviewLoop: { ...source.reviewLoop } }),
    ...(source.delegation === undefined ? {} : { delegation: { ...source.delegation } }),
  }
}
