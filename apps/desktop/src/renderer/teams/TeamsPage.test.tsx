// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentSummary, AgentTeamSummary } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { filterTeams, TeamsPage } from './TeamsPage.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const agent = (
  agentId: string,
  name: string,
  overrides: Partial<AgentSummary> = {},
): AgentSummary => ({
  agentId,
  name: { 'zh-CN': name },
  description: {},
  source: 'builtin',
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
  ...overrides,
})

const agents = [
  agent('builtin.coder', '编程助手'),
  agent('builtin.explorer', '探索员'),
  agent('builtin.reviewer', '审查员'),
]

const team = (overrides: Partial<AgentTeamSummary> = {}): AgentTeamSummary => ({
  teamId: 'user.team-1',
  name: { 'zh-CN': '日常协作' },
  description: { 'zh-CN': '主控分派给探索员' },
  pattern: 'delegate',
  coordinator: 'builtin.coder',
  memberCount: 2,
  archived: false,
  status: 'published',
  version: 3,
  hasDraft: false,
  updatedAt: 1,
  ...overrides,
})

describe('filterTeams', () => {
  const teams = [
    team(),
    team({
      teamId: 'user.team-2',
      name: { 'en-US': 'Review pair' },
      description: { 'en-US': 'maker and checker' },
      pattern: 'review-loop',
      status: 'draft',
      version: 0,
      hasDraft: false,
    }),
    team({
      teamId: 'user.team-3',
      name: { 'zh-CN': '流水线小组' },
      description: { 'zh-CN': '按阶段执行' },
      pattern: 'pipeline',
      hasDraft: true,
    }),
    team({
      teamId: 'user.team-4',
      name: { 'zh-CN': '归档小组' },
      description: { 'zh-CN': '已归档的模板' },
      archived: true,
    }),
  ]

  it('filters by status and searches both languages', () => {
    expect(filterTeams(teams, 'all', '').map((item) => item.teamId)).toEqual([
      'user.team-1',
      'user.team-2',
      'user.team-3',
    ])
    expect(filterTeams(teams, 'draft', '').map((item) => item.teamId)).toEqual(['user.team-2'])
    expect(filterTeams(teams, 'published', '').map((item) => item.teamId)).toEqual([
      'user.team-1',
      'user.team-3',
    ])
    expect(filterTeams(teams, 'all', 'review').map((item) => item.teamId)).toEqual(['user.team-2'])
    expect(filterTeams(teams, 'all', '协作').map((item) => item.teamId)).toEqual(['user.team-1'])
    expect(filterTeams(teams, 'all', 'team-3').map((item) => item.teamId)).toEqual(['user.team-3'])
    // 归档的模板只出现在「已归档」筛选里。
    expect(filterTeams(teams, 'all', '').map((item) => item.teamId)).not.toContain('user.team-4')
    expect(filterTeams(teams, 'archived', '').map((item) => item.teamId)).toEqual(['user.team-4'])
    expect(filterTeams(teams, 'all', '归档小组')).toEqual([])
    expect(filterTeams(teams, 'published', '')).not.toContain('user.team-4')
    expect(filterTeams(teams, 'all', 'missing')).toEqual([])
  })
})

function setup(teams: readonly AgentTeamSummary[] = [team()]) {
  const api = {
    request: async (method: string) => {
      if (method === 'agent.list') return { agents }
      if (method === 'team.list') return { teams }
      return {}
    },
    on: () => () => {},
  }
  return createSessionStore(api as unknown as MainApi)
}

function renderPage(teams?: readonly AgentTeamSummary[]) {
  const store = setup(teams)
  const onOpen = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreContext.Provider value={store}>
        <TeamsPage onOpen={onOpen} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { onOpen, store }
}

describe('TeamsPage', () => {
  it('lists teams with pattern, status, coordinator and member count', async () => {
    const { onOpen } = renderPage()
    await waitFor(() => expect(screen.getByText('日常协作')).toBeDefined())
    const row = screen.getByRole('button', { name: /日常协作/ })
    expect(within(row).getByText('v3')).toBeDefined()
    expect(within(row).getByText('自由委派')).toBeDefined()
    expect(within(row).getByText('已发布')).toBeDefined()
    expect(within(row).getByText('主控分派给探索员')).toBeDefined()
    expect(within(row).getByText('主控 编程助手 · 2 名成员')).toBeDefined()

    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith('user.team-1')
  })

  it('filters by search and status, and shows empty states', async () => {
    renderPage([
      team(),
      team({
        teamId: 'user.team-2',
        name: { 'zh-CN': '审查小组' },
        pattern: 'review-loop',
        status: 'draft',
        version: 0,
      }),
    ])
    await waitFor(() => expect(screen.getByText('日常协作')).toBeDefined())

    fireEvent.change(screen.getByPlaceholderText('搜索团队名称或描述'), {
      target: { value: '审查' },
    })
    expect(screen.getByText('审查小组')).toBeDefined()
    expect(screen.queryByText('日常协作')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('搜索团队名称或描述'), {
      target: { value: '没有这个' },
    })
    expect(screen.getByText('没有匹配的团队模板。')).toBeDefined()

    fireEvent.change(screen.getByPlaceholderText('搜索团队名称或描述'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('radio', { name: '草稿' }))
    expect(screen.getByText('审查小组')).toBeDefined()
    expect(screen.queryByText('日常协作')).toBeNull()
  })

  it('shows the empty hint when there are no teams', async () => {
    renderPage([])
    await waitFor(() => expect(screen.getByText(/还没有团队模板/)).toBeDefined())
  })

  it('shows a team whose coordinator is no longer in the agent list by id', async () => {
    renderPage([team({ coordinator: 'user.gone' })])
    await waitFor(() => expect(screen.getByText('主控 user.gone · 2 名成员')).toBeDefined())
  })

  it('marks a team with unpublished changes', async () => {
    renderPage([team({ hasDraft: true })])
    await waitFor(() => expect(screen.getByText('日常协作')).toBeDefined())
    const row = screen.getByRole('button', { name: /日常协作/ })
    expect(within(row).getByText('有未发布修改')).toBeDefined()
  })

  it('shows archived teams only under the archived filter', async () => {
    renderPage([
      team(),
      team({ teamId: 'user.team-9', name: { 'zh-CN': '归档小组' }, archived: true }),
    ])
    await waitFor(() => expect(screen.getByText('日常协作')).toBeDefined())
    expect(screen.queryByText('归档小组')).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: '已归档' }))
    expect(screen.getByText('归档小组')).toBeDefined()
    expect(screen.queryByText('日常协作')).toBeNull()
    expect(
      within(screen.getByRole('button', { name: /归档小组/ })).getByText('已归档'),
    ).toBeDefined()
  })

  it('falls back to an empty list when listing fails', async () => {
    const api = {
      request: async (method: string) => {
        if (method === 'agent.list') return { agents }
        if (method === 'team.list') return {}
        return {}
      },
      on: () => () => {},
    }
    const store = createSessionStore(api as unknown as MainApi)
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <TeamsPage onOpen={vi.fn()} />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    await waitFor(() => expect(screen.getByText(/还没有团队模板/)).toBeDefined())
  })
})
