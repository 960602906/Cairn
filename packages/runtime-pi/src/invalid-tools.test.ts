/**
 * M1-14b 验收：`RunEngine` + pi 适配器 + mock 端点：非法工具调用作为工具结果回给模型并记录事件，
 * 连续失败达到上限时结束本轮。
 */
import { RunEngine, rebuildHistory } from '@nexus/core'
import type { EventEnvelope, UnsequencedEvent } from '@nexus/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiRuntime } from './session.js'
import { sse, startMockOpenAI, type MockOpenAI, type MockResponse } from './testing/mock-openai.js'

let mock: MockOpenAI | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

const call = (id: string, name: string, args: string): MockResponse => ({
  kind: 'stream',
  chunks: [sse.toolCall(0, id, name, args), sse.finish('tool_calls')],
})
const ANSWER: MockResponse = {
  kind: 'stream',
  chunks: [sse.text('好的'), sse.finish('stop')],
}

async function run(responses: readonly MockResponse[]) {
  mock = await startMockOpenAI(responses)
  const events: UnsequencedEvent[] = []
  const executeTool = vi.fn(async () => ({
    status: 'ok' as const,
    content: [{ type: 'text' as const, text: 'ok' }],
  }))
  const engine = await RunEngine.create({
    sessionId: 's1',
    runId: 'r1',
    agent: { id: 'builtin.coder', version: 1 },
    mode: 'interactive',
    limits: { maxStepsPerTurn: 10, maxTurnDurationMs: 60_000, maxConsecutiveToolErrors: 2 },
    runtime: new PiRuntime(),
    model: {
      ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
      providerKind: 'openai',
      baseUrl: mock.baseUrl,
      apiKey: 'test-key-not-real',
      profile: {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        supportsTools: true,
        supportsParallelToolCalls: true,
        supportsReasoning: false,
      },
    },
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    executeTool,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  })
  await engine.prompt({ messageId: 'u1', content: [{ type: 'text', text: 'hi' }] })
  const failed = events.flatMap((e) => (e.type === 'tool.failed' ? [e.payload.error.code] : []))
  return { engine, events, executeTool, failed, requests: mock.requests.length }
}

describe('非法工具调用（pi + mock 端点）', () => {
  it('工具不存在后模型改正，本轮完成；重建的历史中调用有结果', async () => {
    const r = await run([
      call('c1', 'delete_all', '{}'),
      call('c2', 'read_file', '{"path":"a.ts"}'),
      ANSWER,
    ])
    expect(r.failed).toEqual(['tool.not_found'])
    expect(r.executeTool).toHaveBeenCalledTimes(1)
    expect(r.engine.state).toBe('completed')
    const envelopes = r.events.map((e, i) => ({ ...e, seq: i + 1 }) as EventEnvelope)
    const history = rebuildHistory(envelopes, { runId: 'r1' })
    expect(history.filter((m) => m.role === 'tool').map((m) => m.status)).toEqual(['error', 'ok'])
  })

  it('连续两次参数非法：达到上限，结束本轮', async () => {
    const r = await run([
      call('c1', 'read_file', '{"path":'),
      call('c2', 'read_file', '{"file":"a.ts"}'),
      ANSWER,
    ])
    expect(r.failed).toEqual(['tool.invalid_input', 'tool.invalid_input'])
    expect(r.executeTool).not.toHaveBeenCalled()
    expect(r.events.find((e) => e.type === 'turn.limit_reached')?.payload).toEqual({
      limit: 'maxConsecutiveToolErrors',
      value: 2,
    })
    expect(r.engine.state).toBe('failed')
  })
})
