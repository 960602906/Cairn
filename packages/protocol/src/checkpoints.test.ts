import { describe, expect, it } from 'vitest'
import { CheckpointId, CheckpointRestorePlan, CheckpointSummary } from './checkpoints.js'

describe('checkpoints', () => {
  it('accepts only full commit ids', () => {
    expect(CheckpointId.safeParse('a'.repeat(40)).success).toBe(true)
    expect(CheckpointId.safeParse('b'.repeat(64)).success).toBe(true)
    for (const bad of ['HEAD', 'a'.repeat(39), 'A'.repeat(40), '--all', `${'a'.repeat(40)}^`]) {
      expect(CheckpointId.safeParse(bad).success).toBe(false)
    }
  })

  it('describes checkpoints and restore plans', () => {
    const summary = {
      checkpointId: 'a'.repeat(40),
      reason: 'before_restore',
      seq: 3,
      runId: 's1',
      createdAt: 1,
    }
    expect(CheckpointSummary.parse(summary)).toEqual(summary)
    expect(CheckpointSummary.safeParse({ ...summary, reason: 'other' }).success).toBe(false)
    const plan = { before: 'a'.repeat(40), files: [{ path: 'a.txt', status: 'deleted' }] }
    expect(CheckpointRestorePlan.parse(plan)).toEqual(plan)
    expect(
      CheckpointRestorePlan.safeParse({ ...plan, files: [{ path: '', status: 'added' }] }).success,
    ).toBe(false)
  })
})
