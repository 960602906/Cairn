// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import type { AgentSummary } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreProvider } from '../store-context.js'
import { availableAgents, AgentPicker, pickerAgents } from './AgentPicker.js'

afterEach(cleanup)

const agent = (agentId: string, name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId,
  name: { 'zh-CN': name, 'en-US': agentId },
  description: {},
  source: 'user',
  archived: false,
  status: 'published',
  version: 1,
  hasDraft: false,
  modelMode: 'inherit',
  updatedAt: 1,
  ...extra,
})

const coder = agent('builtin.coder', '编程助手', {
  source: 'builtin',
  description: { 'zh-CN': '默认的编程助手' },
})
const explorer = agent('builtin.explorer', '代码探索员', { source: 'builtin' })
const reviewer = agent('builtin.reviewer', '代码审查员', {
  source: 'builtin',
  version: 3,
  description: { 'zh-CN': '审查改动的正确性' },
})
const custom = agent('user.custom', '前端审查员', {
  version: 2,
  description: { 'zh-CN': '检查界面实现' },
})
const draft = agent('user.draft', '草稿', { status: 'draft', version: 0 })
const archived = agent('user.archived', '旧助手', { archived: true })

describe('pickerAgents', () => {
  it('keeps only published, unarchived agents with a version', () => {
    expect(availableAgents([coder, draft, archived]).map((item) => item.agentId)).toEqual([
      'builtin.coder',
    ])
    expect(pickerAgents([coder, draft, archived], [], '')).toEqual([coder])
  })

  it('puts built-in agents first, then custom ones, and recently used first within a group', () => {
    const agents = [custom, coder, explorer, reviewer]
    expect(pickerAgents(agents, [], '').map((item) => item.agentId)).toEqual([
      'builtin.coder',
      'builtin.explorer',
      'builtin.reviewer',
      'user.custom',
    ])
    expect(
      pickerAgents(agents, ['builtin.reviewer', 'user.custom', 'builtin.coder'], '').map(
        (item) => item.agentId,
      ),
    ).toEqual(['builtin.reviewer', 'builtin.coder', 'builtin.explorer', 'user.custom'])
    // 用过的自定义 Agent 仍排在内置之后。
    expect(pickerAgents(agents, ['user.custom'], '').map((item) => item.agentId)).toEqual([
      'builtin.coder',
      'builtin.explorer',
      'builtin.reviewer',
      'user.custom',
    ])
    // 最近列表里不存在的 id 不影响其余顺序。
    expect(pickerAgents(agents, ['gone'], '').map((item) => item.agentId)).toEqual([
      'builtin.coder',
      'builtin.explorer',
      'builtin.reviewer',
      'user.custom',
    ])
  })

  it('searches both languages, the description and the id', () => {
    const zh = agent('user.zh', '前端审查', { description: { 'zh-CN': '检查界面实现' } })
    const en = agent('user.en', 'Backend', { description: { 'en-US': 'Reviews the API' } })
    const agents = [coder, zh, en]
    const ids = (query: string) => pickerAgents(agents, [], query).map((item) => item.agentId)
    expect(ids('  审查 ')).toEqual(['user.zh'])
    expect(ids('reviews')).toEqual(['user.en'])
    expect(ids('builtin.coder')).toEqual(['builtin.coder'])
    expect(ids('nothing')).toEqual([])
  })
})

function setup({
  agents = [coder, explorer, reviewer, draft, archived],
  recent = [] as string[],
  // `null` 表示会话还没有运行（主进程 Default 是内置编程助手）。
  current = { id: 'builtin.coder', version: 1 } as { id: string; version: number } | null,
  disabled = false,
  onManage = undefined as (() => void) | undefined,
  onSelect = undefined as ((agent: AgentSummary) => void) | undefined,
} = {}) {
  const request = vi.fn(async (method: string) => {
    if (method === 'session.setAgent') return {}
    return {}
  })
  const api = {
    ready: () => Promise.resolve(),
    request,
    on: () => () => undefined,
  } as unknown as MainApi
  const store = createSessionStore(api)
  store.setState({ agents, recentAgents: recent })
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreProvider store={store}>
        <AgentPicker
          sessionId="s1"
          agent={current ?? undefined}
          disabled={disabled}
          onManage={onManage}
          onSelect={onSelect}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  const trigger = () => screen.getByRole('button', { name: /^切换 Agent：/ })
  return { request, store, trigger }
}

const listbox = () => screen.getByRole('listbox', { name: '选择 Agent' })
const options = () => within(listbox()).getAllByRole('option')

describe('AgentPicker', () => {
  it('labels the current agent and falls back to the default or the raw id', () => {
    setup()
    expect(screen.getByRole('button', { name: '切换 Agent：编程助手' })).toBeTruthy()
    cleanup()
    // 还没有运行时按主进程默认的内置编程助手显示，并标为当前项。
    setup({ current: null })
    expect(screen.getByRole('button', { name: '切换 Agent：编程助手' })).toBeTruthy()
    cleanup()
    setup({ current: { id: 'user.gone', version: 1 } })
    expect(screen.getByRole('button', { name: '切换 Agent：user.gone' })).toBeTruthy()
  })

  it('marks the default agent as current before the first run', async () => {
    const { trigger } = setup({ current: null })
    await userEvent.click(trigger())
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('lists only usable agents, marking the current one', async () => {
    const { trigger } = setup()
    await userEvent.click(trigger())
    expect(options().map((item) => item.textContent)).toEqual([
      expect.stringContaining('编程助手'),
      expect.stringContaining('代码探索员'),
      expect.stringContaining('代码审查员'),
    ])
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(options()[2]!.getAttribute('aria-selected')).toBe('false')
    // 有描述时显示描述；没有描述时退回版本号，行高保持一致。
    expect(within(listbox()).getByText('默认的编程助手')).toBeTruthy()
    expect(within(listbox()).getByText('审查改动的正确性')).toBeTruthy()
    expect(within(listbox()).getByText('v1')).toBeTruthy()
  })

  it('switches the session agent and records it as recently used', async () => {
    const { request, store, trigger } = setup()
    await userEvent.click(trigger())
    await userEvent.click(within(listbox()).getByText('代码审查员'))
    expect(request).toHaveBeenCalledWith('session.setAgent', {
      sessionId: 's1',
      agent: { id: 'builtin.reviewer', version: 3 },
    })
    await waitFor(() => expect(store.getState().recentAgents).toEqual(['builtin.reviewer']))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('does nothing when the current agent is chosen again', async () => {
    const { request, trigger } = setup()
    await userEvent.click(trigger())
    await userEvent.click(within(listbox()).getByText('编程助手'))
    expect(request).not.toHaveBeenCalledWith('session.setAgent', expect.anything())
  })

  it('filters by search and shows the empty state', async () => {
    const { trigger } = setup()
    await userEvent.click(trigger())
    const search = screen.getByRole('combobox', { name: '搜索 Agent' })
    expect(document.activeElement).toBe(search)
    await userEvent.type(search, '审查')
    expect(options().map((item) => item.textContent)).toEqual([
      expect.stringContaining('代码审查员'),
    ])
    await userEvent.clear(search)
    await userEvent.type(search, 'zzz')
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.getByText('没有可选的 Agent')).toBeTruthy()
  })

  it('navigates with the arrow keys and picks with Enter', async () => {
    const { request, trigger } = setup()
    await userEvent.click(trigger())
    const search = screen.getByRole('combobox', { name: '搜索 Agent' })
    await userEvent.type(search, '{ArrowDown}{Enter}')
    expect(request).toHaveBeenCalledWith('session.setAgent', {
      sessionId: 's1',
      agent: { id: 'builtin.explorer', version: 1 },
    })
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const { trigger } = setup()
    await userEvent.click(trigger())
    await userEvent.type(screen.getByRole('combobox', { name: '搜索 Agent' }), '{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes when clicking outside', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /^切换 Agent：/ }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens with Ctrl+. and does not open while running', async () => {
    setup()
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '选择 Agent' })).toBeTruthy()
    cleanup()

    const { trigger } = setup({ disabled: true })
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    expect(trigger().getAttribute('title')).toBe('运行结束后可切换')
    fireEvent.keyDown(window, { key: '.', ctrlKey: true, metaKey: false })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps an archived current agent visible but not selectable', async () => {
    const { request, trigger } = setup({
      agents: [coder, archived],
      current: { id: 'user.archived', version: 1 },
    })
    expect(screen.getByRole('button', { name: '切换 Agent：旧助手' })).toBeTruthy()
    await userEvent.click(trigger())
    const row = within(listbox()).getByRole('option', { name: /旧助手/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(within(row).getByText('已归档')).toBeTruthy()
    await userEvent.click(row)
    expect(request).not.toHaveBeenCalledWith('session.setAgent', expect.anything())
  })

  it('hands the choice to the caller in new-session mode', async () => {
    const onSelect = vi.fn()
    const { request, trigger } = setup({ onSelect })
    await userEvent.click(trigger())
    await userEvent.click(within(listbox()).getByText('代码审查员'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'builtin.reviewer' }))
    expect(request).not.toHaveBeenCalledWith('session.setAgent', expect.anything())
  })

  it('opens Manage agents from the menu footer', async () => {
    const onManage = vi.fn()
    const { trigger } = setup({ onManage })
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('button', { name: '管理 Agents' }))
    expect(onManage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
