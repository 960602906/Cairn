/**
 * pipeline 模板执行（M7-08，多 Agent 协作 §15）：按 `dependsOn` 拓扑执行固定阶段。
 *
 * - 无依赖的阶段可并发，受调用方给出的 `maxParallel`（来自委派策略）约束；
 * - 某阶段失败/被停止/触发限额时，后续未开始的阶段全部跳过，已完成阶段的结果保留；
 * - 本节只做编排；每个阶段实际是一个只读子运行，由宿主用 `runDelegation` 创建。
 */
import {
  TASK_BRIEF_CONTEXT_MAX_CHARS,
  TASK_BRIEF_DELIVERABLE_MAX_CHARS,
  TASK_BRIEF_FILES_MAX,
  TASK_BRIEF_FILE_PATH_MAX_CHARS,
  TASK_BRIEF_GOAL_MAX_CHARS,
  TEAM_MAX_PIPELINE_STAGES,
  type DelegateStatus,
  type TeamPipelineStage,
} from '@cairn/protocol'
import { z } from 'zod'
import type { RuntimeToolSpec } from './runtime.js'
import type { DelegateTargetInfo } from './delegation.js'
import { teamPipelineOrder } from './teams.js'

/** 整条流水线的结局；阶段失败会立即结束，不再开始后续阶段。 */
export type PipelineStatus = 'completed' | 'failed' | 'stopped' | 'limit_reached'

/** 结论没有给出摘要时的兜底说明（按流水线结局）。 */
const PIPELINE_FALLBACK_SUMMARY: Readonly<Record<PipelineStatus, string>> = {
  completed: 'All pipeline stages completed.',
  failed: 'The pipeline failed.',
  stopped: 'The pipeline was stopped.',
  limit_reached: 'The pipeline reached an agent limit.',
}

/** 一个阶段的执行结果；`upstream` 会作为后续阶段任务书里的上下文。 */
export interface PipelineStageOutcome {
  readonly stage: string
  readonly runId: string
  readonly status: DelegateStatus
  readonly summary: string
}

export interface RunPipelineDeps {
  readonly stages: readonly TeamPipelineStage[]
  /** 同时运行的阶段数；由宿主的委派策略收缩。 */
  readonly maxParallel: number
  readonly runStage: (input: {
    readonly stage: TeamPipelineStage
    readonly upstream: readonly PipelineStageOutcome[]
  }) => Promise<PipelineStageOutcome>
  /** 每个阶段结束后回调（宿主写事件）。 */
  readonly onStage?: (result: PipelineStageOutcome) => void
  /** 父运行被中止或已无预算：不再开始新阶段。 */
  readonly stopped?: () => boolean
}

export interface PipelineResult {
  readonly status: PipelineStatus
  readonly stages: readonly PipelineStageOutcome[]
  /** 因前面阶段失败或被停止而没有执行的阶段。 */
  readonly skipped: readonly string[]
  readonly summary: string
}

const failureStatus = (status: DelegateStatus): PipelineStatus | undefined => {
  if (status === 'completed') return undefined
  if (status === 'failed') return 'failed'
  if (status === 'limit_reached') return 'limit_reached'
  // `aborted` 与 `needs_input` 都不能继续流水线：子运行没有提问通道。
  return 'stopped'
}

/** 按依赖关系分波执行阶段；同一波内并发，波次之间串行。 */
export async function runTeamPipeline(deps: RunPipelineDeps): Promise<PipelineResult> {
  const ordered = teamPipelineOrder(deps.stages)
  if (ordered === undefined) {
    return {
      status: 'failed',
      stages: [],
      skipped: deps.stages.map((stage) => stage.stage),
      summary: 'The pipeline stages do not form a valid dependency graph.',
    }
  }
  const pending = new Map(ordered.map((stage) => [stage.stage, stage]))
  const completed = new Map<string, PipelineStageOutcome>()
  const outcomes: PipelineStageOutcome[] = []
  const skipped: string[] = []
  const maxParallel = Math.max(1, Math.min(deps.maxParallel, ordered.length))
  let status: PipelineStatus = 'completed'

  while (pending.size > 0) {
    if (deps.stopped?.()) {
      status = 'stopped'
      break
    }
    const ready = [...pending.values()].filter((stage) =>
      (stage.dependsOn ?? []).every((dependency) => completed.has(dependency)),
    )
    const batch = ready.slice(0, maxParallel)
    const results = await Promise.all(
      batch.map((stage) =>
        deps.runStage({
          stage,
          // 依赖图已由 `teamPipelineOrder` 校验过，依赖一定在上一波完成。
          upstream: (stage.dependsOn ?? []).map((dependency) => completed.get(dependency)!),
        }),
      ),
    )
    for (const [index, result] of results.entries()) {
      const stage = batch[index]!
      pending.delete(stage.stage)
      outcomes.push(result)
      completed.set(stage.stage, result)
      deps.onStage?.(result)
      const failed = failureStatus(result.status)
      if (failed !== undefined && status === 'completed') status = failed
    }
    if (status !== 'completed') break
  }

  for (const stageId of pending.keys()) skipped.push(stageId)

  const last = outcomes.at(-1)
  const failedStage = outcomes.find((outcome) => outcome.status !== 'completed')
  const summary =
    (status === 'completed' ? last?.summary : failedStage?.summary) ??
    PIPELINE_FALLBACK_SUMMARY[status]

  return { status, stages: outcomes, skipped, summary }
}

/** `run_pipeline` 给模型看的名称（M7-08）。 */
export const RUN_PIPELINE_TOOL_NAME = 'run_pipeline'

/** 流水线阶段：在模板阶段之上给出这一阶段的具体目标。 */
export const PipelineStageInput = z
  .object({
    stage: z.string().min(1).max(200),
    agent: z.string().min(1).max(200),
    dependsOn: z.array(z.string().min(1).max(200)).max(TEAM_MAX_PIPELINE_STAGES).optional(),
    goal: z.string().min(1).max(TASK_BRIEF_GOAL_MAX_CHARS).optional(),
    deliverable: z.string().min(1).max(TASK_BRIEF_DELIVERABLE_MAX_CHARS).optional(),
  })
  .strict()
export type PipelineStageInput = z.infer<typeof PipelineStageInput>

/** `run_pipeline` 工具的参数。阶段 id 唯一、依赖必须引用同一流水线里的阶段并构成 DAG。 */
export const RunPipelineInput = z
  .object({
    goal: z.string().min(1).max(TASK_BRIEF_GOAL_MAX_CHARS),
    stages: z.array(PipelineStageInput).min(1).max(TEAM_MAX_PIPELINE_STAGES),
    maxParallel: z.number().int().min(1).max(8).optional(),
    context: z.string().max(TASK_BRIEF_CONTEXT_MAX_CHARS).optional(),
    files: z
      .array(z.string().min(1).max(TASK_BRIEF_FILE_PATH_MAX_CHARS))
      .max(TASK_BRIEF_FILES_MAX)
      .optional(),
  })
  .strict()
export type RunPipelineInput = z.infer<typeof RunPipelineInput>

/**
 * 校验阶段列表：id 唯一、依赖存在且不指向自身；成环时由 `teamPipelineOrder` 发现。
 * 返回中文可读的问题描述，宿主把它包装成工具错误。
 */
export function validatePipelineStages(stages: readonly PipelineStageInput[]): string | undefined {
  const ids = new Set<string>()
  for (const stage of stages) {
    if (ids.has(stage.stage)) return `Duplicate pipeline stage: ${stage.stage}`
    ids.add(stage.stage)
  }
  for (const stage of stages) {
    for (const dependency of stage.dependsOn ?? []) {
      if (dependency === stage.stage) return `Stage ${stage.stage} depends on itself.`
      if (!ids.has(dependency)) {
        return `Stage ${stage.stage} depends on unknown stage ${dependency}.`
      }
    }
  }
  if (teamPipelineOrder(stages) === undefined) return 'Pipeline stages contain a dependency cycle.'
  return undefined
}

const describeTargets = (targets: readonly DelegateTargetInfo[]): string =>
  targets.map((target) => `- ${target.id}: ${target.name} — ${target.description}`).join('\n')

/** 构造 `run_pipeline` 的 `inputSchema`。 */
export function runPipelineInputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the pipeline must produce overall.' },
      stages: {
        type: 'array',
        minItems: 1,
        maxItems: TEAM_MAX_PIPELINE_STAGES,
        items: {
          type: 'object',
          properties: {
            stage: { type: 'string', description: 'Unique stage id.' },
            agent: { type: 'string', description: 'Read-only agent id that runs this stage.' },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Stage ids that must finish before this stage starts.',
            },
            goal: {
              type: 'string',
              description: 'Stage-specific goal; defaults to the overall goal.',
            },
            deliverable: { type: 'string' },
          },
          required: ['stage', 'agent'],
        },
      },
      maxParallel: { type: 'integer', minimum: 1, maximum: 8 },
      context: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['goal', 'stages'],
  }
}

/** 构造交给模型的 `run_pipeline` 工具说明（M7-08）。 */
export function runPipelineToolSpec(
  targets: readonly DelegateTargetInfo[],
): RuntimeToolSpec | undefined {
  if (targets.length === 0) return undefined
  return {
    name: RUN_PIPELINE_TOOL_NAME,
    description:
      'Run a fixed pipeline of read-only stages. Stages run in dependency order; stages ' +
      'without dependencies may run in parallel. When a stage fails, later stages are ' +
      'skipped and the completed results are kept. Available agents:\n' +
      describeTargets(targets),
    inputSchema: runPipelineInputSchema(),
    parallel: false,
  }
}
