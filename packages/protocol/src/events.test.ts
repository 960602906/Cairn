import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  LIVE_EVENT_TYPES,
  isLiveEventType,
  isPersistedEvent,
  parseEvent,
  parseUnsequencedEvent,
  payloadSchemaOf,
  type EventEnvelope,
  type EventPayload,
  type EventType,
  type PersistedEvent,
} from './index.js'

const model = { providerId: 'deepseek', modelId: 'deepseek-chat' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const err = { code: 'model.rate_limited', params: { retryAfterMs: 1000 } }
const text = [{ type: 'text' as const, text: '你好' }]

/** 每种事件一个合法 payload 样例。新增事件类型时必须在这里补充。 */
const validPayloads: { [K in EventType]: EventPayload<K> } = {
  'session.created': {
    projectId: 'p1',
    projectPath: 'C:\\code\\demo',
    workspacePath: 'C:\\code\\demo',
    title: '新会话',
  },
  'session.renamed': { title: '重命名' },
  'session.model.changed': { model },
  'session.crashed': { error: { code: 'host.crashed' } },
  'session.archived': {},
  'session.brief.updated': { content: '目标：修复测试', editedBy: 'agent' },
  'run.created': {
    agent: { id: 'builtin.coder', version: 1 },
    model,
    mode: 'interactive',
    limits,
  },
  'run.state.changed': { from: 'idle', to: 'thinking' },
  'run.disposed': {},
  'run.delegated': {
    childRunId: 'r2',
    agent: { id: 'builtin.explorer', version: 1 },
    task: 't',
    workspace: 'isolated',
    workspacePath: 'C:\\code\\demo\\.cairn\\worktrees\\r2',
  },
  'run.child.completed': {
    childRunId: 'r2',
    status: 'completed',
    summary: 'done',
    usage: { inputTokens: 100, outputTokens: 20 },
    changeSetId: 'cs1',
    issues: ['i1'],
  },
  'step.started': { model },
  'step.completed': {
    model,
    finishReason: 'stop',
    durationMs: 1200,
    usage: { inputTokens: 100, outputTokens: 20 },
  },
  'turn.started': {},
  'turn.completed': { durationMs: 3000 },
  'turn.aborted': { reason: 'user' },
  'turn.failed': { error: err, retryable: true },
  'turn.limit_reached': { limit: 'maxStepsPerTurn', value: 50 },
  'message.user': { messageId: 'm1', content: text },
  'message.assistant.delta': { messageId: 'm2', text: '你' },
  'message.reasoning.delta': { messageId: 'm2', text: '思考' },
  'message.assistant.completed': {
    messageId: 'm2',
    content: text,
    reasoning: { text: '思考', providerId: 'deepseek' },
    toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }],
    model,
  },
  'tool.requested': { toolCallId: 'c1', name: 'read_file', input: { path: 'a.ts' } },
  'tool.started': { toolCallId: 'c1' },
  'tool.output.delta': { toolCallId: 'c1', stream: 'stdout', text: 'ok\n' },
  'tool.completed': {
    toolCallId: 'c1',
    output: text,
    durationMs: 5,
    display: {
      kind: 'terminal',
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      durationMs: 5,
      shell: 'PowerShell 7.5.0',
      cwd: 'C:\\code\\demo',
      chunks: [{ stream: 'stdout', text: '\u001b[32mok\u001b[0m\n' }],
      omittedChars: 10,
      omittedAt: 1,
    },
  },
  'tool.failed': { toolCallId: 'c1', error: { code: 'tool.file_not_found' } },
  'tool.cancelled': { toolCallId: 'c1', reason: 'user' },
  'approval.requested': {
    approvalId: 'a1',
    toolCallId: 'c1',
    matchedRuleIds: [],
    reasonCode: 'permission.default_ask',
  },
  'approval.resolved': { approvalId: 'a1', decision: 'allow_once', decidedBy: 'user' },
  'file.changed': { changeId: 'ch1', path: 'src/a.ts', kind: 'modify' },
  'checkpoint.created': { checkpointId: 'cp1', reason: 'turn_start' },
  'checkpoint.restored': { checkpointId: 'cp1', truncateConversation: false },
  'usage.reported': { model, usage: { inputTokens: 1, outputTokens: 1 } },
  'context.compacted': { summary: '摘要', coversTurns: ['t1', 't3'] },
  'model.fallback': { from: model, to: { providerId: 'ollama', modelId: 'qwen' }, error: err },
  'model.retry': { attempt: 1, maxRetries: 3, delayMs: 1000, error: err },
  'plan.proposed': {
    planId: 'pl1',
    content: {
      goal: '读代码',
      files: ['src/a.ts'],
      steps: [{ id: 'read', title: '读 src/a.ts' }],
      risks: '',
      verification: '单测通过',
      markdown: '1. 读代码',
    },
  },
  'plan.approved': { planId: 'pl1' },
  'plan.rejected': { planId: 'pl1', feedback: '太复杂' },
  'plan.step.updated': { planId: 'pl1', stepIndex: 0, status: 'done', note: '改了测试' },
}

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    sessionId: 's1',
    runId: 'r1',
    seq: 7,
    ts: 1_700_000_000_000,
    type,
    payload,
    ...extra,
  }
}

describe('事件类型登记', () => {
  it('每种事件类型都有合法样例', () => {
    expect(Object.keys(validPayloads).sort()).toEqual([...EVENT_TYPES].sort())
  })

  it('事件类型名不重复', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })

  it('增量事件都是 .delta 结尾，且 .delta 事件都被标为增量', () => {
    for (const type of EVENT_TYPES) {
      expect(isLiveEventType(type)).toBe(type.endsWith('.delta'))
    }
    expect(LIVE_EVENT_TYPES).toHaveLength(3)
  })
})

describe('parseEvent', () => {
  it.each(Object.entries(validPayloads))('接受合法的 %s', (type, payload) => {
    const result = parseEvent(envelope(type, payload))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe(type)
  })

  it('保留可选的信封字段', () => {
    const result = parseEvent(
      envelope('turn.started', {}, { parentRunId: 'r0', turnId: 't1', stepId: 'st1' }),
    )
    expect(result.ok && result.value).toMatchObject({
      parentRunId: 'r0',
      turnId: 't1',
      stepId: 'st1',
    })
  })

  it.each([
    ['未知事件类型', envelope('session.exploded', {})],
    ['不支持的 schema 版本', { ...envelope('turn.started', {}), v: 2 }],
    ['缺少 seq', (({ seq: _seq, ...rest }) => rest)(envelope('turn.started', {}))],
    ['负数 seq', envelope('turn.started', {}, { seq: -1 })],
    ['小数 ts', envelope('turn.started', {}, { ts: 1.5 })],
    ['空 sessionId', envelope('turn.started', {}, { sessionId: '' })],
    ['payload 缺少必填字段', envelope('message.user', { messageId: 'm1' })],
    ['payload 字段类型错误', envelope('turn.completed', { durationMs: '3s' })],
    ['非法的运行状态', envelope('run.state.changed', { from: 'idle', to: 'sleeping' })],
    ['非法的内容片段', envelope('message.user', { messageId: 'm', content: [{ type: 'video' }] })],
    ['不存在的限额名', envelope('turn.limit_reached', { limit: 'maxFoo', value: 1 })],
    ['非对象输入', 'turn.started'],
  ])('拒绝：%s', (_name, input) => {
    expect(parseEvent(input).ok).toBe(false)
  })

  it('忽略 payload 中的未知字段（向前兼容：旧版本读取新版本追加的字段）', () => {
    const result = parseEvent(envelope('turn.completed', { durationMs: 1, newField: 'x' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.payload).toEqual({ durationMs: 1 })
  })
})

describe('parseUnsequencedEvent', () => {
  it('接受宿主发出的无 seq 事件', () => {
    const { seq: _seq, ...hostEvent } = envelope('turn.started', {})
    expect(parseUnsequencedEvent(hostEvent).ok).toBe(true)
  })
})

describe('持久化事件与增量事件', () => {
  it('isPersistedEvent 区分两者', () => {
    const delta = parseEvent(envelope('message.assistant.delta', { messageId: 'm', text: 'a' }))
    const done = parseEvent(envelope('turn.completed', { durationMs: 1 }))
    expect(delta.ok && isPersistedEvent(delta.value)).toBe(false)
    expect(done.ok && isPersistedEvent(done.value)).toBe(true)
  })

  it('类型层面：增量事件不能传给持久化接口', () => {
    const persist = (_e: PersistedEvent) => undefined
    const delta = {
      v: EVENT_SCHEMA_VERSION,
      sessionId: 's',
      runId: 'r',
      seq: 1,
      ts: 1,
      type: 'message.assistant.delta',
      payload: { messageId: 'm', text: 'a' },
    } as const satisfies EventEnvelope
    // @ts-expect-error 增量事件不能赋值给 PersistedEvent
    persist(delta)
    expectTypeOf<EventEnvelope<'message.assistant.delta'>>().not.toExtend<PersistedEvent>()
    expectTypeOf<EventEnvelope<'turn.completed'>>().toExtend<PersistedEvent>()
  })

  it('类型层面：type 收窄后 payload 类型随之确定', () => {
    const narrow = (e: EventEnvelope) => (e.type === 'message.user' ? e.payload.content : undefined)
    expectTypeOf(narrow).returns.toEqualTypeOf<
      EventPayload<'message.user'>['content'] | undefined
    >()
  })
})

describe('其他导出', () => {
  it('parseUnsequencedEvent 拒绝非法事件', () => {
    const result = parseUnsequencedEvent({ v: 1, sessionId: 's', runId: 'r', ts: 1, type: 'nope' })
    expect(result.ok).toBe(false)
  })

  it('payloadSchemaOf 返回对应的 payload schema', () => {
    expect(payloadSchemaOf('turn.completed').safeParse({ durationMs: 1 }).success).toBe(true)
    expect(payloadSchemaOf('turn.completed').safeParse({}).success).toBe(false)
  })
})
