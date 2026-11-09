// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { AppLicenses } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { LicensesDialog } from './LicensesDialog.js'

afterEach(cleanup)

function setup(
  value: AppLicenses | (() => Promise<AppLicenses | undefined>),
  open = true,
): {
  readonly request: ReturnType<typeof vi.fn>
  readonly onOpenChange: ReturnType<typeof vi.fn>
} {
  const request = vi.fn(async (method: string) => {
    if (method !== 'app.licenses') return {}
    return typeof value === 'function' ? value() : value
  })
  const store = createSessionStore({
    ready: async () => {},
    request,
    on: () => () => {},
  } as unknown as MainApi)
  const onOpenChange = vi.fn()
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <LicensesDialog open={open} onOpenChange={onOpenChange} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { request, onOpenChange }
}

describe('LicensesDialog', () => {
  it('shows the bundled notices and can copy them', async () => {
    const { request } = setup({ available: true, text: 'MIT — demo\n', truncated: false })
    expect(await screen.findByText(/MIT — demo/)).toBeDefined()
    expect(request).toHaveBeenCalledWith('app.licenses', {})
    expect(screen.getByRole('button', { name: '复制' })).toBeDefined()
  })

  it('explains when the build has no notices file', async () => {
    setup({ available: false, text: '', truncated: false })
    expect(await screen.findByText('这次构建没有包含第三方许可声明文件。')).toBeDefined()
  })

  it('mentions truncated notices', async () => {
    setup({ available: true, text: 'part', truncated: true })
    expect(await screen.findByText(/这里只显示开头部分/)).toBeDefined()
  })

  it('reports a failed read', async () => {
    setup(async () => undefined)
    expect(await screen.findByText(/无法读取许可声明/)).toBeDefined()
  })

  it('closes from the footer button', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup({ available: true, text: 'MIT', truncated: false })
    await screen.findByText('MIT')
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not read the notices while closed', async () => {
    const { request } = setup({ available: true, text: 'MIT', truncated: false }, false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(request).not.toHaveBeenCalled()
  })
})
