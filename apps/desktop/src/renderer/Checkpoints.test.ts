import { describe, expect, it } from 'vitest'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import type { EventEnvelope } from '@cairn/protocol'
import { formatTime, restoresByMessage, turnCheckpoints, turnNumbers } from './Checkpoints.js'

const ev = (seq: number, type: string, payload: object, turnId?: string): EventEnvelope =>
  ({ v: 1, sessionId: 's1', runId: 'r1', turnId, ts: seq, seq, type, payload }) as EventEnvelope
const user = (seq: number, messageId: string, turnId: string) =>
  ev(seq, 'message.user', { messageId, content: [] }, turnId)
const checkpoint = (seq: number, id: string, turnId?: string) =>
  ev(seq, 'checkpoint.created', { checkpointId: id.repeat(40), reason: 'turn_start' }, turnId)

describe('checkpoint helpers', () => {
  const view = reduceSessionEvents(createSessionView('s1'), [
    ev(1, 'checkpoint.restored', { checkpointId: 'a'.repeat(40), truncateConversation: false }),
    user(2, 'm1', 't1'),
    checkpoint(3, 'a', 't1'),
    checkpoint(4, 'b', 't1'),
    checkpoint(5, 'c'),
    user(6, 'm2', 't2'),
    ev(7, 'checkpoint.restored', { checkpointId: 'a'.repeat(40), truncateConversation: false }),
  ])

  it('numbers turns and keeps the first turn checkpoint of each turn', () => {
    expect([...turnNumbers(view)]).toEqual([
      ['t1', 1],
      ['t2', 2],
    ])
    expect([...turnCheckpoints(view)].map(([turn, c]) => [turn, c.seq])).toEqual([['t1', 3]])
  })

  it('places a restore after the last message before it; earlier ones are dropped', () => {
    expect([...restoresByMessage(view)].map(([id, list]) => [id, list.map((r) => r.seq)])).toEqual([
      ['m2', [7]],
    ])
  })

  it('formats today as time only and other days with a date', () => {
    const now = new Date(2026, 10, 7, 12, 0).getTime()
    expect(formatTime(new Date(2026, 10, 7, 9, 5).getTime(), 'en-US', now)).toBe('09:05 AM')
    expect(formatTime(new Date(2026, 10, 6, 9, 5).getTime(), 'en-US', now)).toBe('11/6, 09:05 AM')
  })
})
