import {
  CanonicalMessage,
  type EventEnvelope,
  type EventPayload,
  type EventType,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { INTERRUPTED_TOOL_RESULT_TEXT, rebuildHistory } from './index.js'

const model = { providerId: 'fake', modelId: 'fake-1' }
const text = (t: string) => [{ type: 'text' as const, text: t }]
const call = (id: string) => ({ id, name: 'read_file', input: { path: `${id}.ts` } })

interface Header {
  runId?: string
  turnId?: string
}

function stream() {
  let seq = 0
  return function ev<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    header: Header = {},
  ): EventEnvelope<T> {
    seq += 1
    return {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      turnId: 't1',
      ...header,
      seq,
      ts: seq * 10,
      type,
      payload,
    } as EventEnvelope<T>
  }
}

const rebuild = (events: readonly EventEnvelope[]) => {
  const history = rebuildHistory(events, { runId: 'r1' })
  // 输出必须是合法的持久化格式
  expect(CanonicalMessage.array().parse(history)).toEqual(history)
  return history
}

const roles = (history: readonly CanonicalMessage[]) =>
  history.map((m) => (m.role === 'tool' ? `tool:${m.toolCallId}:${m.status}` : m.role))

describe('rebuildHistory', () => {
  it('空事件得到空历史', () => {
    expect(rebuild([])).toEqual([])
  })

  it('用户消息与助手消息', () => {
    const ev = stream()
    const history = rebuild([
      ev('turn.started', {}),
      ev('message.user', { messageId: 'u1', content: text('你好') }),
      ev('message.assistant.delta', { messageId: 'a1', text: '你' }),
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: text('你好！'),
        reasoning: { text: '打招呼', providerId: 'fake' },
        model,
      }),
      ev('turn.completed', { durationMs: 1 }),
    ])
    expect(history).toEqual([
      { role: 'user', content: text('你好'), ts: 20, turnId: 't1' },
      {
        role: 'assistant',
        content: text('你好！'),
        reasoning: { text: '打招呼', providerId: 'fake' },
        model,
        ts: 40,
      },
    ])
  })

  it('工具调用与结果配对，结果按到达顺序紧跟助手消息', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.user', { messageId: 'u1', content: text('读文件') }),
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1'), call('c2'), call('c3'), call('c4'), call('c5')],
        model,
      }),
      ev('tool.requested', { toolCallId: 'c1', name: 'read_file', input: {} }),
      ev('tool.started', { toolCallId: 'c2' }),
      ev('tool.completed', { toolCallId: 'c2', output: text('内容 2'), durationMs: 1 }),
      ev('tool.completed', { toolCallId: 'c1', output: text('内容 1'), durationMs: 1 }),
      ev('tool.failed', {
        toolCallId: 'c3',
        error: { code: 'fs.not_found', params: { path: 'x' } },
      }),
      ev('tool.cancelled', { toolCallId: 'c4', reason: 'timeout' }),
      ev('tool.failed', { toolCallId: 'c5', error: { code: 'fs.denied' } }),
      ev('message.assistant.completed', { messageId: 'a2', content: text('完成'), model }),
    ])
    expect(roles(history)).toEqual([
      'user',
      'assistant',
      'tool:c2:ok',
      'tool:c1:ok',
      'tool:c3:error',
      'tool:c4:cancelled',
      'tool:c5:error',
      'assistant',
    ])
    expect(history[1]).toMatchObject({
      toolCalls: [call('c1'), call('c2'), call('c3'), call('c4'), call('c5')],
    })
    expect(history[2]).toEqual({
      role: 'tool',
      toolCallId: 'c2',
      content: text('内容 2'),
      status: 'ok',
      ts: 50,
    })
    expect(history[4]).toMatchObject({
      content: text('Tool call failed: fs.not_found {"path":"x"}'),
    })
    expect(history[5]).toMatchObject({ content: text('Tool call cancelled (timeout).') })
    expect(history[6]).toMatchObject({ content: text('Tool call failed: fs.denied') })
  })

  it('被打断的部分回复不进入历史', () => {
    const ev = stream()
    const history = rebuild([
      ev('turn.started', {}),
      ev('message.user', { messageId: 'u1', content: text('写一段') }),
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: text('写到一半'),
        model,
        incomplete: true,
      }),
      ev('turn.aborted', { reason: 'user' }),
    ])
    expect(history).toEqual([{ role: 'user', content: text('写一段'), ts: 20, turnId: 't1' }])
  })

  it('空的 toolCalls 不写入助手消息', () => {
    const ev = stream()
    const [msg] = rebuild([
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: text('x'),
        toolCalls: [],
        model,
      }),
    ])
    expect(msg).not.toHaveProperty('toolCalls')
    expect(msg).not.toHaveProperty('reasoning')
  })

  it('审批被拒绝、被取消', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1'), call('c2'), call('c3'), call('c4')],
        model,
      }),
      ev('approval.requested', {
        approvalId: 'p1',
        toolCallId: 'c1',
        matchedRuleIds: [],
        reasonCode: 'ask',
      }),
      ev('approval.requested', {
        approvalId: 'p2',
        toolCallId: 'c2',
        matchedRuleIds: [],
        reasonCode: 'ask',
      }),
      ev('approval.requested', {
        approvalId: 'p3',
        toolCallId: 'c3',
        matchedRuleIds: [],
        reasonCode: 'ask',
      }),
      ev('approval.requested', {
        approvalId: 'p4',
        toolCallId: 'c4',
        matchedRuleIds: [],
        reasonCode: 'ask',
      }),
      ev('approval.resolved', {
        approvalId: 'p1',
        decision: 'deny',
        decidedBy: 'user',
        feedback: '别动这个文件',
      }),
      ev('approval.resolved', { approvalId: 'p2', decision: 'deny', decidedBy: 'rule' }),
      ev('approval.resolved', { approvalId: 'p3', decision: 'cancelled', decidedBy: 'system' }),
      // 批准本身不产生结果，结果来自随后的工具事件
      ev('approval.resolved', { approvalId: 'p4', decision: 'allow_once', decidedBy: 'user' }),
      ev('tool.completed', { toolCallId: 'c4', output: text('ok'), durationMs: 1 }),
      // 未登记的审批被忽略
      ev('approval.resolved', { approvalId: 'zz', decision: 'deny', decidedBy: 'user' }),
      // 审批取消后宿主可能再发 tool.cancelled：同一调用只取第一个结果
      ev('tool.cancelled', { toolCallId: 'c3', reason: 'approval_cancelled' }),
    ])
    expect(roles(history)).toEqual([
      'assistant',
      'tool:c1:denied',
      'tool:c2:denied',
      'tool:c3:cancelled',
      'tool:c4:ok',
    ])
    expect(history[1]).toMatchObject({
      content: text('The user denied this tool call: 别动这个文件'),
    })
    expect(history[2]).toMatchObject({ content: text('The user denied this tool call.') })
    expect(history[3]).toMatchObject({ content: text('The approval request was cancelled.') })
  })

  it('中断的工具调用补 unknown 结果：遇到轮次结束', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1'), call('c2')],
        model,
      }),
      ev('tool.completed', { toolCallId: 'c2', output: text('ok'), durationMs: 1 }),
      ev('turn.aborted', { reason: 'shutdown' }),
      ev('message.user', { messageId: 'u2', content: text('继续') }, { turnId: 't2' }),
    ])
    expect(roles(history)).toEqual(['assistant', 'tool:c2:ok', 'tool:c1:unknown', 'user'])
    expect(history[2]).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      content: text(INTERRUPTED_TOOL_RESULT_TEXT),
      status: 'unknown',
      ts: 30,
    })
  })

  it.each([
    ['turn.completed', (ev: ReturnType<typeof stream>) => ev('turn.completed', { durationMs: 1 })],
    [
      'turn.failed',
      (ev: ReturnType<typeof stream>) =>
        ev('turn.failed', { error: { code: 'x' }, retryable: true }),
    ],
    [
      'message.user',
      (ev: ReturnType<typeof stream>) => ev('message.user', { messageId: 'u', content: text('?') }),
    ],
    [
      'message.assistant.completed',
      (ev: ReturnType<typeof stream>) =>
        ev('message.assistant.completed', { messageId: 'a9', content: text('?'), model }),
    ],
  ])('中断的工具调用补 unknown 结果：遇到 %s', (_name, boundary) => {
    const ev = stream()
    const history = rebuild([
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1')],
        model,
      }),
      boundary(ev),
      // 边界之后才到的结果不再配对
      ev('tool.completed', { toolCallId: 'c1', output: text('迟到'), durationMs: 1 }),
    ])
    expect(history[1]).toMatchObject({ role: 'tool', toolCallId: 'c1', status: 'unknown', ts: 20 })
    expect(history.filter((m) => m.role === 'tool')).toHaveLength(1)
  })

  it('事件在工具执行中结束（崩溃）：补 unknown，时间取最后一条事件', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1')],
        model,
      }),
      ev('tool.started', { toolCallId: 'c1' }),
    ])
    expect(roles(history)).toEqual(['assistant', 'tool:c1:unknown'])
    expect(history[1]?.ts).toBe(20)
  })

  it('只取指定运行的事件', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.user', { messageId: 'u1', content: text('父') }),
      ev('message.user', { messageId: 'u2', content: text('子') }, { runId: 'child' }),
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1')],
        model,
      }),
      ev(
        'tool.completed',
        { toolCallId: 'c1', output: text('子运行的结果'), durationMs: 1 },
        { runId: 'child' },
      ),
    ])
    expect(roles(history)).toEqual(['user', 'assistant', 'tool:c1:unknown'])
  })

  it('重复与乱序的事件按 seq 忽略', () => {
    const ev = stream()
    const events = [
      ev('message.user', { messageId: 'u1', content: text('一') }),
      ev('message.assistant.completed', { messageId: 'a1', content: text('二'), model }),
    ]
    const history = rebuild([...events, ...events])
    expect(roles(history)).toEqual(['user', 'assistant'])
  })

  it('不属于待决调用的工具结果被忽略', () => {
    const ev = stream()
    const history = rebuild([
      ev('tool.completed', { toolCallId: 'ghost', output: text('?'), durationMs: 1 }),
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1')],
        model,
      }),
      ev('tool.completed', { toolCallId: 'c1', output: text('ok'), durationMs: 1 }),
      ev('tool.completed', { toolCallId: 'c1', output: text('重复'), durationMs: 1 }),
    ])
    expect(roles(history)).toEqual(['assistant', 'tool:c1:ok'])
  })

  it('其余事件类型不影响历史', () => {
    const ev = stream()
    const history = rebuild([
      ev('session.renamed', { title: 'x' }),
      ev('usage.reported', { model, usage: { inputTokens: 1, outputTokens: 1 } }),
      ev('message.user', { messageId: 'u1', content: text('一') }),
    ])
    expect(roles(history)).toEqual(['user'])
  })

  it('每个工具调用恰好有一个结果，且紧跟在下一条模型消息之前', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.user', { messageId: 'u1', content: text('开始') }),
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1'), call('c2')],
        model,
      }),
      ev('tool.completed', { toolCallId: 'c1', output: text('ok'), durationMs: 1 }),
      ev('message.assistant.completed', {
        messageId: 'a2',
        content: [],
        toolCalls: [call('c3')],
        model,
      }),
      ev('tool.failed', { toolCallId: 'c3', error: { code: 'x' } }),
      ev('turn.aborted', { reason: 'user' }),
    ])
    const callIds = history.flatMap((m) =>
      m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [],
    )
    const resultIds = history.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))
    expect(resultIds.sort()).toEqual(callIds.sort())
    expect(roles(history)).toEqual([
      'user',
      'assistant',
      'tool:c1:ok',
      'tool:c2:unknown',
      'assistant',
      'tool:c3:error',
    ])
  })

  it('用最后一次压缩替换被覆盖的轮次，而不是重放原始消息', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.user', { messageId: 'u1', content: text('早') }, { turnId: 't1' }),
      ev(
        'message.assistant.completed',
        { messageId: 'a1', content: text('一'), model },
        { turnId: 't1' },
      ),
      ev('message.user', { messageId: 'u2', content: text('中') }, { turnId: 't2' }),
      ev(
        'message.assistant.completed',
        { messageId: 'a2', content: text('二'), model },
        { turnId: 't2' },
      ),
      ev('message.user', { messageId: 'u3', content: text('晚') }, { turnId: 't3' }),
      ev('context.compacted', { summary: '只剩目标', coversTurns: ['t1', 't2'] }),
      ev(
        'message.assistant.completed',
        { messageId: 'a3', content: text('三'), model },
        { turnId: 't3' },
      ),
    ])
    expect(roles(history)).toEqual(['summary', 'user', 'assistant'])
    expect(history[0]).toMatchObject({
      role: 'summary',
      content: '只剩目标',
      coversTurns: ['t1', 't2'],
    })
    expect(history[1]).toMatchObject({ role: 'user', turnId: 't3' })
  })

  it('再次压缩时用新摘要换掉上一次的摘要', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.user', { messageId: 'u1', content: text('早') }, { turnId: 't1' }),
      ev(
        'message.assistant.completed',
        { messageId: 'a1', content: text('一'), model },
        { turnId: 't1' },
      ),
      ev('context.compacted', { summary: '第一次', coversTurns: ['t1', 't1'] }),
      ev('message.user', { messageId: 'u2', content: text('中') }, { turnId: 't2' }),
      ev(
        'message.assistant.completed',
        { messageId: 'a2', content: text('二'), model },
        { turnId: 't2' },
      ),
      ev('message.user', { messageId: 'u3', content: text('晚') }, { turnId: 't3' }),
      ev('context.compacted', { summary: '第二次', coversTurns: ['t1', 't2'] }),
    ])
    expect(
      history.map((message) => (message.role === 'summary' ? message.content : message.role)),
    ).toEqual(['第二次', 'user'])
  })

  it('摘要失败时把点名的工具输出换成省略说明', () => {
    const ev = stream()
    const history = rebuild([
      ev('message.assistant.completed', {
        messageId: 'a1',
        content: [],
        toolCalls: [call('c1')],
        model,
      }),
      ev('tool.completed', { toolCallId: 'c1', output: text('secret'), durationMs: 1 }),
      ev('context.compacted', {
        summary: '',
        coversTurns: ['t1', 't1'],
        degraded: true,
        omittedToolCallIds: ['c1'],
      }),
    ])
    expect(history[1]).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'text',
          text: 'Tool output omitted to free context space. The call itself still happened; do not assume its output.',
        },
      ],
    })
  })
})
