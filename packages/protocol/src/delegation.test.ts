import { describe, expect, it } from 'vitest'
import {
  DELEGATE_SUMMARY_MAX_CHARS,
  DELEGATION_MAX_CHILDREN_PER_TURN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_MAX_PARALLEL,
  DelegateInput,
  DelegateResult,
  DelegationIssue,
  DelegationPolicy,
  DelegationValidation,
  TASK_BRIEF_GOAL_MAX_CHARS,
  TaskBrief,
} from './delegation.js'

const policy = {
  enabled: true,
  allowedAgents: ['builtin.reviewer'],
  maxDepth: 1,
  maxChildrenPerTurn: 6,
  maxParallel: 3,
  childBudgetShare: 0.5,
  defaultWorkspace: 'shared' as const,
  mergeReview: 'user' as const,
}

describe('DelegationPolicy', () => {
  it('接受完整的策略', () => {
    expect(DelegationPolicy.safeParse(policy).success).toBe(true)
  })

  it('拒绝超过全局硬上限与未知字段', () => {
    expect(
      DelegationPolicy.safeParse({ ...policy, maxDepth: DELEGATION_MAX_DEPTH + 1 }).success,
    ).toBe(false)
    expect(
      DelegationPolicy.safeParse({
        ...policy,
        maxChildrenPerTurn: DELEGATION_MAX_CHILDREN_PER_TURN + 1,
      }).success,
    ).toBe(false)
    expect(
      DelegationPolicy.safeParse({ ...policy, maxParallel: DELEGATION_MAX_PARALLEL + 1 }).success,
    ).toBe(false)
    expect(DelegationPolicy.safeParse({ ...policy, extra: true }).success).toBe(false)
  })
})

describe('TaskBrief', () => {
  it('要求目标与交付物，允许可选字段', () => {
    expect(TaskBrief.safeParse({ goal: 'g', deliverable: 'd' }).success).toBe(true)
    expect(
      TaskBrief.safeParse({
        goal: 'g',
        context: 'c',
        files: ['a.ts'],
        constraints: ['no writes'],
        deliverable: 'd',
        outputSchema: { type: 'object' },
        budget: { maxStepsPerTurn: 3 },
      }).success,
    ).toBe(true)
    expect(TaskBrief.safeParse({ goal: '', deliverable: 'd' }).success).toBe(false)
    expect(
      TaskBrief.safeParse({ goal: 'g'.repeat(TASK_BRIEF_GOAL_MAX_CHARS + 1), deliverable: 'd' })
        .success,
    ).toBe(false)
  })
})

describe('DelegateInput / DelegateResult', () => {
  it('校验目标、任务与任务书', () => {
    expect(
      DelegateInput.safeParse({
        agent: 'builtin.reviewer',
        task: 'review',
        brief: { goal: 'g', deliverable: 'd' },
        workspace: 'shared',
      }).success,
    ).toBe(true)
    expect(DelegateInput.safeParse({ agent: 'builtin.reviewer', task: ' ' }).success).toBe(false)
  })

  it('结果包含用量与子运行 id', () => {
    const result = {
      status: 'completed',
      summary: 'done',
      usage: { tokens: 3, durationMs: 5, steps: 1 },
      childRunId: 'run-1',
    }
    expect(DelegateResult.safeParse(result).success).toBe(true)
    expect(
      DelegateResult.safeParse({ ...result, summary: 'x'.repeat(DELEGATE_SUMMARY_MAX_CHARS + 1) })
        .success,
    ).toBe(false)
    expect(
      DelegateResult.safeParse({
        ...result,
        changes: { changeSetId: 'c1', files: [], merge: 'merged' },
      }).success,
    ).toBe(true)
  })
})

describe('DelegationIssue / DelegationValidation', () => {
  it('severity 默认为 error', () => {
    expect(DelegationIssue.parse({ code: 'delegation.disabled' })).toEqual({
      code: 'delegation.disabled',
      severity: 'error',
    })
    expect(DelegationIssue.parse({ code: 'x', severity: 'warning' }).severity).toBe('warning')
  })

  it('校验结果的 ok 与问题列表', () => {
    expect(DelegationValidation.parse({ ok: true, issues: [] })).toEqual({ ok: true, issues: [] })
    expect(
      DelegationValidation.safeParse({ ok: false, issues: [{ code: 'x', extra: 1 }] }).success,
    ).toBe(false)
  })
})
