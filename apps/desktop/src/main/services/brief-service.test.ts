import { describe, expect, it, vi } from 'vitest'
import type { HostModelConfig, ModelRef, UnsequencedEvent } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { BRIEF_SYSTEM_PROMPT } from './brief.js'
import { createBriefService, type CompleteFn } from './brief-service.js'
import { createSessionEventService } from './event-service.js'

const sessionModel = { providerId: 'local', modelId: 'main' }

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
  readonly sessionBrief?: boolean
  readonly configured?: (model: ModelRef) => boolean
  readonly failResult?: boolean
  readonly throwError?: boolean
  readonly pause?: Promise<void>
}) {
  const storage = createMemoryStorage()
  storage.projects.create({ projectId: 'p1', name: 'demo', path: '/work' })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: '/work',
    title: '修复',
    model: sessionModel,
  })
  const events = createSessionEventService({ storage })
  const requests: { model: ModelRef; content: string; system?: string }[] = []
  let text = '目标：修复登录'
  const complete: CompleteFn = async (request) => {
    requests.push({
      model: request.model.ref,
      content: request.messages.map((message) => message.content).join('\n'),
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
    })
    if (options?.pause) await options.pause
    if (options?.throwError) throw new Error('boom')
    if (options?.failResult) {
      return { ok: false, error: { code: 'model.failed' }, retryable: false }
    }
    return { ok: true, text, usage: { inputTokens: 3, outputTokens: 2 } }
  }
  const onError = vi.fn()
  const service = createBriefService({
    events,
    settings: {
      get: () => ({
        locale: 'zh-CN',
        providers: [],
        ...(options?.sessionBrief === false ? { sessionBrief: false } : {}),
      }),
      hostModelConfig: (model) =>
        options?.configured && !options.configured(model) ? undefined : configOf(model),
      credentialRef: () => undefined,
    },
    credentials: { resolve: async () => undefined },
    complete,
    now: () => 50,
    onError,
  })
  return {
    events,
    requests,
    onError,
    service,
    setText(next: string) {
      text = next
    },
  }
}

function publish(events: ReturnType<typeof setup>['events'], batch: readonly UnsequencedEvent[]) {
  events.publish(batch)
}

const opened = (): UnsequencedEvent => ({
  v: 1,
  sessionId: 's1',
  runId: 's1',
  ts: 1,
  type: 'session.created',
  payload: {
    projectId: 'p1',
    projectPath: '/work',
    workspacePath: '/work',
    title: '修复',
    model: sessionModel,
  },
})

function turn(id: string, user = '目标是修复登录', assistant = '好的'): UnsequencedEvent[] {
  return [
    {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      ts: 2,
      type: 'message.user',
      payload: { messageId: `u-${id}`, content: [{ type: 'text', text: user }] },
    },
    {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      ts: 3,
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
      ts: 4,
      turnId: id,
      type: 'turn.completed',
      payload: { durationMs: 5 },
    },
  ]
}

const briefs = (events: ReturnType<typeof setup>['events']) =>
  events.readAfter('s1', 0).filter((event) => event.type === 'session.brief.updated')

describe('createBriefService', () => {
  it('updates the brief after a turn and skips an unchanged one', async () => {
    const { events, requests, service } = setup()
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(briefs(events)).toHaveLength(1))
    expect(requests[0]?.system).toBe(BRIEF_SYSTEM_PROMPT)
    expect(briefs(events)[0]).toMatchObject({
      payload: { content: '目标：修复登录', editedBy: 'agent' },
    })
    expect(events.readAfter('s1', 0).some((event) => event.type === 'usage.reported')).toBe(true)

    publish(events, turn('t2', '再看一眼', '没有新目标'))
    await vi.waitFor(() =>
      expect(
        events.readAfter('s1', 0).filter((event) => event.type === 'usage.reported'),
      ).toHaveLength(2),
    )
    expect(briefs(events)).toHaveLength(1)
    service.stop()
  })

  it('keeps a user edit and only appends, then stays quiet when nothing new arrives', async () => {
    const { events, requests, service, setText } = setup()
    publish(events, [
      opened(),
      ...turn('t1'),
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 6,
        type: 'session.brief.updated',
        payload: { content: '不要改 API', editedBy: 'user' },
      },
    ])
    await vi.waitFor(() => expect(briefs(events)).toHaveLength(2))
    expect(requests[0]?.content).toContain('不要改 API')
    expect(briefs(events).at(-1)).toMatchObject({
      payload: { content: '不要改 API\n目标：修复登录', editedBy: 'user' },
    })

    setText('不要改 API\n目标：修复登录')
    publish(events, turn('t2', '继续', '好'))
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    await Promise.resolve()
    expect(briefs(events)).toHaveLength(2)
    service.stop()
  })

  it('does not call the model when automatic updates are off', async () => {
    const { events, requests, service } = setup({ sessionBrief: false })
    publish(events, [opened(), ...turn('t1')])
    await Promise.resolve()
    expect(requests).toHaveLength(0)
    expect(briefs(events)).toHaveLength(0)
    service.stop()
  })

  it('stays quiet when the session model has no provider', async () => {
    const quiet = setup({ configured: () => false })
    publish(quiet.events, [opened(), ...turn('t1')])
    await Promise.resolve()
    expect(quiet.onError).not.toHaveBeenCalled()
    quiet.service.stop()
  })

  it('skips a turn without a user message', async () => {
    const { events, requests, service } = setup()
    publish(events, [
      opened(),
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 4,
        turnId: 't1',
        type: 'turn.completed',
        payload: { durationMs: 5 },
      },
    ])
    await Promise.resolve()
    expect(requests).toHaveLength(0)
    service.stop()
  })

  it('reports a failed completion and a thrown completion', async () => {
    const failed = setup({ failResult: true })
    publish(failed.events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(failed.onError).toHaveBeenCalled())
    expect(failed.onError.mock.calls[0]?.[0]).toMatchObject({ message: 'model.failed' })
    failed.service.stop()

    const thrown = setup({ throwError: true })
    publish(thrown.events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(thrown.onError).toHaveBeenCalled())
    expect(thrown.onError.mock.calls[0]?.[0]).toMatchObject({ message: 'boom' })
    thrown.service.stop()
  })

  it('does not publish after stopping while a completion is in flight', async () => {
    let release!: () => void
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    const { events, requests, service } = setup({ pause })
    publish(events, [opened(), ...turn('t1')])
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    service.stop()
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(briefs(events)).toHaveLength(0)
  })
})
