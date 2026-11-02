/**
 * 增量合并（M0-06c）：delta 只更新进行中的消息，完成事件以完整内容覆盖；
 * "只用持久化事件"与"持久化 + delta"归约的最终结果一致。
 */
import {
  isPersistedEvent,
  type EventEnvelope,
  type EventPayload,
  type EventType,
} from '@nexus/protocol'
import { describe, expect, it } from 'vitest'
import { createSessionView, reduceSession, reduceSessionEvents, type SessionView } from './index.js'

const SID = 's1'
const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

type Draft = {
  [T in EventType]: Omit<EventEnvelope<T>, 'seq' | 'ts' | 'v' | 'sessionId'>
}[EventType]

function draft<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  header: { runId?: string; turnId?: string; stepId?: string } = {},
): Draft {
  return { runId: 'r1', ...header, type, payload } as Draft
}

/** 按顺序分配 seq（从 1 开始，增量与持久化事件共用计数器）。 */
function sequence(drafts: readonly Draft[]): EventEnvelope[] {
  return drafts.map(
    (d, i) => ({ v: 1, sessionId: SID, ...d, seq: i + 1, ts: (i + 1) * 10 }) as EventEnvelope,
  )
}

const reduceAll = (events: readonly EventEnvelope[]) =>
  reduceSessionEvents(createSessionView(SID), events)
const persistedOnly = (events: readonly EventEnvelope[]) => events.filter(isPersistedEvent)

const t1 = { turnId: 't1' }
const s1 = { turnId: 't1', stepId: 'st1' }

const PRELUDE: Draft[] = [
  draft('run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
  draft('message.user', { messageId: 'm1', content: text('你好') }, t1),
  draft('turn.started', {}, t1),
  draft('run.state.changed', { from: 'idle', to: 'thinking' }, t1),
  draft('step.started', { model }, s1),
]

const CHUNKS = ['你', '好', '！', '有什么', '可以帮你？']
const THOUGHTS = ['用户', '在打招呼']

const COMPLETED = draft(
  'message.assistant.completed',
  {
    messageId: 'm2',
    content: text(CHUNKS.join('')),
    reasoning: { text: THOUGHTS.join(''), providerId: 'fake' },
    model,
  },
  s1,
)

const EPILOGUE: Draft[] = [
  draft('step.completed', { model, finishReason: 'stop', durationMs: 5 }, s1),
  draft('run.state.changed', { from: 'thinking', to: 'completed' }, t1),
  draft('turn.completed', { durationMs: 50 }, t1),
]

const textDelta = (t: string, id = 'm2') =>
  draft('message.assistant.delta', { messageId: id, text: t }, s1)
const reasoningDelta = (t: string, id = 'm2') =>
  draft('message.reasoning.delta', { messageId: id, text: t }, s1)

describe('增量合并', () => {
  const events = sequence([
    ...PRELUDE,
    ...THOUGHTS.map((t) => reasoningDelta(t)),
    ...CHUNKS.map((t) => textDelta(t)),
    COMPLETED,
    ...EPILOGUE,
  ])
  const completedAt = events.findIndex((e) => e.type === 'message.assistant.completed')

  it('完成前，增量累积在进行中的消息里', () => {
    const view = reduceAll(events.slice(0, completedAt))
    expect(view.messages.map((m) => m.messageId)).toEqual(['m1'])
    expect(view.live).toEqual({
      m2: {
        messageId: 'm2',
        runId: 'r1',
        turnId: 't1',
        text: CHUNKS.join(''),
        reasoning: THOUGHTS.join(''),
        lastDeltaSeq: completedAt,
        startedAt: (PRELUDE.length + 1) * 10,
      },
    })
    // lastSeq 只随持久化事件推进
    expect(view.lastSeq).toBe(PRELUDE.length)
  })

  it('完成事件以完整内容写入消息并移除进行中的消息', () => {
    const view = reduceAll(events.slice(0, completedAt + 1))
    expect(view.live).toEqual({})
    expect(view.messages[1]).toMatchObject({ messageId: 'm2', content: text(CHUNKS.join('')) })
  })

  it('最终结果与只用持久化事件一致', () => {
    expect(reduceAll(events)).toEqual(reduceAll(persistedOnly(events)))
  })

  it('完成后到达的增量被忽略', () => {
    const view = reduceAll(events.slice(0, completedAt + 1))
    const late = { ...events[PRELUDE.length]!, seq: 999 } as EventEnvelope
    expect(reduceSession(view, late)).toBe(view)
  })

  it('重复或迟到的增量被忽略', () => {
    const view = reduceAll(events.slice(0, completedAt))
    // 同一条增量再来一次
    expect(reduceSession(view, events[completedAt - 1]!)).toBe(view)
    // seq 比该消息已合并的增量更早，但仍大于 lastSeq
    const stale = { ...events[completedAt - 1]!, seq: completedAt - 1 } as EventEnvelope
    expect(reduceSession(view, stale)).toBe(view)
  })

  it('seq 不大于 lastSeq 的增量被忽略', () => {
    const view = reduceAll(events.slice(0, completedAt + 1))
    const [old] = sequence([textDelta('x', 'other')])
    expect(reduceSession(view, old!)).toBe(view)
  })

  it('工具输出增量暂不处理', () => {
    const view = reduceAll(events.slice(0, completedAt))
    const toolDelta = {
      ...sequence([
        draft('tool.output.delta', { toolCallId: 'c1', stream: 'stdout', text: 'x' }, s1),
      ])[0]!,
      seq: 999,
    } as EventEnvelope
    expect(reduceSession(view, toolDelta)).toBe(view)
  })
})

describe('轮次结束与崩溃时丢弃进行中的消息', () => {
  const partial = [...PRELUDE, ...CHUNKS.slice(0, 2).map((t) => textDelta(t))]

  it.each([
    ['turn.aborted', draft('turn.aborted', { reason: 'user' }, t1)],
    ['turn.failed', draft('turn.failed', { error: { code: 'x' }, retryable: true }, t1)],
    ['turn.completed', draft('turn.completed', { durationMs: 1 }, t1)],
    ['run.disposed', draft('run.disposed', {})],
    ['session.crashed', draft('session.crashed', { error: { code: 'host.crashed' } })],
  ])('%s', (_name, end) => {
    const events = sequence([...partial, end])
    const view = reduceAll(events)
    expect(view.live).toEqual({})
    expect(view).toEqual(reduceAll(persistedOnly(events)))
  })

  it('只丢弃该运行的进行中消息', () => {
    const child = { runId: 'r2', turnId: 'ct', stepId: 'cs' }
    const events = sequence([
      ...partial,
      draft('message.assistant.delta', { messageId: 'c1', text: '子' }, child),
      draft('turn.aborted', { reason: 'user' }, t1),
    ])
    expect(Object.keys(reduceAll(events).live)).toEqual(['c1'])
  })

  it('无关的持久化事件不影响进行中的消息', () => {
    const events = sequence([
      ...partial,
      draft('message.assistant.completed', { messageId: 'zz', content: text('另一条'), model }, s1),
      draft('turn.aborted', { reason: 'user' }, { turnId: 'other', runId: 'r9' }),
    ])
    const view = reduceAll(events)
    expect(view.live.m2?.text).toBe('你好')
  })
})

/** 确定性伪随机数（mulberry32），使性质测试可复现。 */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('性质：随机插入增量不改变最终结果', () => {
  /** 两轮对话；每轮随机切分回复与推理，增量以随机顺序交错，并随机插入重复增量。 */
  function scenario(seed: number): EventEnvelope[] {
    const rand = rng(seed)
    const split = (s: string) => {
      const parts: string[] = []
      let rest = s
      while (rest.length > 0) {
        const n = 1 + Math.floor(rand() * rest.length)
        parts.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      return parts
    }
    const drafts: Draft[] = [
      draft('run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
    ]
    for (const turn of [1, 2]) {
      const t = { turnId: `t${turn}` }
      const s = { turnId: `t${turn}`, stepId: `st${turn}` }
      const id = `a${turn}`
      const reply = `第 ${turn} 轮回复：${'内容'.repeat(1 + Math.floor(rand() * 5))}`
      const thought = rand() < 0.5 ? undefined : `思考 ${turn}`
      drafts.push(
        draft('message.user', { messageId: `u${turn}`, content: text(`问题 ${turn}`) }, t),
        draft('turn.started', {}, t),
        draft('step.started', { model }, s),
      )
      const textQ = split(reply).map((x) =>
        draft('message.assistant.delta', { messageId: id, text: x }, s),
      )
      const reasonQ = thought
        ? split(thought).map((x) => draft('message.reasoning.delta', { messageId: id, text: x }, s))
        : []
      while (textQ.length + reasonQ.length > 0) {
        const q = reasonQ.length > 0 && (textQ.length === 0 || rand() < 0.5) ? reasonQ : textQ
        drafts.push(q.shift()!)
        if (rand() < 0.2)
          drafts.push(
            draft('usage.reported', { model, usage: { inputTokens: 1, outputTokens: 1 } }, t),
          )
      }
      drafts.push(
        draft(
          'message.assistant.completed',
          {
            messageId: id,
            content: text(reply),
            ...(thought ? { reasoning: { text: thought, providerId: 'fake' } } : {}),
            model,
          },
          s,
        ),
        draft('step.completed', { model, finishReason: 'stop', durationMs: 1 }, s),
        draft('turn.completed', { durationMs: 1 }, t),
      )
    }
    const events = sequence(drafts)
    // 随机重放一段已发送的事件（模拟补发与实时重叠）
    const from = Math.floor(rand() * events.length)
    const replay = events.slice(from, from + Math.floor(rand() * 10))
    const at = Math.min(events.length, from + replay.length + Math.floor(rand() * 5))
    return [...events.slice(0, at), ...replay, ...events.slice(at)]
  }

  const seeds = Array.from({ length: 200 }, (_, i) => i + 1)

  it('200 个随机场景', () => {
    for (const seed of seeds) {
      const events = scenario(seed)
      const withDeltas: SessionView = reduceAll(events)
      expect(withDeltas, `seed ${seed}`).toEqual(reduceAll(persistedOnly(events)))
      expect(withDeltas.live).toEqual({})
      expect(withDeltas.messages.map((m) => m.messageId)).toEqual(['u1', 'a1', 'u2', 'a2'])
    }
  })

  it('任意时刻，进行中的文本与推理都是最终内容的前缀', () => {
    for (const seed of seeds.slice(0, 50)) {
      const events = scenario(seed)
      const final = new Map<string, { text: string; reasoning: string }>()
      for (const e of events) {
        if (e.type !== 'message.assistant.completed') continue
        const part = e.payload.content[0]
        final.set(e.payload.messageId, {
          text: part?.type === 'text' ? part.text : '',
          reasoning: e.payload.reasoning?.text ?? '',
        })
      }
      let view = createSessionView(SID)
      for (const event of events) {
        view = reduceSession(view, event)
        for (const live of Object.values(view.live)) {
          const expected = final.get(live.messageId)!
          expect(expected.text.startsWith(live.text), `seed ${seed}`).toBe(true)
          expect(expected.reasoning.startsWith(live.reasoning), `seed ${seed}`).toBe(true)
        }
      }
    }
  })
})
