import { describe, expect, it, vi } from 'vitest'
import {
  REVIEW_LOOP_DEFAULT_MAX_ROUNDS,
  REVIEW_VERDICT_SCHEMA,
  ReviewLoopInput,
  reviewLoopToolSpec,
  runReviewLoop,
  type ReviewLoopStep,
} from './review-loop.js'

const completed = (runId: string, summary: string, extra: Partial<ReviewLoopStep> = {}) =>
  ({ status: 'completed', runId, summary, ...extra }) satisfies ReviewLoopStep

describe('runReviewLoop（M7-07）', () => {
  it('checker 第一轮通过就结束，只开两个子运行', async () => {
    const runMaker = vi.fn(async () => completed('maker-1', '草稿'))
    const runChecker = vi.fn(async () => completed('checker-1', '没问题', { verdict: 'pass' }))
    const onRound = vi.fn()
    const result = await runReviewLoop({ maxRounds: 3, runMaker, runChecker, onRound })

    expect(result.outcome).toBe('passed')
    expect(result.summary).toBe('草稿')
    expect(result.rounds).toEqual([
      { round: 1, makerRunId: 'maker-1', checkerRunId: 'checker-1', verdict: 'pass' },
    ])
    expect(onRound).toHaveBeenCalledWith(result.rounds[0])
    expect(runMaker).toHaveBeenCalledTimes(1)
  })

  it('不通过时把意见带回下一轮，通过后结束', async () => {
    const runMaker = vi
      .fn()
      .mockResolvedValueOnce(completed('maker-1', '第一版'))
      .mockResolvedValueOnce(completed('maker-2', '第二版'))
    const runChecker = vi
      .fn()
      .mockResolvedValueOnce(
        completed('checker-1', '需要补充测试', { verdict: 'revise', feedback: '补测试' }),
      )
      .mockResolvedValueOnce(completed('checker-2', '可以了', { verdict: 'pass' }))

    const result = await runReviewLoop({ maxRounds: 3, runMaker, runChecker })

    expect(result.outcome).toBe('passed')
    expect(result.rounds.map((item) => item.verdict)).toEqual(['revise', 'pass'])
    expect(runMaker).toHaveBeenLastCalledWith({ round: 2, feedback: '补测试' })
    expect(result.summary).toBe('第二版')
  })

  it('轮次用尽仍未通过时返回 exhausted，并带上最后一条意见', async () => {
    const runMaker = vi.fn(async ({ round }: { round: number }) =>
      completed(`maker-${round}`, `第 ${round} 版`),
    )
    const runChecker = vi.fn(async ({ round }: { round: number }) =>
      completed(`checker-${round}`, `还要改 ${round}`, { verdict: 'revise' }),
    )
    const result = await runReviewLoop({ maxRounds: 2, runMaker, runChecker })

    expect(result.outcome).toBe('exhausted')
    expect(result.rounds).toHaveLength(2)
    expect(result.summary).toBe('还要改 2')
    expect(runMaker).toHaveBeenCalledTimes(2)
  })

  it('checker 没给出判定时按不通过处理，不会误判为通过', async () => {
    const runMaker = vi.fn(async ({ round }: { round: number }) =>
      completed(`maker-${round}`, '草稿'),
    )
    const runChecker = vi.fn(async ({ round }: { round: number }) =>
      completed(`checker-${round}`, '看不出结论'),
    )
    const result = await runReviewLoop({ maxRounds: 1, runMaker, runChecker })
    expect(result.outcome).toBe('exhausted')
    expect(result.rounds[0]?.feedback).toBe('看不出结论')
  })

  it.each([
    ['failed', 'failed'],
    ['aborted', 'stopped'],
    ['limit_reached', 'limit_reached'],
    ['needs_input', 'stopped'],
  ] as const)('maker 以 %s 结束时立即返回 %s', async (status, outcome) => {
    const runMaker = vi.fn(async () => ({ status, runId: 'maker-1', summary: '做不下去' }))
    const runChecker = vi.fn(async () => completed('checker-1', 'ok', { verdict: 'pass' }))
    const result = await runReviewLoop({ maxRounds: 3, runMaker, runChecker })
    expect(result.outcome).toBe(outcome)
    expect(result.rounds).toEqual([])
    expect(result.summary).toBe('做不下去')
    expect(runChecker).not.toHaveBeenCalled()
  })

  it('没有可用轮次时直接返回默认说明', async () => {
    const runMaker = vi.fn()
    const result = await runReviewLoop({ maxRounds: 0, runMaker, runChecker: vi.fn() })
    expect(result.outcome).toBe('exhausted')
    expect(result.rounds).toEqual([])
    expect(result.summary).toContain('round limit')
    expect(runMaker).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'failed'],
    ['aborted', 'stopped'],
    ['limit_reached', 'limit_reached'],
  ] as const)('checker 以 %s 结束时立即返回 %s', async (status, outcome) => {
    const runMaker = vi.fn(async () => completed('maker-1', '草稿'))
    const runChecker = vi.fn(async () => ({
      status,
      runId: 'checker-1',
      summary: '审查失败',
    }))
    const result = await runReviewLoop({ maxRounds: 3, runMaker, runChecker })
    expect(result.outcome).toBe(outcome)
    expect(result.summary).toBe('审查失败')
    expect(runMaker).toHaveBeenCalledTimes(1)
  })
})
describe('review_loop 工具说明与参数（M7-07）', () => {
  const targets = [
    { id: 'builtin.tester', name: '测试员', description: '写测试' },
    { id: 'builtin.reviewer', name: '审查员', description: '审查改动' },
  ]

  it('列出可用的 maker / checker，并默认串行执行', () => {
    const spec = reviewLoopToolSpec(targets)
    expect(spec?.name).toBe('review_loop')
    expect(spec?.parallel).toBe(false)
    expect(spec?.description).toContain('builtin.tester: 测试员 — 写测试')
    expect(spec?.description).toContain('builtin.reviewer')
    expect(spec?.inputSchema.required).toEqual(['goal', 'maker', 'checker'])
  })

  it('没有可委派目标时不登记', () => {
    expect(reviewLoopToolSpec([])).toBeUndefined()
  })

  it('校验必填字段与轮次上限', () => {
    expect(ReviewLoopInput.safeParse({ maker: 'a', checker: 'b' }).success).toBe(false)
    expect(
      ReviewLoopInput.safeParse({ goal: '写说明', maker: 'a', checker: 'b' }).data,
    ).toMatchObject({ goal: '写说明', maker: 'a', checker: 'b' })
    expect(
      ReviewLoopInput.safeParse({ goal: '写说明', maker: 'a', checker: 'b', maxRounds: 0 }).success,
    ).toBe(false)
    expect(
      ReviewLoopInput.safeParse({ goal: '写说明', maker: 'a', checker: 'b', maxRounds: 11 })
        .success,
    ).toBe(false)
    expect(REVIEW_LOOP_DEFAULT_MAX_ROUNDS).toBe(3)
  })

  it('checker 的输出 schema 要求 verdict 枚举', () => {
    expect(REVIEW_VERDICT_SCHEMA.required).toEqual(['verdict'])
    expect(REVIEW_VERDICT_SCHEMA.additionalProperties).toBe(false)
  })
})
