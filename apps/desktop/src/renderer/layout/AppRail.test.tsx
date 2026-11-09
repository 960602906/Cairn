// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { TooltipProvider } from '../ui/index.js'
import { AppRail } from './AppRail.js'

const i18n = createI18n('zh-CN')

function renderRail(options: {
  sessionsActive?: boolean
  activityActive?: boolean
  activityBadge?: number
  onSessions?: () => void
  onSearch?: () => void
  onActivity?: () => void
  onSettings?: () => void
} = {}) {
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
          sessionsActive={options.sessionsActive ?? false}
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
  it('routes the four global entries', async () => {
    const user = userEvent.setup()
    const handlers = renderRail()
    for (const [name, handler] of [
      ['会话', handlers.onSessions],
      ['搜索', handlers.onSearch],
      ['活动', handlers.onActivity],
      ['设置', handlers.onSettings],
    ] as const) {
      await user.click(screen.getByRole('button', { name }))
      expect(handler).toHaveBeenCalledTimes(1)
    }
  })

  it('marks the active entry and caps the approval badge', () => {
    renderRail({ sessionsActive: true, activityBadge: 120 })
    expect(screen.getByRole('button', { name: '会话' }).getAttribute('aria-current')).toBe('page')
    const activity = screen.getByRole('button', { name: '活动，120 个待审批' })
    expect(activity.textContent).toContain('99+')
  })
})
