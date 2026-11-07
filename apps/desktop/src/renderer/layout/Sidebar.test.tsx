// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { createStore } from 'zustand/vanilla'
import type { SessionStore } from '../session-store.js'
import { SessionStoreProvider } from '../store-context.js'
import { Sidebar } from './Sidebar.js'

const i18n = createI18n('zh-CN')

function renderSidebar(open: boolean) {
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
        <Sidebar
          open={open}
          onNewChat={vi.fn()}
          onCollapse={vi.fn()}
          onSearch={vi.fn()}
          onSelect={vi.fn()}
          onSettings={vi.fn()}
        />
      </SessionStoreProvider>
    </I18nextProvider>,
  )
  return screen.getByRole('complementary', { hidden: true })
}

afterEach(cleanup)

describe('Sidebar', () => {
  it('keeps the width and opacity transition while open', () => {
    const sidebar = renderSidebar(true)
    expect(sidebar.getAttribute('aria-hidden')).toBe('false')
    expect(sidebar.hasAttribute('inert')).toBe(false)
    expect(sidebar.className).toContain('transition-[width,opacity]')
    expect(sidebar.className).toContain('duration-200')
    expect(sidebar.className).toContain('w-[252px]')
    expect(sidebar.className).toContain('opacity-100')
  })

  it('collapses to zero width, hides from assistive tech, and is inert', () => {
    const sidebar = renderSidebar(false)
    expect(sidebar.getAttribute('aria-hidden')).toBe('true')
    expect(sidebar.hasAttribute('inert')).toBe(true)
    expect(sidebar.className).toContain('w-0')
    expect(sidebar.className).toContain('opacity-0')
    expect(sidebar.className).toContain('pointer-events-none')
    expect(sidebar.firstElementChild?.className).toContain('-translate-x-3')
  })
})
