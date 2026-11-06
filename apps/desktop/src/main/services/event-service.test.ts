import { describe, expect, it, vi } from 'vitest'
import { reduceSessionEvents, createSessionView } from '@cairn/core'
import type { EventEnvelope, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage, StorageError, type Storage } from '@cairn/storage'
import { createSessionEventService, type SessionEventsListener } from './event-service.js'

function setup(sessions = ['s1']) {
  let clock = 1_000
  const storage = createMemoryStorage({ now: () => clock++ })
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work/demo' })
  for (const sessionId of sessions) {
    storage.sessions.create({ sessionId, projectId: 'p1', workspacePath: '/work/demo', title: '' })
  }
  const errors: unknown[] = []
  const service = createSessionEventService({ storage, onListenerError: (e) => errors.push(e) })
  const received: { sessionId: string; events: readonly EventEnvelope[] }[] = []
  service.subscribe((sessionId, events) => received.push({ sessionId, events }))
  return { storage, service, received, errors }
}

const base = { v: 1 as const, runId: 'run-1', ts: 5 }

function user(sessionId: string, messageId: string): UnsequencedEvent {
  return {
    ...base,
    sessionId,
    type: 'message.user',
    payload: { messageId, content: [{ type: 'text', text: messageId }] },
  }
}

function delta(sessionId: string, messageId: string, text: string): UnsequencedEvent {
  return { ...base, sessionId, type: 'message.assistant.delta', payload: { messageId, text } }
}

function completed(sessionId: string, messageId: string, text: string): UnsequencedEvent {
  return {
    ...base,
    sessionId,
    type: 'message.assistant.completed',
    payload: {
      messageId,
      content: [{ type: 'text', text }],
      model: { providerId: 'fake', modelId: 'fake-1' },
    },
  }
}

const seqs = (events: readonly { seq: number }[]) => events.map((e) => e.seq)

describe('createSessionEventService: seq assignment', () => {
  it('assigns one increasing counter shared by persisted and live events', () => {
    const { service, storage } = setup()
    const out = service.publish([
      user('s1', 'u1'),
      delta('s1', 'a1', 'Hel'),
      delta('s1', 'a1', 'lo'),
      completed('s1', 'a1', 'Hello'),
    ])
    expect(seqs(out)).toEqual([1, 2, 3, 4])
    expect(service.lastSeq('s1')).toBe(4)
    // 增量不落库，数据库中留下空缺
    expect(seqs(storage.events.readAfter('s1', 0))).toEqual([1, 4])
    expect(seqs(service.readAfter('s1', 1))).toEqual([4])
  })

  it('keeps separate counters per session and preserves order inside each', () => {
    const { service } = setup(['s1', 's2'])
    const out = service.publish([user('s1', 'a'), user('s2', 'b'), user('s1', 'c')])
    expect(out.map((e) => [e.sessionId, e.seq])).toEqual([
      ['s1', 1],
      ['s2', 1],
      ['s1', 2],
    ])
  })

  it('continues from the persisted maxSeq after a restart', () => {
    const { storage, service } = setup()
    service.publish([user('s1', 'u1'), delta('s1', 'a1', 'x'), user('s1', 'u2')])
    const restarted = createSessionEventService({ storage })
    expect(restarted.lastSeq('s1')).toBe(3)
    expect(seqs(restarted.publish([delta('s1', 'a2', 'y'), user('s1', 'u3')]))).toEqual([4, 5])
  })

  it('returns an empty list for an empty batch', () => {
    const { service, received } = setup()
    expect(service.publish([])).toEqual([])
    expect(received).toEqual([])
    expect(service.lastSeq('s1')).toBe(0)
  })
})

describe('createSessionEventService: persist before forward', () => {
  it('forwards only after the transaction committed, grouped by session', () => {
    const { storage, service } = setup(['s1', 's2'])
    const seenInDb: number[][] = []
    service.subscribe((sessionId) => seenInDb.push(seqs(storage.events.readAfter(sessionId, 0))))
    const listener = vi.fn<SessionEventsListener>()
    service.subscribe(listener)

    service.publish([user('s1', 'a'), delta('s1', 'm', 'x'), user('s2', 'b'), user('s1', 'c')])
    expect(seenInDb).toEqual([[1, 3], [1]])
    expect(listener.mock.calls.map(([id, events]) => [id, seqs(events)])).toEqual([
      ['s1', [1, 2, 3]],
      ['s2', [1]],
    ])
  })

  it('updates the session updatedAt when persisted events are written', () => {
    const { storage, service } = setup()
    const before = storage.sessions.get('s1')!.updatedAt
    service.publish([delta('s1', 'm', 'x')])
    expect(storage.sessions.get('s1')!.updatedAt).toBe(before)
    service.publish([user('s1', 'u1')])
    expect(storage.sessions.get('s1')!.updatedAt).toBeGreaterThan(before)
  })

  it('forwards live-only batches without touching the database', () => {
    const { storage, service, received } = setup()
    const append = vi.spyOn(storage.events, 'append')
    service.publish([delta('s1', 'm', 'a'), delta('s1', 'm', 'b')])
    expect(append).not.toHaveBeenCalled()
    expect(received.map((r) => seqs(r.events))).toEqual([[1, 2]])
  })

  it('writes nothing, forwards nothing and rolls back seq when the write fails', () => {
    const { storage, service, received } = setup(['s1', 's2'])
    service.publish([user('s1', 'u1')])
    received.length = 0
    vi.spyOn(storage.sessions, 'touch').mockImplementationOnce(() => {
      throw new StorageError('storage.not_found', { sessionId: 's2' })
    })
    expect(() => service.publish([user('s1', 'u2'), user('s2', 'x')])).toThrow(StorageError)
    expect(received).toEqual([])
    expect(seqs(storage.events.readAfter('s1', 0))).toEqual([1])
    expect(storage.events.maxSeq('s2')).toBe(0)
    expect(service.lastSeq('s1')).toBe(1)
    expect(seqs(service.publish([user('s1', 'u3')]))).toEqual([2])
  })

  it('rejects events for unknown sessions, including live-only batches', () => {
    const { service, received } = setup()
    expect(() => service.publish([delta('nope', 'm', 'x')])).toThrow(StorageError)
    expect(() => service.publish([user('s1', 'u1'), user('nope', 'x')])).toThrow(StorageError)
    expect(received).toEqual([])
    expect(service.lastSeq('s1')).toBe(0)
  })
})

describe('createSessionEventService: subscribers', () => {
  it('isolates failing subscribers and supports unsubscribe', () => {
    const { service, errors, received } = setup()
    const boom = new Error('listener failed')
    const off = service.subscribe(() => {
      throw boom
    })
    service.publish([user('s1', 'u1')])
    expect(errors).toEqual([boom])
    expect(received).toHaveLength(1)

    off()
    service.publish([user('s1', 'u2')])
    expect(errors).toHaveLength(1)
    expect(received).toHaveLength(2)
  })

  it('ignores subscriber errors when no error handler is given', () => {
    const storage: Storage = setup().storage
    const service = createSessionEventService({ storage })
    service.subscribe(() => {
      throw new Error('ignored')
    })
    expect(seqs(service.publish([user('s1', 'u1')]))).toEqual([1])
  })
})

describe('createSessionEventService: reducer contract', () => {
  it('replay of persisted events and the live stream reduce to the same view', () => {
    const { service } = setup()
    const live: EventEnvelope[] = []
    service.subscribe((_id, events) => live.push(...events))
    service.publish([user('s1', 'u1'), delta('s1', 'a1', 'Hi'), delta('s1', 'a1', ' there')])
    service.publish([completed('s1', 'a1', 'Hi there'), user('s1', 'u2')])

    const fromLive = reduceSessionEvents(createSessionView('s1'), live)
    const fromDb = reduceSessionEvents(createSessionView('s1'), service.readAfter('s1', 0))
    expect(fromLive.messages).toEqual(fromDb.messages)
    expect(fromLive.lastSeq).toBe(fromDb.lastSeq)

    // 补发 + 实时重叠：重复的事件被归约器忽略
    const overlapped = reduceSessionEvents(fromDb, live)
    expect(overlapped.messages).toEqual(fromDb.messages)
  })
})
