// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentEffectiveConfig as AgentEffectiveConfigType } from '@cairn/protocol'
import { AgentEffectiveConfig } from './AgentEffectiveConfig.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

function renderConfig(result: unknown, sessionId?: string) {
  const fakeApi = {
    request: async (method: string) => {
      if (method === 'agent.effectiveConfig') return result
      return undefined
    },
    on: () => () => {},
  }
  const store = createSessionStore(fakeApi as unknown as MainApi)
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <AgentEffectiveConfig agentId="agent.1" {...(sessionId ? { sessionId } : {})} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
}

describe('AgentEffectiveConfig component', () => {
  it('loads and renders effective configuration and context budget', async () => {
    const mockConfig: AgentEffectiveConfigType = {
      agentId: 'agent.1',
      source: 'published',
      version: 1,
      systemPrompt: 'You are a helpful assistant.',
      tools: [
        { name: 'read_file', description: '', category: 'read', source: { kind: 'builtin' } },
        { name: 'write_file', description: '', category: 'write', source: { kind: 'builtin' } },
      ],
      skills: [
        {
          name: 'tdd',
          description: '',
          pinned: false,
          tokens: { index: 10, pinned: 0 },
        },
      ],
      permissionRules: [],
      budget: {
        contextWindow: 128000,
        reserveOutputTokens: 2000,
        systemPromptTokens: 500,
        toolsTokens: 400,
        skillsTokens: 200,
        historyTokens: 0,
      },
    }

    const fakeApi = {
      request: async (method: string) => {
        if (method === 'agent.effectiveConfig') return mockConfig
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)

    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentEffectiveConfig agentId="agent.1" />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/You are a helpful assistant/i)).toBeDefined()
      expect(screen.getByText('read_file')).toBeDefined()
      expect(screen.getByText('tdd')).toBeDefined()
    })
  })
})

describe('AgentEffectiveConfig branches', () => {
  it('shows a failure message when the config cannot be loaded', async () => {
    renderConfig(undefined)
    expect(await screen.findByText('无法读取生效配置。')).toBeDefined()
  })

  it('renders draft source, empty lists, permission effects and a full budget', async () => {
    renderConfig(
      {
        agentId: 'agent.1',
        source: 'draft',
        version: 0,
        systemPrompt: 'draft prompt',
        tools: [],
        skills: [],
        permissionRules: [
          { effect: 'allow', match: { tool: 'read_file' } },
          { effect: 'deny', match: { tool: 'exec' } },
          { effect: 'ask', match: { tool: 'write_file' } },
        ],
        budget: {
          contextWindow: 100,
          reserveOutputTokens: 50,
          systemPromptTokens: 80,
          toolsTokens: 0,
          skillsTokens: 0,
          historyTokens: 0,
        },
      },
      'session-1',
    )
    expect(await screen.findByText('draft prompt')).toBeDefined()
    expect(screen.getByText('草稿')).toBeDefined()
    expect(screen.getAllByText('没有').length).toBe(2)
    expect(screen.getByText('allow')).toBeDefined()
    expect(screen.getByText('deny')).toBeDefined()
    expect(screen.getByText('ask')).toBeDefined()
    // 超出预算时剩余为 0，条形图按已用总量归一
    expect(screen.getByText(/剩余/).textContent).toContain('0')
  })
})
