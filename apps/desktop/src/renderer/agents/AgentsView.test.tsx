// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentDetail, AgentSummary } from '@cairn/protocol'
import { AgentsView } from './AgentsView.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

afterEach(cleanup)

const i18n = createI18n('zh-CN')

const builtin: AgentSummary = {
  agentId: 'builtin.coder',
  source: 'builtin',
  version: 1,
  status: 'published',
  hasDraft: false,
  archived: false,
  name: { 'zh-CN': '编程助手' },
  description: { 'zh-CN': '写代码' },
  modelMode: 'inherit',
  updatedAt: 1000,
}

const copiedDetail: AgentDetail = {
  agentId: 'user.copied',
  source: 'user',
  archived: false,
  validation: { ok: true, errors: [], warnings: [] },
  draft: {
    id: 'user.copied',
    name: { 'zh-CN': '复制的助手' },
    description: { 'zh-CN': '描述' },
    instructions: 'Do work.',
    model: { mode: 'inherit' },
    tools: { allow: ['*'] },
    skills: { allow: ['*'] },
    permissions: 'ask',
    limits: {},
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: ['session'], write: 'never' },
  },
}

const builtinDetail: AgentDetail = {
  ...copiedDetail,
  agentId: 'builtin.coder',
  source: 'builtin',
}

function makeStore(agents: AgentSummary[]) {
  const fakeApi = {
    request: async (method: string, params: unknown) => {
      if (method === 'agent.list') return { agents }
      if (method === 'agent.duplicate') return copiedDetail
      if (method === 'agent.get') {
        const { agentId } = params as { agentId: string }
        return agentId === 'builtin.coder' ? builtinDetail : copiedDetail
      }
      return undefined
    },
    on: () => () => {},
  }
  return createSessionStore(fakeApi as unknown as MainApi)
}

function renderView(store: ReturnType<typeof createSessionStore>) {
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <AgentsView />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
}

describe('AgentsView', () => {
  it('lists agents and opens the editor for a row', async () => {
    const store = makeStore([builtin])
    renderView(store)
    fireEvent.click(await screen.findByText('编程助手'))
    expect(await screen.findByText(/内置 Agent 只读/)).toBeDefined()
  })

  it('creates a blank agent draft', async () => {
    const store = makeStore([])
    renderView(store)
    fireEvent.click(await screen.findByRole('button', { name: '新建 Agent' }))
    expect(await screen.findByText('未命名 Agent')).toBeDefined()
  })

  it('copies the builtin agent and opens the copy', async () => {
    const store = makeStore([builtin])
    renderView(store)
    fireEvent.click(await screen.findByRole('button', { name: '基于编程助手复制' }))
    await waitFor(() => expect(screen.getByText('复制的助手')).toBeDefined())
  })

  it('returns to the list from the editor', async () => {
    const store = makeStore([builtin])
    renderView(store)
    fireEvent.click(await screen.findByText('编程助手'))
    await screen.findByText(/内置 Agent 只读/)
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Agents' })).toBeDefined())
  })

  it('shows the empty state and creates from it', async () => {
    const store = makeStore([])
    renderView(store)
    fireEvent.click(await screen.findByRole('button', { name: '基于编程助手创建' }))
    await waitFor(() => expect(screen.getByText('复制的助手')).toBeDefined())
  })

  it('falls back to a blank draft when copying fails', async () => {
    const fakeApi = {
      request: async (method: string) => {
        if (method === 'agent.list') return { agents: [builtin] }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)
    renderView(store)
    fireEvent.click(await screen.findByRole('button', { name: '基于编程助手复制' }))
    await waitFor(() => expect(screen.getByText('未命名 Agent')).toBeDefined())
  })

  it('renders the leading slot', async () => {
    const store = makeStore([])
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentsView leading={<span>标题栏</span>} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('标题栏')).toBeDefined()
  })
})
