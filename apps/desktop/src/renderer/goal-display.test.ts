import { describe, expect, it } from 'vitest'
import { formatGoalDuration, GOAL_DETAIL_KEYS, goalDetailText } from './goal-display.js'

describe('goalDetailText', () => {
  it('translates known detail codes and hides unknown machine codes', () => {
    const t = (key: string) => key
    expect(goalDetailText('turns', t)).toBe('goal.detail.turns')
    expect(goalDetailText('host_crashed', t)).toBe('goal.detail.host_crashed')
    expect(goalDetailText('provider.offline', t)).toBeUndefined()
    expect(goalDetailText('', t)).toBeUndefined()
    expect(goalDetailText(undefined, t)).toBeUndefined()
  })

  it('covers every exported detail key', () => {
    expect(GOAL_DETAIL_KEYS.length).toBeGreaterThan(0)
    for (const key of GOAL_DETAIL_KEYS) {
      expect(goalDetailText(key, (k) => k)).toBe(`goal.detail.${key}`)
    }
  })
})

describe('formatGoalDuration', () => {
  it('keeps hour and minute displays distinct', () => {
    expect(formatGoalDuration(60_000)).toBe('1:00')
    expect(formatGoalDuration(3_600_000)).toBe('1h 00m')
  })
})
