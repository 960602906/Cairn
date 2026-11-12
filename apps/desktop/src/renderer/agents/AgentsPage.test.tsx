// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentSummary } from '@cairn/protocol'
import { agentStatus, filterAgents, AgentsPage } from './AgentsPage.js'
import { agentName } from './model.js'
import { SessionStoreContext } from '../store-context.js'
import { createSessionStore } from '../session-store.js'
import type { MainApi } from '../api.js'

const i18n = createI18n('zh-CN')

const mockAgents: AgentSummary[] = [
  {
    agentId: 'builtin.coder',
    source: 'builtin',
    version: 1,
    status: 'published',
    hasDraft: false,
    archived: false,
    name: { 'zh-CN': '编程助手', 'en-US': 'Coding Assistant' },
    description: { 'zh-CN': '编写代码', 'en-US': 'Code helper' },
    modelMode: 'inherit',
    updatedAt: 1000,
  },
  {
    agentId: 'user.reviewer',
    source: 'user',
    version: 2,
    status: 'published',
    hasDraft: true,
    archived: false,
    name: { 'zh-CN': '代码审查员' },
    description: { 'zh-CN': '审查代码规范' },
    modelMode: 'fixed',
    model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    updatedAt: 2000,
  },
  {
    agentId: 'user.draft_only',
    source: 'user',
    version: 0,
    status: 'draft',
    hasDraft: true,
    archived: false,
    name: { 'en-US': 'Draft Agent' },
    description: {},
    modelMode: 'inherit',
    updatedAt: 3000,
  },
  {
    agentId: 'user.archived',
    source: 'user',
    version: 1,
    status: 'published',
    hasDraft: false,
    archived: true,
    name: { 'zh-CN': '已归档' },
    description: {},
    modelMode: 'inherit',
    updatedAt: 4000,
  },
]

describe('AgentsPage utilities', () => {
  it('extracts agentName accurately with fallbacks', () => {
    expect(agentName(mockAgents[0]!, 'zh-CN')).toBe('编程助手')
    expect(agentName(mockAgents[0]!, 'en-US')).toBe('Coding Assistant')
    expect(agentName(mockAgents[1]!, 'en-US')).toBe('代码审查员')
    expect(agentName({ ...mockAgents[3]!, name: {} }, 'zh-CN')).toBe('user.archived')
  })

  it('determines agentStatus accurately', () => {
    expect(agentStatus(mockAgents[0]!)).toBe('published')
    expect(agentStatus(mockAgents[1]!)).toBe('dirty')
    expect(agentStatus(mockAgents[2]!)).toBe('draft')
    expect(agentStatus(mockAgents[3]!)).toBe('archived')
  })

  it('filters agents by category and text search', () => {
    // all (excludes archived)
    const all = filterAgents(mockAgents, 'all', '')
    expect(all.map((a) => a.agentId)).toEqual(['builtin.coder', 'user.reviewer', 'user.draft_only'])

    // builtin
    const builtin = filterAgents(mockAgents, 'builtin', '')
    expect(builtin.map((a) => a.agentId)).toEqual(['builtin.coder'])

    // user
    const user = filterAgents(mockAgents, 'user', '')
    expect(user.map((a) => a.agentId)).toEqual(['user.reviewer', 'user.draft_only'])

    // draft
    const drafts = filterAgents(mockAgents, 'draft', '')
    expect(drafts.map((a) => a.agentId)).toEqual(['user.draft_only'])

    // archived
    const archived = filterAgents(mockAgents, 'archived', '')
    expect(archived.map((a) => a.agentId)).toEqual(['user.archived'])

    // search by name / query
    const searchName = filterAgents(mockAgents, 'all', '审查')
    expect(searchName.map((a) => a.agentId)).toEqual(['user.reviewer'])

    const searchEn = filterAgents(mockAgents, 'all', 'coding')
    expect(searchEn.map((a) => a.agentId)).toEqual(['builtin.coder'])
  })
})

describe('AgentsPage component', () => {
  it('renders list of agents and handles actions', async () => {
    const onOpen = vi.fn()
    const onCreate = vi.fn()
    const fakeApi = {
      request: async (method: string) => {
        if (method === 'agent.list') return { agents: mockAgents }
        return undefined
      },
      on: () => () => {},
    }
    const store = createSessionStore(fakeApi as unknown as MainApi)
    await store.getState().refreshAgents()

    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <AgentsPage onOpen={onOpen} onCreate={onCreate} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )

    expect(screen.getByText('编程助手')).toBeDefined()
    expect(screen.getByText('代码审查员')).toBeDefined()

    // Click card opens editor
    fireEvent.click(screen.getByText('代码审查员'))
    expect(onOpen).toHaveBeenCalledWith('user.reviewer')

    // Search box
    const searchInput = screen.getByPlaceholderText(/搜索/i)
    fireEvent.change(searchInput, { target: { value: '代码审查' } })
    expect(screen.getByText('代码审查员')).toBeDefined()
    expect(screen.queryByText('编程助手')).toBeNull()

    // 搜索不到时提示没有匹配项。
    fireEvent.change(searchInput, { target: { value: '不存在的名字' } })
    expect(screen.getByText('没有匹配的 Agent')).toBeDefined()

    // 归档筛选单独显示已归档的 Agent。
    fireEvent.change(searchInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('radio', { name: '已归档' }))
    expect(screen.getAllByText('已归档').length).toBeGreaterThan(0)
    expect(screen.queryByText('编程助手')).toBeNull()
  })
})
