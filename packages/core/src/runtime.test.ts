import type { CanonicalMessage, ModelRef } from '@nexus/protocol'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AbortSignalLike,
  AgentRuntime,
  AssistantMessage,
  ResolvedModel,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeHooks,
  RuntimeSession,
  RuntimeSessionInit,
  RuntimeToolResult,
  StepFinishReason,
  UserMessage,
} from './index.js'

const ref: ModelRef = { providerId: 'fake', modelId: 'echo' }
const model: ResolvedModel = {
  ref,
  providerKind: 'openai',
  baseUrl: 'http://localhost:0',
  profile: {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
  },
}

/**
 * 只用接口实现的最小运行时：把用户消息原样回复；消息以 "tool:" 开头时先调用一次工具。
 * 用来验证接口足以表达一次带工具调用的循环（FakeRuntime 在 M0-07b 实现）。
 */
const echoRuntime: AgentRuntime = {
  id: 'echo',
  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const listeners = new Set<(e: RuntimeEvent) => void>()
    const history: CanonicalMessage[] = [...init.history]
    const emit = (e: RuntimeEvent) => listeners.forEach((l) => l(e))
    let aborted = false
    const assistant = (
      text: string,
      toolCalls?: AssistantMessage['toolCalls'],
    ): AssistantMessage => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      ...(toolCalls ? { toolCalls } : {}),
      model: init.model.ref,
      ts: 0,
    })
    return {
      async prompt(input) {
        history.push(input)
        const text = input.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
        if (text.startsWith('tool:')) {
          const call = { id: 'c1', name: 'echo_tool', input: { text } }
          emit({ type: 'step.started', model: init.model.ref })
          const msg = assistant('', [call])
          emit({ type: 'message.completed', message: msg })
          emit({ type: 'step.completed', finishReason: 'tool_calls' })
          history.push(msg)
          const gate = await init.hooks.beforeToolCall(call)
          const result: RuntimeToolResult =
            gate.action === 'allow'
              ? await init.hooks.executeTool(call, init.signal)
              : { status: 'denied', content: [{ type: 'text', text: gate.reason }] }
          history.push({
            role: 'tool',
            toolCallId: call.id,
            content: [...result.content],
            status: result.status,
            ts: 0,
          })
        }
        if (aborted) {
          emit({ type: 'loop.ended', outcome: 'aborted' })
          return
        }
        emit({ type: 'step.started', model: init.model.ref })
        emit({ type: 'text.delta', text })
        const reply = assistant(text)
        emit({ type: 'message.completed', message: reply })
        emit({
          type: 'step.completed',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        history.push(reply)
        emit({ type: 'loop.ended', outcome: 'completed' })
      },
      async steer(input) {
        history.push(input)
      },
      async abort() {
        aborted = true
      },
      onEvent(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      exportHistory: () => [...history],
      async dispose() {
        listeners.clear()
      },
    }
  },
}

const user = (text: string): UserMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ts: 0,
})

function hooks(gate: 'allow' | 'deny'): RuntimeHooks & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async beforeToolCall(call) {
      calls.push(`gate:${call.name}`)
      return gate === 'allow' ? { action: 'allow' } : { action: 'deny', reason: 'no' }
    },
    async executeTool(call) {
      calls.push(`exec:${call.name}`)
      return { status: 'ok', content: [{ type: 'text', text: 'done' }] }
    },
  }
}

async function run(text: string, gate: 'allow' | 'deny' = 'allow') {
  const h = hooks(gate)
  const session = await echoRuntime.createSession({
    model,
    systemPrompt: '',
    tools: [],
    history: [],
    signal: new AbortController().signal,
    hooks: h,
  })
  const events: RuntimeEventType[] = []
  const off = session.onEvent((e) => events.push(e.type))
  await session.prompt(user(text))
  off()
  return { events, calls: h.calls, history: session.exportHistory() }
}

describe('运行时接口', () => {
  it('纯文本回复的事件顺序', async () => {
    const { events, history } = await run('你好')
    expect(events).toEqual([
      'step.started',
      'text.delta',
      'message.completed',
      'step.completed',
      'loop.ended',
    ])
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('工具调用经过钩子，结果进入历史', async () => {
    const { events, calls, history } = await run('tool:x')
    expect(calls).toEqual(['gate:echo_tool', 'exec:echo_tool'])
    expect(events.filter((e) => e === 'step.started')).toHaveLength(2)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('beforeToolCall 拒绝时不执行工具', async () => {
    const { calls, history } = await run('tool:x', 'deny')
    expect(calls).toEqual(['gate:echo_tool'])
    expect(history[2]).toMatchObject({ role: 'tool', status: 'denied' })
  })
})

describe('类型约束', () => {
  it('标准 AbortSignal 可作为 AbortSignalLike', () => {
    expectTypeOf<AbortSignal>().toExtend<AbortSignalLike>()
  })

  it('prompt 只接受用户消息', () => {
    expectTypeOf<RuntimeSession['prompt']>().parameter(0).toEqualTypeOf<UserMessage>()
    expectTypeOf<AssistantMessage>().not.toExtend<UserMessage>()
  })

  it('步骤结束原因与协议事件一致', () => {
    expectTypeOf<StepFinishReason>().toEqualTypeOf<
      'stop' | 'tool_calls' | 'length' | 'aborted' | 'error'
    >()
  })

  it('运行时工具结果不能是 unknown（只用于恢复）', () => {
    expectTypeOf<'unknown'>().not.toExtend<RuntimeToolResult['status']>()
  })

  it('事件类型集合', () => {
    expectTypeOf<RuntimeEventType>().toEqualTypeOf<
      | 'step.started'
      | 'text.delta'
      | 'reasoning.delta'
      | 'message.completed'
      | 'step.completed'
      | 'loop.ended'
    >()
  })
})
