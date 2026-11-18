import type { TeamPipelineStage } from '@cairn/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  RunPipelineInput,
  runPipelineToolSpec,
  runTeamPipeline,
  validatePipelineStages,
  type PipelineStageOutcome,
} from './pipeline.js'

const stage = (stageId: string, dependsOn: readonly string[] = []): TeamPipelineStage => ({
  stage: stageId,
  agent: `agent.${stageId}`,
  ...(dependsOn.length === 0 ? {} : { dependsOn: [...dependsOn] }),
})

const completed = (stageId: string): PipelineStageOutcome => ({
  stage: stageId,
  runId: `run-${stageId}`,
  status: 'completed',
  summary: `${stageId} 完成`,
})

describe('runTeamPipeline（M7-08）', () => {
  it('按依赖分波，无依赖的阶段同波并发，后续阶段拿到上游摘要', async () => {
    const order: string[] = []
    const upstreamSeen: Record<string, string[]> = {}
    const result = await runTeamPipeline({
      stages: [stage('a'), stage('b'), stage('c', ['a', 'b'])],
      maxParallel: 2,
      runStage: async ({ stage: current, upstream }) => {
        order.push(current.stage)
        upstreamSeen[current.stage] = upstream.map((item) => item.stage)
        return completed(current.stage)
      },
    })

    expect(order).toEqual(['a', 'b', 'c'])
    expect(upstreamSeen).toEqual({ a: [], b: [], c: ['a', 'b'] })
    expect(result.status).toBe('completed')
    expect(result.stages.map((item) => item.stage)).toEqual(['a', 'b', 'c'])
    expect(result.skipped).toEqual([])
    expect(result.summary).toBe('c 完成')
  })

  it('同波阶段真正并发：两个阶段都开始后才结束', async () => {
    const started: string[] = []
    const waiters: (() => void)[] = []
    const running = runTeamPipeline({
      stages: [stage('a'), stage('b')],
      maxParallel: 2,
      runStage: async ({ stage: current }) => {
        started.push(current.stage)
        await new Promise<void>((resolve) => waiters.push(resolve))
        return completed(current.stage)
      },
    })
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']))
    for (const release of waiters) release()
    const result = await running
    expect(result.status).toBe('completed')
  })

  it('某阶段失败时跳过后续阶段，已完成阶段的结果保留', async () => {
    const result = await runTeamPipeline({
      stages: [stage('a'), stage('b', ['a']), stage('c', ['b'])],
      maxParallel: 1,
      runStage: async ({ stage: current }) =>
        current.stage === 'a'
          ? { stage: 'a', runId: 'run-a', status: 'failed', summary: '写不出来' }
          : completed(current.stage),
    })
    expect(result.status).toBe('failed')
    expect(result.stages.map((item) => item.stage)).toEqual(['a'])
    expect(result.skipped).toEqual(['b', 'c'])
    expect(result.summary).toBe('写不出来')
  })

  it('同波内的其他阶段照常完成后再停止', async () => {
    const result = await runTeamPipeline({
      stages: [stage('a'), stage('b'), stage('c', ['a', 'b'])],
      maxParallel: 2,
      runStage: async ({ stage: current }) =>
        current.stage === 'a'
          ? { stage: 'a', runId: 'run-a', status: 'failed', summary: 'a 失败' }
          : completed(current.stage),
    })
    expect(result.stages.map((item) => item.stage)).toEqual(['a', 'b'])
    expect(result.skipped).toEqual(['c'])
  })

  it.each([
    ['limit_reached', 'limit_reached'],
    ['aborted', 'stopped'],
    ['needs_input', 'stopped'],
  ] as const)('阶段以 %s 结束时流水线为 %s', async (status, outcome) => {
    const result = await runTeamPipeline({
      stages: [stage('a'), stage('b', ['a'])],
      maxParallel: 2,
      runStage: async ({ stage: current }) => ({
        stage: current.stage,
        runId: `run-${current.stage}`,
        status,
        summary: '到此为止',
      }),
    })
    expect(result.status).toBe(outcome)
    expect(result.skipped).toEqual(['b'])
  })

  it('外部停止后不再开始新阶段', async () => {
    let stopped = false
    const result = await runTeamPipeline({
      stages: [stage('a'), stage('b', ['a'])],
      maxParallel: 1,
      runStage: async ({ stage: current }) => {
        stopped = true
        return completed(current.stage)
      },
      stopped: () => stopped,
    })
    expect(result.status).toBe('stopped')
    expect(result.stages.map((item) => item.stage)).toEqual(['a'])
    expect(result.skipped).toEqual(['b'])
  })

  it('一开始就已停止时跳过所有阶段并给出兜底说明', async () => {
    const runStage = vi.fn()
    const result = await runTeamPipeline({
      stages: [stage('a'), stage('b')],
      maxParallel: 2,
      runStage,
      stopped: () => true,
    })
    expect(result).toMatchObject({
      status: 'stopped',
      stages: [],
      skipped: ['a', 'b'],
      summary: 'The pipeline was stopped.',
    })
    expect(runStage).not.toHaveBeenCalled()
  })

  it('依赖成环时整条流水线失败并跳过所有阶段', async () => {
    const runStage = vi.fn()
    const result = await runTeamPipeline({
      stages: [stage('a', ['b']), stage('b', ['a'])],
      maxParallel: 2,
      runStage,
    })
    expect(result.status).toBe('failed')
    expect(result.skipped).toEqual(['a', 'b'])
    expect(runStage).not.toHaveBeenCalled()
  })

  it('没有阶段时视为完成', async () => {
    const result = await runTeamPipeline({ stages: [], maxParallel: 2, runStage: vi.fn() })
    expect(result).toEqual({
      status: 'completed',
      stages: [],
      skipped: [],
      summary: 'All pipeline stages completed.',
    })
  })
})

describe('run_pipeline 输入与校验（M7-08）', () => {
  const stageInput = (patch: Record<string, unknown> = {}) => ({
    stage: 'build',
    agent: 'builtin.tester',
    ...patch,
  })

  it('接受依赖在后的阶段定义', () => {
    expect(
      RunPipelineInput.safeParse({
        goal: '发布前检查',
        stages: [stageInput(), stageInput({ stage: 'check', dependsOn: ['build'] })],
      }).success,
    ).toBe(true)
  })

  it('拒绝重复阶段、自依赖、未知依赖与成环', () => {
    expect(validatePipelineStages([stageInput(), stageInput()])).toContain('Duplicate')
    expect(validatePipelineStages([stageInput({ dependsOn: ['build'] })])).toContain('itself')
    expect(validatePipelineStages([stageInput({ dependsOn: ['missing'] })])).toContain('unknown')
    expect(
      validatePipelineStages([
        stageInput({ stage: 'a', dependsOn: ['b'] }),
        stageInput({ stage: 'b', dependsOn: ['a'] }),
      ]),
    ).toContain('cycle')
    expect(validatePipelineStages([stageInput()])).toBeUndefined()
  })

  it('阶段数量与轮次并发有上限', () => {
    const many = Array.from({ length: 21 }, (_, index) => stageInput({ stage: `s${index}` }))
    expect(RunPipelineInput.safeParse({ goal: 'g', stages: many }).success).toBe(false)
    expect(
      RunPipelineInput.safeParse({ goal: 'g', stages: [stageInput()], maxParallel: 9 }).success,
    ).toBe(false)
  })

  it('工具说明列出可用 Agent 并串行登记', () => {
    const spec = runPipelineToolSpec([
      { id: 'builtin.tester', name: '测试员', description: '写测试' },
    ])
    expect(spec?.name).toBe('run_pipeline')
    expect(spec?.parallel).toBe(false)
    expect(spec?.description).toContain('builtin.tester: 测试员 — 写测试')
    expect(spec?.inputSchema.required).toEqual(['goal', 'stages'])
    expect(runPipelineToolSpec([])).toBeUndefined()
  })
})
