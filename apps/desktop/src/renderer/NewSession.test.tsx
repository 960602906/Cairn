// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { greetingPeriod } from './NewSession.js'

describe('greetingPeriod', () => {
  it('maps the local hour to the greeting of the day', () => {
    expect([4, 23, 0].map(greetingPeriod)).toEqual(['night', 'night', 'night'])
    expect([5, 11].map(greetingPeriod)).toEqual(['morning', 'morning'])
    expect([12, 13].map(greetingPeriod)).toEqual(['noon', 'noon'])
    expect([14, 17].map(greetingPeriod)).toEqual(['afternoon', 'afternoon'])
    expect([18, 22].map(greetingPeriod)).toEqual(['evening', 'evening'])
  })
})
