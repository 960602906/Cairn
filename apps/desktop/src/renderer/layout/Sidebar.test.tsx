// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from '../session-store.js'
import { SessionStoreProvider } from '../store-context.js'
import { Sidebar } from './Sidebar.js'

const i18n = createI18n('zh-CN')

function renderSidebar(open: boolean, overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onSearch: vi.fn(),
    onSelect: vi.fn(),
  }
  const store = createStore<Record<string, unknown>>(() => ({
    sessions: [],
    projects: [],
    activeSessionId: undefined,
    awaitingTurn: {},
    views: {},
    refreshSessions: vi.fn(async () => {}),
  })) as unknown as SessionStore
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>
        <Sidebar open={open} {...handlers} {...overrides} />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return {
    sidebar: screen.getByRole('complementary', { hidden: true }),
    handlers,
  }
}

afterEach(cleanup)

describe('Sidebar', () => {
  it('keeps the width and opacity transition while open', () => {
    const { sidebar } = renderSidebar(true)
    expect(sidebar.getAttribute('aria-hidden')).toBe('false')
    expect(sidebar.hasAttribute('inert')).toBe(false)
    expect(sidebar.className).toContain('transition-[width,opacity]')
    expect(sidebar.className).toContain('duration-200')
    expect(sidebar.style.width).toBe('252px')
    expect(sidebar.className).toContain('opacity-100')
  })

  it('collapses to zero width, hides from assistive tech, and is inert', () => {
    const { sidebar } = renderSidebar(false)
    expect(sidebar.getAttribute('aria-hidden')).toBe('true')
    expect(sidebar.hasAttribute('inert')).toBe(true)
    expect(sidebar.style.width).toBe('0px')
    expect(screen.queryByRole('separator')).toBeNull()
    expect(sidebar.className).toContain('opacity-0')
    expect(sidebar.className).toContain('pointer-events-none')
    expect(sidebar.lastElementChild?.className).toContain('-translate-x-3')
  })

  it('shows the app name, the session list and the search entry', () => {
    renderSidebar(true)
    expect(screen.getByText('Cairn')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '搜索对话' })).toBeTruthy()
    // 没有传入处理函数的入口不显示。
    expect(screen.queryByRole('button', { name: '新对话' })).toBeNull()
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
  })

  it('offers new chat, activity with a badge, and settings', () => {
    const onNewChat = vi.fn()
    const onActivity = vi.fn()
    const onSettings = vi.fn()
    renderSidebar(true, {
      onNewChat,
      onActivity,
      onSettings,
      activityBadge: 120,
      activityActive: true,
    })
    fireEvent.click(screen.getByRole('button', { name: '新对话' }))
    const activity = screen.getByRole('button', { name: '活动，120 个待审批' })
    expect(activity.getAttribute('aria-current')).toBe('page')
    expect(activity.textContent).toContain('99+')
    fireEvent.click(activity)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(onSettings).toHaveBeenCalledTimes(1)
  })

  it('shows a small badge count and no badge at zero', () => {
    renderSidebar(true, { onActivity: vi.fn(), activityBadge: 2 })
    expect(screen.getByRole('button', { name: '活动，2 个待审批' }).textContent).toContain('2')
    cleanup()
    renderSidebar(true, { onActivity: vi.fn() })
    expect(screen.getByRole('button', { name: '活动' })).toBeTruthy()
  })

  it('leaves room for the traffic lights on macOS', () => {
    vi.stubGlobal('cairn', { windowControls: { platform: 'darwin' } })
    try {
      renderSidebar(true)
      expect(screen.queryByText('Cairn')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('wires the collapse and search actions', () => {
    const { handlers } = renderSidebar(true)
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    fireEvent.click(screen.getByRole('button', { name: '搜索对话' }))
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
    expect(handlers.onSearch).toHaveBeenCalledTimes(1)
  })
})
