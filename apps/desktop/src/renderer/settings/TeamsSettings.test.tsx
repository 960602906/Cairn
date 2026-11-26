// @vitest-environment jsdom
import { BUILTIN_CODER, BUILTIN_EXPLORER } from '@cairn/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AgentDetail, AgentSummary, AgentTeamDetail, AgentTeamSummary } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { TeamsSettings } from './TeamsSettings.js'

const i18n = createI18n('zh-CN')

afterEach(cleanup)

const agent: AgentSummary = {
  agentId: BUILTIN_CODER.id,
  name: BUILTIN_CODER.name,
  description: BUILTIN_CODER.description,
  source: 'builtin',
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
}

const detail: AgentDetail = {
  agentId: BUILTIN_CODER.id,
  source: 'builtin',
  archived: false,
  published: BUILTIN_CODER,
  validation: { ok: true, errors: [], warnings: [] },
}

const teamSummary: AgentTeamSummary = {
  teamId: 'user.team-1',
  name: { 'zh-CN': '现有团队' },
  description: {},
  pattern: 'delegate',
  coordinator: BUILTIN_CODER.id,
  memberCount: 1,
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  updatedAt: 1,
}

const teamDetail: AgentTeamDetail = {
  teamId: 'user.team-1',
  archived: false,
  published: {
    id: 'user.team-1',
    version: 1,
    name: { 'zh-CN': '现有团队' },
    description: { 'zh-CN': '说明' },
    coordinator: BUILTIN_CODER.id,
    members: [BUILTIN_EXPLORER.id],
    pattern: 'delegate',
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
  },
  validation: { ok: true, errors: [], warnings: [] },
}

function setup(
  options: {
    readonly teams?: readonly AgentTeamSummary[]
    readonly teamDetail?: AgentTeamDetail
  } = {},
) {
  const calls: { method: string; params: unknown }[] = []
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'agent.list') return { agents: [agent] }
      if (method === 'agent.get') return detail
      if (method === 'team.list') return { teams: options.teams ?? [] }
      if (method === 'team.get') return options.teamDetail ?? {}
      return {}
    },
    on: () => () => {},
  }
  return { store: createSessionStore(api as unknown as MainApi), calls }
}

describe('TeamsSettings', () => {
  it('shows the list and opens a new team editor', async () => {
    const { store, calls } = setup()
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <TeamsSettings />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    await waitFor(() => expect(screen.getByText(/还没有团队模板/)).toBeDefined())
    expect(screen.getByRole('heading', { name: '团队模板' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '新建团队' }))
    await waitFor(() => expect(screen.getByLabelText('中文名称')).toBeDefined())
    // 新建前先刷新一次 Agent 列表，默认引用内置编程助手。
    expect(calls.some((call) => call.method === 'agent.list')).toBe(true)
    expect((screen.getByLabelText('主控 Agent') as HTMLSelectElement).value).toBe(BUILTIN_CODER.id)

    fireEvent.click(screen.getByRole('button', { name: '返回团队列表' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '新建团队' })).toBeDefined())
  })

  it('opens an existing team in the editor', async () => {
    const { store, calls } = setup({ teams: [teamSummary], teamDetail })
    render(
      <I18nextProvider i18n={i18n}>
        <SessionStoreContext.Provider value={store}>
          <TeamsSettings />
        </SessionStoreContext.Provider>
      </I18nextProvider>,
    )
    await waitFor(() => expect(screen.getByText('现有团队')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /现有团队/ }))
    await waitFor(() => expect(screen.getByLabelText('中文名称')).toBeDefined())
    expect((screen.getByLabelText('中文名称') as HTMLInputElement).value).toBe('现有团队')
    expect(calls).toContainEqual({ method: 'team.get', params: { teamId: 'user.team-1' } })
  })
})
