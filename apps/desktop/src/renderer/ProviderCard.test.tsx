// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { Settings } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const capabilities = {
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

const provider = {
  id: 'deepseek',
  kind: 'openai' as const,
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  models: [
    { id: 'deepseek-v4.1-flash', displayName: 'V4.1 Flash', ...capabilities },
    { id: 'raw', ...capabilities },
  ],
}

function setup(settings: Partial<Settings>) {
  const request = vi.fn(async (method: string) => {
    if (method === 'settings.get') return { locale: 'zh-CN', providers: [], ...settings }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'project.list') return { projects: [] }
    return {}
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  render(<App i18n={createI18n('zh-CN')} store={createSessionStore(api)} />)
}

const card = () => screen.findByRole('button', { name: /^模型供应商/ })

describe('ProviderCard', () => {
  it('invites adding a provider when none is configured', async () => {
    setup({})
    expect((await card()).textContent).toContain('还没有配置模型，点这里添加')
  })

  it('shows the provider count and the default model', async () => {
    setup({
      providers: [provider],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-v4.1-flash' },
    })
    expect((await card()).textContent).toMatch(/模型供应商1.*默认模型：DeepSeek · V4.1 Flash/)
  })

  it('falls back to the model id or says no default is selected', async () => {
    setup({ providers: [provider], defaultModel: { providerId: 'deepseek', modelId: 'raw' } })
    expect((await card()).textContent).toContain('默认模型：DeepSeek · raw')
    cleanup()
    setup({ providers: [provider] })
    expect((await card()).textContent).toContain('还没有选择默认模型')
  })

  it('starts with the sidebar collapsed in a narrow window', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    setup({})
    expect(await screen.findByRole('button', { name: '展开侧栏' })).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()
  })
})
