// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentSummary } from '@cairn/protocol'
import { AgentPicker, pickerAgents } from './AgentPicker.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const mockAgents: AgentSummary[] = [
  {
    agentId: 'builtin.coder',
    source: 'builtin',
    version: 1,
    status: 'published',
    hasDraft: false,
    archived: false,
    name: { 'zh-CN': '编程助手' },
    description: {},
    modelMode: 'inherit',
    updatedAt: 1000,
  },
  {
    agentId: 'user.custom1',
    source: 'user',
    version: 1,
    status: 'published',
    hasDraft: false,
    archived: false,
    name: { 'zh-CN': '自定义一号' },
    description: {},
    modelMode: 'inherit',
    updatedAt: 1000,
  },
  {
    agentId: 'user.draft',
    source: 'user',
    version: 0,
    status: 'draft',
    hasDraft: true,
    archived: false,
    name: { 'zh-CN': '草稿助手' },
    description: {},
    modelMode: 'inherit',
    updatedAt: 1000,
  },
  {
    agentId: 'user.archived',
    source: 'user',
    version: 1,
    status: 'published',
    hasDraft: false,
    archived: true,
    name: { 'zh-CN': '归档助手' },
    description: {},
    modelMode: 'inherit',
    updatedAt: 1000,
  },
]

describe('pickerAgents', () => {
  it('filters only published non-archived agents with version > 0', () => {
    const result = pickerAgents(mockAgents, [], '')
    expect(result.map((a) => a.agentId)).toEqual(['builtin.coder', 'user.custom1'])
  })

  it('orders recent agents first', () => {
    const result = pickerAgents(mockAgents, ['user.custom1'], '')
    expect(result.map((a) => a.agentId)).toEqual(['user.custom1', 'builtin.coder'])
  })

  it('searches by name', () => {
    const result = pickerAgents(mockAgents, [], '自定义')
    expect(result.map((a) => a.agentId)).toEqual(['user.custom1'])
  })
})

describe('AgentPicker component', () => {
  it('renders picker button and selects an agent', async () => {
    let selectedAgent: unknown = undefined
    const fakeApi = {
      request: async (method: string, params: unknown) => {
        if (method === 'agent.list') return { agents: mockAgents }
        if (method === 'session.setAgent') {
          selectedAgent = (params as { agent: unknown }).agent
          return {}
        }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)
    await store.getState().refreshAgents()

    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentPicker sessionId="session-1" agent={undefined} disabled={false} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )

    // Open dropdown
    const trigger = screen.getByRole('button', { name: /agent/i })
    fireEvent.click(trigger)

    expect(screen.getByRole('listbox')).toBeDefined()
    expect(screen.getByText('自定义一号')).toBeDefined()

    // Click on option
    fireEvent.click(screen.getByText('自定义一号'))
    expect(selectedAgent).toEqual({ id: 'user.custom1', version: 1 })
  })

  it('opens with Ctrl+. and closes with Escape or an outside click', async () => {
    const store = makeStore()
    await store.getState().refreshAgents()
    renderPicker(store)

    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('filters options and shows the empty state', async () => {
    const store = makeStore()
    await store.getState().refreshAgents()
    renderPicker(store)

    fireEvent.click(screen.getByRole('button', { name: /agent/i }))
    fireEvent.change(screen.getByPlaceholderText('搜索 Agent'), { target: { value: '不存在' } })
    expect(screen.getByText('没有可选的 Agent')).toBeDefined()
  })

  it('does not open when disabled and ignores the current agent', async () => {
    const setAgent = vi.fn()
    const store = makeStore({ 'session.setAgent': setAgent })
    await store.getState().refreshAgents()
    renderPicker(store, { agent: { id: 'user.custom1', version: 1 }, disabled: true })

    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(screen.queryByRole('listbox')).toBeNull()

    cleanup()
    renderPicker(store, { agent: { id: 'user.custom1', version: 1 } })
    fireEvent.click(screen.getByRole('button', { name: /agent/i }))
    fireEvent.click(screen.getByRole('option', { name: /自定义一号/ }))
    expect(setAgent).not.toHaveBeenCalled()
  })

  it('stays open for inside clicks and non-escape keys', async () => {
    const store = makeStore()
    await store.getState().refreshAgents()
    renderPicker(store)

    fireEvent.click(screen.getByRole('button', { name: /agent/i }))
    const listbox = screen.getByRole('listbox')
    fireEvent.mouseDown(listbox)
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('listbox')).toBeDefined()
  })
})

function makeStore(handlers: Record<string, (...args: never[]) => unknown> = {}) {
  const fakeApi = {
    request: async (method: string, params: unknown) => {
      const handler = handlers[method]
      if (handler) return handler(params as never)
      if (method === 'agent.list') return { agents: mockAgents }
      return undefined
    },
    on: () => () => {},
  }
  return createSessionStore(fakeApi as unknown as MainApi)
}

function renderPicker(
  store: ReturnType<typeof createSessionStore>,
  props: {
    agent?: { id: string; version: number }
    disabled?: boolean
  } = {},
) {
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <AgentPicker sessionId="session-1" agent={props.agent} disabled={props.disabled ?? false} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
}
