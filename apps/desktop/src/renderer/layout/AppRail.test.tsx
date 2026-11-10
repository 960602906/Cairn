// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { TooltipProvider } from '../ui/index.js'
import { AppRail } from './AppRail.js'

const i18n = createI18n('zh-CN')

function renderRail(
  options: {
    sessionsOpen?: boolean
    showSessions?: boolean
    activityActive?: boolean
    activityBadge?: number
    onSessions?: () => void
    onSearch?: () => void
    onActivity?: () => void
    onSettings?: () => void
  } = {},
) {
  const handlers = {
    onSessions: options.onSessions ?? vi.fn(),
    onSearch: options.onSearch ?? vi.fn(),
    onActivity: options.onActivity ?? vi.fn(),
    onSettings: options.onSettings ?? vi.fn(),
  }
  render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <AppRail
          {...handlers}
          sessionsOpen={options.sessionsOpen ?? true}
          showSessions={options.showSessions ?? true}
          activityActive={options.activityActive ?? false}
          activityBadge={options.activityBadge ?? 0}
        />
      </TooltipProvider>
    </I18nextProvider>,
  )
  return handlers
}

afterEach(cleanup)

describe('AppRail', () => {
  it('routes the three global entries', async () => {
    const user = userEvent.setup()
    const handlers = renderRail()
    for (const [name, handler] of [
      ['搜索', handlers.onSearch],
      ['活动', handlers.onActivity],
      ['设置', handlers.onSettings],
    ] as const) {
      await user.click(screen.getByRole('button', { name }))
      expect(handler).toHaveBeenCalledTimes(1)
    }
  })

  it('marks the active entry and caps the approval badge', () => {
    renderRail({ activityActive: true, activityBadge: 120 })
    const activity = screen.getByRole('button', { name: '活动，120 个待审批' })
    expect(activity.textContent).toContain('99+')
    expect(activity.getAttribute('aria-current')).toBe('page')
  })

  it('keeps the settings entry outside the window drag region', () => {
    renderRail()
    const settings = screen.getByRole('button', { name: '设置' })
    expect(settings.closest('.no-drag')).not.toBeNull()
  })

  it('offers an expand entry only while the session column is collapsed', async () => {
    const user = userEvent.setup()
    const handlers = renderRail({ sessionsOpen: false })
    const expand = screen.getByRole('button', { name: '展开侧栏' })
    await user.click(expand)
    expect(handlers.onSessions).toHaveBeenCalledTimes(1)

    cleanup()
    renderRail({ sessionsOpen: true })
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull()

    cleanup()
    renderRail({ sessionsOpen: false, showSessions: false })
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull()
  })
})
