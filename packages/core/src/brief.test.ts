import type { CanonicalMessage } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  placeSessionBrief,
  sessionBriefMessage,
  sessionBriefText,
  stripSessionBriefs,
} from './brief.js'

const ordinary: CanonicalMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  ts: 1,
}

describe('session brief history', () => {
  it('returns no text for missing or whitespace-only briefs', () => {
    expect(sessionBriefText([ordinary])).toBeUndefined()
    expect(sessionBriefText([sessionBriefMessage('   ', 2)])).toBeUndefined()
  })

  it('preserves the original array if nothing changes', () => {
    const messages = [sessionBriefMessage('goal', 2), ordinary]
    expect(placeSessionBrief(messages, ' goal ', 3)).toBe(messages)
    expect(stripSessionBriefs([ordinary])).toEqual([ordinary])
    const withoutBrief = [ordinary]
    expect(placeSessionBrief(withoutBrief, '  ', 3)).toBe(withoutBrief)
  })

  it('removes stale briefs and puts the replacement first', () => {
    const old = sessionBriefMessage('old', 1)
    const messages = [ordinary, old, sessionBriefMessage('older', 2)]
    expect(stripSessionBriefs(messages)).toEqual([ordinary])
    expect(placeSessionBrief(messages, 'new', 4)).toEqual([sessionBriefMessage('new', 4), ordinary])
    expect(placeSessionBrief(messages, ' ', 4)).toEqual([ordinary])
    expect(sessionBriefText(placeSessionBrief(messages, 'new', 4))).toBe('new')
  })
})
