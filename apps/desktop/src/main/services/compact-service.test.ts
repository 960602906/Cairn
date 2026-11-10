import { describe, expect, it, vi } from 'vitest'
import type { HostModelConfig, ModelRef } from '@cairn/protocol'
import { COMPACTION_SYSTEM_PROMPT } from '@cairn/core'
import { createMemoryStorage } from '@cairn/storage'
import { createCompactService, type CompleteFn } from './compact-service.js'
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
  readonly configured?: boolean
  readonly failResult?: boolean
  readonly throwError?: boolean
  readonly skipEvents?: boolean
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
  if (!options?.skipEvents) {
    events.publish([
      {
        v: 1,
        sessionId: 's1',
        runId: 'r1',
        ts: 1,
        type: 'session.created',
        payload: {
          projectId: 'p1',
          projectPath: '/work',
          workspacePath: '/work',
          title: '',
          model: sessionModel,
        },
      },
    ])
  }
  const requests: { model: ModelRef; system?: string }[] = []
  const complete: CompleteFn = async (request) => {
    requests.push({
      model: request.model.ref,
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
    })
    if (options?.throwError) throw new Error('boom')
    if (options?.failResult) {
      return { ok: false, error: { code: 'model.failed' }, retryable: false }
    }
    return { ok: true, text: '  目标还在  ', usage: { inputTokens: 4, outputTokens: 3 } }
  }
  const onError = vi.fn()
  const service = createCompactService({
    events,
    settings: {
      get: () => ({
        locale: 'zh-CN',
        providers: [],
      }),
      hostModelConfig: (model) => (options?.configured === false ? undefined : configOf(model)),
      credentialRef: () => undefined,
    },
    credentials: { resolve: async () => undefined },
    complete,
    now: () => 50,
    onError,
  })
  return { events, requests, onError, service }
}

describe('compact service', () => {
  it('summarizes with the session model and records auxiliary usage', async () => {
    const { service, requests, events } = setup()
    await expect(service.summarize('s1', 'User:\nfix the login')).resolves.toBe('目标还在')
    expect(requests[0]).toMatchObject({ model: sessionModel, system: COMPACTION_SYSTEM_PROMPT })
    const usage = events.readAfter('s1', 0).find((event) => event.type === 'usage.reported')
    expect(usage).toMatchObject({
      runId: 'r1',
      payload: { auxiliary: true, usage: { inputTokens: 4, outputTokens: 3 } },
    })
  })

  it('skips quietly when the session model has no provider', async () => {
    const quiet = setup({ configured: false })
    await expect(quiet.service.summarize('s1', 'transcript')).resolves.toBeUndefined()
    expect(quiet.onError).not.toHaveBeenCalled()
    expect(quiet.requests).toHaveLength(0)
  })

  it('returns undefined when the model writes nothing', async () => {
    const { events, onError } = setup()
    const blank: CompleteFn = async () => ({
      ok: true,
      text: '   ',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const again = createCompactService({
      events,
      settings: {
        get: () => ({ locale: 'zh-CN', providers: [] }),
        hostModelConfig: (model) => configOf(model),
        credentialRef: () => undefined,
      },
      credentials: { resolve: async () => undefined },
      complete: blank,
      onError,
    })
    await expect(again.summarize('s1', 'transcript')).resolves.toBeUndefined()
    expect(events.readAfter('s1', 0).some((event) => event.type === 'usage.reported')).toBe(true)
  })

  it('skips an empty transcript and a session without a model', async () => {
    const { service } = setup()
    await expect(service.summarize('s1', '   ')).resolves.toBeUndefined()

    const none = setup({ skipEvents: true })
    await expect(none.service.summarize('s1', 'transcript')).resolves.toBeUndefined()
    expect(none.requests).toHaveLength(0)
  })

  it('reports failed and thrown completions', async () => {
    const failed = setup({ failResult: true })
    await expect(failed.service.summarize('s1', 'transcript')).resolves.toBeUndefined()
    expect(failed.onError.mock.calls[0]?.[0]).toMatchObject({ message: 'model.failed' })

    const thrown = setup({ throwError: true })
    await expect(thrown.service.summarize('s1', 'transcript')).resolves.toBeUndefined()
    expect(thrown.onError.mock.calls[0]?.[0]).toMatchObject({ message: 'boom' })
  })
})
