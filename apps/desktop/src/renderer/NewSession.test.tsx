// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'
import { greetingPeriod } from './NewSession.js'

afterEach(cleanup)

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

const providers = [
  {
    id: 'fake',
    kind: 'openai',
    displayName: '测试供应商',
    baseUrl: 'https://example.com',
    models: [
      { id: 'fast', displayName: '快', ...capabilities },
      { id: 'strong', displayName: '强', ...capabilities },
    ],
  },
]

function setup(settings: object = {}) {
  let current = {
    locale: 'zh-CN',
    providers,
    defaultModel: { providerId: 'fake', modelId: 'fast' },
    permissionMode: 'ask',
    ...settings,
  }
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'settings.get') {
      return current
    }
    if (method === 'settings.update') {
      current = { ...current, ...(params as object) }
      return current
    }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'project.list') {
      return {
        projects: [{ projectId: 'p1', name: 'work', path: '/work', createdAt: 1 }],
      }
    }
    if (method === 'session.create') return { sessionId: 's1' }
    if (method === 'session.subscribe') return { events: [], lastSeq: 0 }
    return {}
  })
  const api = { ready: () => Promise.resolve(), request, on: () => () => {} } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n('zh-CN')} store={store} />)
  return { request }
}

describe('greetingPeriod', () => {
  it('maps the local hour to the greeting of the day', () => {
    expect([4, 23, 0].map(greetingPeriod)).toEqual(['night', 'night', 'night'])
    expect([5, 11].map(greetingPeriod)).toEqual(['morning', 'morning'])
    expect([12, 13].map(greetingPeriod)).toEqual(['noon', 'noon'])
    expect([14, 17].map(greetingPeriod)).toEqual(['afternoon', 'afternoon'])
    expect([18, 22].map(greetingPeriod)).toEqual(['evening', 'evening'])
  })
})

describe('NewSession controls', () => {
  it('creates the session, switches the model, then sends the first prompt in plan mode', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    expect(await screen.findByRole('button', { name: '模型：测试供应商 · 快' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '模型：测试供应商 · 快' }))
    await user.click(await screen.findByRole('menuitem', { name: /强/ }))
    await user.click(screen.getByRole('button', { name: '计划模式' }))
    expect(input.getAttribute('placeholder')).toBe('描述要做的事。这一轮只会阅读项目并提出计划')
    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '做点事' }],
        mode: 'plan',
      }),
    )
    const calls = request.mock.calls
      .map(([method]) => method)
      .filter((method) =>
        ['session.create', 'session.setModel', 'session.prompt'].includes(method as string),
      )
    expect(calls).toEqual(['session.create', 'session.setModel', 'session.prompt'])
    expect(request).toHaveBeenCalledWith('session.setModel', {
      sessionId: 's1',
      model: { providerId: 'fake', modelId: 'strong' },
    })
  })

  it('keeps the default model when it is already selected and switches the permission mode', async () => {
    const { request } = setup()
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.click(screen.getByRole('button', { name: '权限模式：询问' }))
    await user.click(await screen.findByRole('menuitem', { name: /只读/ }))
    expect(request).toHaveBeenCalledWith('settings.update', { permissionMode: 'read-only' })

    await user.type(input, '做点事')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session.prompt', {
        sessionId: 's1',
        content: [{ type: 'text', text: '做点事' }],
      }),
    )
    expect(request).not.toHaveBeenCalledWith('session.setModel', expect.anything())
  })

  it('disables sending when no enabled model is available', async () => {
    setup({
      providers: [
        {
          ...providers[0],
          models: providers[0]!.models.map((model) => ({ ...model, enabled: false })),
        },
      ],
    })
    const user = userEvent.setup()
    const input = await screen.findByPlaceholderText('有什么可以帮你？')
    await user.type(input, '做点事')
    const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })
})
