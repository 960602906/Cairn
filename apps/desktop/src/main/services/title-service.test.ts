import { describe, expect, it, vi } from 'vitest'
import type { HostModelConfig, ModelRef, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createSessionEventService } from './event-service.js'
import { createTitleService, type CompleteFn } from './title-service.js'
import { TITLE_SYSTEM_PROMPT } from './title.js'

const sessionModel = { providerId: 'local', modelId: 'main' }
const auxiliary = { providerId: 'local', modelId: 'aux' }

const configOf = (model: ModelRef): HostModelConfig => ({
  kind: 'openai',
  baseUrl: 'http://127.0.0.1/v1',
  profile: {
    id: model.modelId,
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
  },
})

function setup(options?: {
  readonly auxiliary?: ModelRef
  readonly configured?: (model: ModelRef) => boolean
  readonly apiKey?: string
}) {
  const storage = createMemoryStorage()
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: '/work',
    title: '',
    model: sessionModel,
  })
  const events = createSessionEventService({ storage })
  const requests: { model: ModelRef; apiKey?: string; content: string; system?: string }[] = []
  let complete: CompleteFn = async (request) => {
    requests.push({
      model: request.model.ref,
      ...(request.model.apiKey ? { apiKey: request.model.apiKey } : {}),
      content: request.messages.map((message) => message.content).join('\n'),
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
    })
    return { ok: true, text: '  "整理日志" \n忽略', usage: { inputTokens: 3, outputTokens: 2 } }
  }
  const onError = vi.fn()
  const service = createTitleService({
    events,
    storage,
    settings: {
      get: () => ({
        locale: 'zh-CN',
        providers: [],
        ...(options?.auxiliary ? { auxiliaryModel: options.auxiliary } : {}),
      }),
      hostModelConfig: (model) =>
        options?.configured && !options.configured(model) ? undefined : configOf(model),
      credentialRef: () => (options?.apiKey ? 'local' : undefined),
    },
    credentials: {
      resolve: async () => (options?.apiKey ? { apiKey: options.apiKey } : undefined),
    },
    complete: (request) => complete(request),
    now: () => 50,
    onError,
  })
  return {
    storage,
    events,
    requests,
    onError,
    service,
    setComplete(next: CompleteFn) {
      complete = next
    },
  }
}

function publish(events: ReturnType<typeof setup>['events'], batch: readonly UnsequencedEvent[]) {
  events.publish(batch)
}

function opened(title = '', model: ModelRef | null = sessionModel): UnsequencedEvent {
  return {
    v: 1,
    sessionId: 's1',
    runId: 's1',
    ts: 1,
    type: 'session.created',
    payload: {
      projectId: 'p1',
      projectPath: '/work',
      workspacePath: '/work',
      title,
      ...(model ? { model } : {}),
    },
  }
}

function turn(id: string, user = '帮我整理日志', assistant = '好的，已整理。'): UnsequencedEvent[] {
  return [
    { v: 1, sessionId: 's1', runId: 'r1', ts: 2, turnId: id, type: 'turn.started', payload: {} },
    {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      ts: 3,
      turnId: id,
      type: 'message.user',
      payload: { messageId: `u-${id}`, content: [{ type: 'text', text: user }] },
    },
    {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      ts: 4,
      turnId: id,
      type: 'message.assistant.completed',
      payload: {
        messageId: `a-${id}`,
        content: [{ type: 'text', text: assistant }],
        model: sessionModel,
      },
    },
    {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      ts: 5,
      turnId: id,
      type: 'turn.completed',
      payload: { durationMs: 8 },
    },
  ]
}

const titles = (events: ReturnType<typeof setup>['events']) =>
  events.readAfter('s1', 0).filter((event) => event.type === 'session.renamed')

describe('createTitleService', () => {
  it('names an untitled session after the first turn and records auxiliary usage', async () => {
    const { events, storage, requests, service } = setup()
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(storage.sessions.get('s1')?.title).toBe('整理日志'))
    expect(requests[0]).toMatchObject({
      model: sessionModel,
      system: TITLE_SYSTEM_PROMPT,
    })
    expect(requests[0]?.content).toContain('帮我整理日志')
    expect(requests[0]?.content).toContain('好的，已整理。')
    expect(titles(events)).toEqual([
      expect.objectContaining({ payload: { title: '整理日志', source: 'auto' } }),
    ])
    expect(
      events.readAfter('s1', 0).find((event) => event.type === 'usage.reported'),
    ).toMatchObject({
      runId: 'r1',
      turnId: 't1',
      payload: {
        model: sessionModel,
        usage: { inputTokens: 3, outputTokens: 2 },
        auxiliary: true,
      },
    })
    publish(events, turn('t2', '第二轮', '继续'))
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(storage.sessions.get('s1')?.title).toBe('整理日志')
    service.stop()
  })

  it('uses the auxiliary model and its key when one is configured', async () => {
    const { events, requests, service } = setup({ auxiliary, apiKey: 'sk-aux' })
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ model: auxiliary, apiKey: 'sk-aux' })
    service.stop()
  })

  it('does not rename a titled session or one the user renamed', async () => {
    const titled = setup()
    publish(titled.events, [opened('已有标题'), ...turn('t1')])
    await Promise.resolve()
    expect(titled.requests).toHaveLength(0)
    titled.service.stop()

    const renamed = setup()
    publish(renamed.events, [
      opened(),
      {
        v: 1,
        sessionId: 's1',
        runId: 's1',
        ts: 1,
        type: 'session.renamed',
        payload: { title: '', source: 'user' },
      },
      ...turn('t1'),
    ])
    await Promise.resolve()
    expect(renamed.requests).toHaveLength(0)
    renamed.service.stop()
  })

  it('does not title a later turn when the first turn failed', async () => {
    const { events, requests, service } = setup()
    publish(events, [
      opened(),
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 2,
        turnId: 't1',
        type: 'turn.started',
        payload: {},
      },
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 3,
        turnId: 't1',
        type: 'turn.failed',
        payload: { error: { code: 'model.network_error' }, retryable: true },
      },
      ...turn('t2'),
    ])
    await Promise.resolve()
    expect(requests).toHaveLength(0)
    service.stop()
  })

  it('logs an unexpected completion error and leaves the title empty', async () => {
    const { events, storage, onError, service, setComplete } = setup()
    setComplete(async () => {
      throw new Error('boom')
    })
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('boom')
    expect(storage.sessions.get('s1')?.title).toBe('')
    service.stop()
  })

  it('logs a failed completion and leaves the title empty', async () => {
    const { events, storage, onError, service, setComplete } = setup()
    setComplete(async () => ({
      ok: false,
      error: { code: 'model.rate_limited' },
      retryable: true,
    }))
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('model.rate_limited')
    expect(storage.sessions.get('s1')?.title).toBe('')
    expect(titles(events)).toEqual([])
    service.stop()
  })

  it('records usage but does not rename when the model returns a blank title', async () => {
    const { events, storage, service, setComplete } = setup()
    setComplete(async () => ({ ok: true, text: '   ', usage: { inputTokens: 1, outputTokens: 1 } }))
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() =>
      expect(events.readAfter('s1', 0).some((event) => event.type === 'usage.reported')).toBe(true),
    )
    expect(storage.sessions.get('s1')?.title).toBe('')
    expect(titles(events)).toEqual([])
    service.stop()
  })

  it('does not overwrite a rename that arrives while the model is running', async () => {
    const { events, storage, requests, service, setComplete } = setup()
    let finish: (text: string) => void = () => {}
    setComplete((request) => {
      requests.push({
        model: request.model.ref,
        content: request.messages.map((message) => message.content).join('\n'),
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      })
      return new Promise((resolve) => {
        finish = (text) => resolve({ ok: true, text, usage: { inputTokens: 1, outputTokens: 1 } })
      })
    })
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    storage.sessions.rename('s1', '手动')
    publish(events, [
      {
        v: 1,
        sessionId: 's1',
        runId: 's1',
        ts: 9,
        type: 'session.renamed',
        payload: { title: '手动', source: 'user' },
      },
    ])
    finish('自动标题')
    await vi.waitFor(() =>
      expect(events.readAfter('s1', 0).some((event) => event.type === 'usage.reported')).toBe(true),
    )
    expect(storage.sessions.get('s1')?.title).toBe('手动')
    expect(titles(events).map((event) => event.payload)).toEqual([
      { title: '手动', source: 'user' },
    ])
    service.stop()
  })

  it('skips quietly when there is nothing to call, and logs a broken auxiliary model', async () => {
    const fake = setup({ configured: () => false })
    publish(fake.events, [opened(), ...turn('t1')])
    await Promise.resolve()
    expect(fake.onError).not.toHaveBeenCalled()
    expect(fake.requests).toHaveLength(0)
    fake.service.stop()

    const none = setup()
    publish(none.events, [opened('', null), ...turn('t1')])
    await Promise.resolve()
    expect(none.onError).not.toHaveBeenCalled()
    none.service.stop()

    const broken = setup({ auxiliary, configured: () => false })
    publish(broken.events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(broken.onError).toHaveBeenCalledOnce())
    expect((broken.onError.mock.calls[0]?.[0] as Error).message).toBe(
      'title: model is not configured',
    )
    expect(broken.requests).toHaveLength(0)
    broken.service.stop()
  })
})
