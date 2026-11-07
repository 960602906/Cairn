import { describe, expect, it, vi } from 'vitest'
import type { CanonicalMessage } from '@cairn/protocol'
import {
  COMPACTION_KEEP_TURNS,
  OMITTED_TOOL_OUTPUT,
  compactConversation,
  coveredSeqRange,
  estimateMessagesTokens,
  historyTokenLimit,
  omitToolOutputs,
  splitForSummary,
} from './compaction.js'

const model = { providerId: 'fake', modelId: 'fake-1' }
const text = (value: string) => [{ type: 'text' as const, text: value }]
const user = (turnId: string, body: string, ts: number): CanonicalMessage => ({
  role: 'user',
  content: text(body),
  ts,
  turnId,
})
const assistant = (body: string, ts: number, toolCallId?: string): CanonicalMessage => ({
  role: 'assistant',
  content: toolCallId ? [] : text(body),
  ...(toolCallId ? { toolCalls: [{ id: toolCallId, name: 'read_file', input: {} }] } : {}),
  model,
  ts,
})
const tool = (id: string, body: string, ts: number): CanonicalMessage => ({
  role: 'tool',
  toolCallId: id,
  content: text(body),
  status: 'ok',
  ts,
})

const tight = { contextWindow: 400, maxOutputTokens: 40, overheadTokens: 0 }
const roomy = { contextWindow: 100_000, maxOutputTokens: 1_000, overheadTokens: 0 }

describe('historyTokenLimit', () => {
  it('is 80% of the space left after reserved output and overhead', () => {
    expect(
      historyTokenLimit({ contextWindow: 1_000, maxOutputTokens: 100, overheadTokens: 200 }),
    ).toBe(Math.floor((1_000 - 100 - 200) * 0.8))
    expect(historyTokenLimit({ contextWindow: 100, maxOutputTokens: 80, overheadTokens: 50 })).toBe(
      0,
    )
  })
})

describe('splitForSummary', () => {
  it('keeps the last two turns and does not split a tool call from its result', () => {
    const output = 'x'.repeat(2_000)
    const messages = [
      user('t1', 'read it', 1),
      assistant('', 2, 'c1'),
      tool('c1', output, 3),
      user('t2', 'next', 4),
      assistant('ok', 5),
      user('t3', 'again', 6),
      assistant('done', 7),
    ]
    const split = splitForSummary(messages, COMPACTION_KEEP_TURNS)
    expect(split?.coversTurns).toEqual(['t1', 't1'])
    expect(split?.earlier.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(
      split?.kept.map((message) => (message.role === 'user' ? message.turnId : message.role)),
    ).toEqual(['t2', 'assistant', 't3', 'assistant'])
    expect(split?.kept.some((message) => message.role === 'tool')).toBe(false)
  })

  it('returns undefined when there is nothing older than the kept turns', () => {
    expect(splitForSummary([user('t1', 'hi', 1), assistant('yo', 2)])).toBeUndefined()
  })
})

describe('compactConversation', () => {
  const long = 'word '.repeat(800)

  it('does nothing under the threshold', async () => {
    const summarize = vi.fn(async () => 'nope')
    const outcome = await compactConversation({
      messages: [user('t1', 'hi', 1), assistant('yo', 2)],
      budget: roomy,
      summarize,
      now: 9,
    })
    expect(outcome).toEqual({ kind: 'none' })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('summarizes older turns once history exceeds the limit and keeps the last two', async () => {
    const messages = [
      user('t1', long, 1),
      assistant('one', 2),
      user('t2', long, 3),
      assistant('two', 4),
      user('t3', 'latest', 5),
      assistant('three', 6),
    ]
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(historyTokenLimit(tight))
    const outcome = await compactConversation({
      messages,
      budget: tight,
      summarize: async () => '  goals stay  ',
      now: 9,
    })
    expect(outcome.kind).toBe('summary')
    if (outcome.kind !== 'summary') return
    expect(outcome.summary).toBe('goals stay')
    expect(outcome.coversTurns).toEqual(['t1', 't1'])
    expect(outcome.messages[0]).toMatchObject({ role: 'summary', content: 'goals stay' })
    expect(
      outcome.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.turnId),
    ).toEqual(['t2', 't3'])
    expect(outcome.tokensAfter).toBeLessThan(outcome.tokensBefore)
  })

  it('drops the earliest tool output when the summary fails', async () => {
    const summarize = vi.fn(async () => '   ')
    const messages = [
      user('t1', 'read', 1),
      assistant('', 2, 'c1'),
      tool('c1', long, 3),
      tool('c2', 'small', 4),
      user('t2', 'go on', 5),
      assistant('ok', 6),
      user('t3', 'and then', 7),
      assistant('done', 8),
    ]
    const outcome = await compactConversation({
      messages,
      budget: tight,
      summarize,
      now: 9,
    })
    expect(summarize).toHaveBeenCalledOnce()
    expect(outcome.kind).toBe('degraded')
    if (outcome.kind !== 'degraded') return
    expect(outcome.omittedToolCallIds).toEqual(['c1'])
    const replaced = outcome.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'c1',
    )
    expect(replaced).toMatchObject({ content: text(OMITTED_TOOL_OUTPUT) })
    const kept = outcome.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'c2',
    )
    expect(kept).toMatchObject({ content: text('small') })
  })

  it('compacts on demand even under the threshold, and does nothing with too few turns', async () => {
    const summarize = vi.fn(async () => 'brief')
    const three = [
      user('t1', 'one', 1),
      assistant('a', 2),
      user('t2', 'two', 3),
      assistant('b', 4),
      user('t3', 'three', 5),
      assistant('c', 6),
    ]
    const forced = await compactConversation({
      messages: three,
      budget: roomy,
      force: true,
      summarize,
      now: 8,
    })
    expect(forced.kind).toBe('summary')
    expect(summarize).toHaveBeenCalledOnce()

    const once = await compactConversation({
      messages: [user('t1', 'only', 1), assistant('a', 2)],
      budget: roomy,
      force: true,
      summarize,
      now: 8,
    })
    expect(once).toEqual({ kind: 'none' })
  })
})

describe('omitToolOutputs', () => {
  it('returns undefined when every output is already omitted', () => {
    const messages = [tool('c1', OMITTED_TOOL_OUTPUT, 1)]
    expect(omitToolOutputs(messages, 0)).toBeUndefined()
  })
})

describe('coveredSeqRange', () => {
  it('spans the first event of the start turn through the last event of the end turn', () => {
    const events = [
      { seq: 1, turnId: 't1' },
      { seq: 2, turnId: 't1' },
      { seq: 3, turnId: 't2' },
      { seq: 4, turnId: 't3' },
    ]
    expect(coveredSeqRange(events, ['t1', 't2'])).toEqual([1, 3])
    expect(coveredSeqRange(events, ['missing', 't2'])).toBeUndefined()
  })
})
