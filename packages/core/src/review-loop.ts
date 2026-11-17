/**
 * 审查循环（M7-07，多 Agent 协作 §15，团队模板的 `review-loop` 模式）。
 *
 * maker 产出 → checker 审查：通过就结束，不通过把意见回传给 maker 再来一轮，最多
 * `maxRounds` 轮。每一轮的两个子运行都由调用方（宿主）创建，这里只做编排与结局判定：
 * - `passed`：checker 通过；
 * - `exhausted`：轮次用尽仍未通过；
 * - `failed` / `stopped` / `limit_reached`：任一子运行失败、被停止或触发限额，立即结束，
 *   不再开新一轮。
 *
 * 纯函数式的依赖注入让编排可以脱离宿主单测；实际创建子运行、隔离工作区与预算继承
 * 仍走 `runDelegation`（M4 的边界），这里不重复。
 */
import {
  TASK_BRIEF_CONTEXT_MAX_CHARS,
  TASK_BRIEF_DELIVERABLE_MAX_CHARS,
  TASK_BRIEF_FILES_MAX,
  TASK_BRIEF_FILE_PATH_MAX_CHARS,
  TASK_BRIEF_GOAL_MAX_CHARS,
  TEAM_MAX_REVIEW_ROUNDS,
  type DelegateStatus,
} from '@cairn/protocol'
import { z } from 'zod'
import type { RuntimeToolSpec } from './runtime.js'
import type { DelegateTargetInfo } from './delegation.js'

export type ReviewVerdict = 'pass' | 'revise'

export type ReviewLoopOutcome = 'passed' | 'exhausted' | 'failed' | 'stopped' | 'limit_reached'

/** 一轮的结果；界面按这个顺序展示每轮的 maker / checker。 */
export interface ReviewRoundResult {
  readonly round: number
  readonly makerRunId: string
  readonly checkerRunId: string
  readonly verdict: ReviewVerdict
  readonly feedback?: string
}

/** 一次子运行的结局；`verdict` 只有 checker 会给出。 */
export interface ReviewLoopStep {
  readonly status: DelegateStatus
  readonly summary: string
  readonly runId: string
  readonly verdict?: ReviewVerdict
  readonly feedback?: string
}

export interface ReviewLoopDeps {
  readonly maxRounds: number
  readonly runMaker: (input: { round: number; feedback?: string }) => Promise<ReviewLoopStep>
  readonly runChecker: (input: { round: number; makerSummary: string }) => Promise<ReviewLoopStep>
  /** 每轮结束后回调（宿主写入事件与运行树）。 */
  readonly onRound?: (result: ReviewRoundResult) => void
}

export interface ReviewLoopResult {
  readonly outcome: ReviewLoopOutcome
  readonly rounds: readonly ReviewRoundResult[]
  readonly summary: string
}

const failureOutcome = (status: DelegateStatus): ReviewLoopOutcome | undefined => {
  if (status === 'failed') return 'failed'
  if (status === 'limit_reached') return 'limit_reached'
  // `aborted` 与 `needs_input` 都不能继续循环：前者被停止，后者在审查循环里没有提问通道。
  if (status === 'aborted' || status === 'needs_input') return 'stopped'
  return undefined
}

/** 执行审查循环。子运行失败、停止或触发限额时立即结束并带回它的摘要。 */
export async function runReviewLoop(deps: ReviewLoopDeps): Promise<ReviewLoopResult> {
  const rounds: ReviewRoundResult[] = []
  let feedback: string | undefined

  for (let round = 1; round <= deps.maxRounds; round += 1) {
    const maker = await deps.runMaker({
      round,
      ...(feedback === undefined ? {} : { feedback }),
    })
    const makerOutcome = failureOutcome(maker.status)
    if (makerOutcome) {
      return { outcome: makerOutcome, rounds, summary: maker.summary }
    }

    const checker = await deps.runChecker({ round, makerSummary: maker.summary })
    const checkerOutcome = failureOutcome(checker.status)
    if (checkerOutcome) {
      return { outcome: checkerOutcome, rounds, summary: checker.summary }
    }

    const verdict: ReviewVerdict = checker.verdict === 'pass' ? 'pass' : 'revise'
    const roundFeedback = checker.feedback ?? (verdict === 'revise' ? checker.summary : undefined)
    const result: ReviewRoundResult = {
      round,
      makerRunId: maker.runId,
      checkerRunId: checker.runId,
      verdict,
      ...(roundFeedback === undefined ? {} : { feedback: roundFeedback }),
    }
    rounds.push(result)
    deps.onRound?.(result)

    if (verdict === 'pass') return { outcome: 'passed', rounds, summary: maker.summary }
    feedback = roundFeedback ?? checker.summary
  }

  return {
    outcome: 'exhausted',
    rounds,
    summary: feedback ?? 'The review loop reached its round limit without approval.',
  }
}

/** 审查循环给模型看的名称（M7-07）。 */
export const REVIEW_LOOP_TOOL_NAME = 'review_loop'

/** 模型没给轮次时的默认值：三轮回合足够收敛，也不会一次烧掉太多预算。 */
export const REVIEW_LOOP_DEFAULT_MAX_ROUNDS = 3

/**
 * checker 必须返回的结构：`verdict` 决定是否再来一轮，`feedback` 原样回传给 maker。
 * 只读子运行的输出会按这个 schema 解析；缺字段时按“未通过”处理，不会误判为通过。
 */
export const REVIEW_VERDICT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'revise'],
      description: 'pass when the work is acceptable, revise when it needs another round.',
    },
    feedback: {
      type: 'string',
      description: 'Concrete changes the maker should make next round.',
    },
  },
  required: ['verdict'],
  additionalProperties: false,
}

/** `review_loop` 工具的参数（M7-07）。maker 与 checker 都必须在主控的 allowedAgents 里。 */
export const ReviewLoopInput = z
  .object({
    goal: z.string().min(1).max(TASK_BRIEF_GOAL_MAX_CHARS),
    maker: z.string().min(1).max(200),
    checker: z.string().min(1).max(200),
    maxRounds: z.number().int().min(1).max(TEAM_MAX_REVIEW_ROUNDS).optional(),
    deliverable: z.string().min(1).max(TASK_BRIEF_DELIVERABLE_MAX_CHARS).optional(),
    context: z.string().max(TASK_BRIEF_CONTEXT_MAX_CHARS).optional(),
    files: z
      .array(z.string().min(1).max(TASK_BRIEF_FILE_PATH_MAX_CHARS))
      .max(TASK_BRIEF_FILES_MAX)
      .optional(),
  })
  .strict()
export type ReviewLoopInput = z.infer<typeof ReviewLoopInput>

const describeTargets = (targets: readonly DelegateTargetInfo[]): string =>
  targets.map((target) => `- ${target.id}: ${target.name} — ${target.description}`).join('\n')

/** 构造 `review_loop` 的 `inputSchema`。 */
export function reviewLoopInputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the maker must produce and the checker reviews.' },
      maker: {
        type: 'string',
        description: 'Agent id that produces the work. Must be a read-only agent.',
      },
      checker: {
        type: 'string',
        description: 'Agent id that reviews the work and returns a verdict.',
      },
      maxRounds: {
        type: 'integer',
        minimum: 1,
        maximum: TEAM_MAX_REVIEW_ROUNDS,
        description: `Round limit (default ${REVIEW_LOOP_DEFAULT_MAX_ROUNDS}).`,
      },
      deliverable: { type: 'string', description: 'What the maker result should contain.' },
      context: { type: 'string', description: 'Relevant background neither agent can see.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files to inspect first.' },
    },
    required: ['goal', 'maker', 'checker'],
  }
}

/**
 * 构造交给模型的 `review_loop` 工具说明（M7-07）：maker 与 checker 都是只读子运行，
 * 每轮先由 maker 产出、再由 checker 给判定，未通过时把意见带回 maker。
 */
export function reviewLoopToolSpec(
  targets: readonly DelegateTargetInfo[],
): RuntimeToolSpec | undefined {
  if (targets.length === 0) return undefined
  return {
    name: REVIEW_LOOP_TOOL_NAME,
    description:
      'Run a maker/checker review loop: the maker drafts, the checker reviews, and when the ' +
      'checker asks for changes the feedback goes back to the maker for another round. ' +
      'Both children are read-only and only see their brief. Available agents:\n' +
      describeTargets(targets),
    inputSchema: reviewLoopInputSchema(),
    parallel: false,
  }
}
