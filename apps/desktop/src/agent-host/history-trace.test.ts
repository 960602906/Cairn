import { describe, expect, it } from 'vitest'
import { FakeRuntime, type RuntimeSessionInit } from '@nexus/core'
import type { CanonicalMessage } from '@nexus/protocol'
import { fakeModel } from './fake-model.js'
import { traceHistory, type HostTraceRecord } from './history-trace.js'

const history: CanonicalMessage[] = [
  { role: 'user', content: [{ type: 'text', text: '你好' }], ts: 1 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '你好' }],
    model: { providerId: 'fake', modelId: 'fake' },
    ts: 2,
  },
]

const init = (messages: readonly CanonicalMessage[]): RuntimeSessionInit => ({
  model: fakeModel({ providerId: 'fake', modelId: 'fake' }),
  systemPrompt: '',
  tools: [],
  history: messages,
  signal: new AbortController().signal,
  hooks: {
    beforeToolCall: async () => ({ action: 'allow' }),
    executeTool: async () => ({ status: 'ok', content: [] }),
  },
})

describe('traceHistory', () => {
  it('每次创建会话写出一行收到的历史，会话本身不受影响', async () => {
    const lines: string[] = []
    const runtime = traceHistory(new FakeRuntime(), (line) => lines.push(line))
    expect(runtime.id).toBe('fake')

    await runtime.createSession(init([]))
    const session = await runtime.createSession(init(history))

    expect(lines.map((line) => JSON.parse(line) as HostTraceRecord)).toEqual([
      { history: [] },
      { history },
    ])
    expect(session.exportHistory()).toEqual(history)
  })
})
