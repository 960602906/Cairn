// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { WindowControlsApi } from '@cairn/protocol'
import { WindowControls } from './WindowControls.js'

afterEach(() => {
  cleanup()
  delete (window as { cairn?: unknown }).cairn
})

function controls(patch: Partial<WindowControlsApi> = {}): WindowControlsApi {
  return {
    platform: 'win32',
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    onMaximizedChange: vi.fn(() => () => undefined),
    ...patch,
  }
}

function renderControls(api?: WindowControlsApi) {
  if (api) (window as { cairn?: unknown }).cairn = { windowControls: api }
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <WindowControls />
    </I18nextProvider>,
  )
}

describe('WindowControls', () => {
  it('renders nothing without the preload API or on macOS', () => {
    renderControls()
    expect(screen.queryByRole('button', { name: '关闭窗口' })).toBeNull()
    cleanup()
    renderControls(controls({ platform: 'darwin' }))
    expect(screen.queryByRole('button', { name: '关闭窗口' })).toBeNull()
  })

  it('runs minimize, maximize and close', async () => {
    const api = controls()
    renderControls(api)
    await userEvent.click(screen.getByRole('button', { name: '最小化窗口' }))
    await userEvent.click(screen.getByRole('button', { name: '最大化窗口' }))
    await userEvent.click(screen.getByRole('button', { name: '关闭窗口' }))
    expect(api.minimize).toHaveBeenCalledOnce()
    expect(api.toggleMaximize).toHaveBeenCalledOnce()
    expect(api.close).toHaveBeenCalledOnce()
  })

  it('surfaces a rejected window action instead of failing silently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const api = controls({
      minimize: vi.fn(async () => {
        throw new Error('No handler registered')
      }),
    })
    renderControls(api)
    await userEvent.click(screen.getByRole('button', { name: '最小化窗口' }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('[window-controls]', expect.any(Error)))
    error.mockRestore()
  })

  it('starts in the restore state when the window is maximized', async () => {
    const off = vi.fn()
    const api = controls({
      isMaximized: vi.fn(async () => true),
      onMaximizedChange: vi.fn(() => off),
    })
    ;(window as { cairn?: unknown }).cairn = { windowControls: api }
    const view = render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <WindowControls />
      </I18nextProvider>,
    )
    expect(await screen.findByRole('button', { name: '还原窗口' })).toBeTruthy()
    expect(api.onMaximizedChange).toHaveBeenCalled()
    view.unmount()
    expect(off).toHaveBeenCalledOnce()
  })

  it('updates the icon when the main process reports a state change', async () => {
    let listener: ((maximized: boolean) => void) | undefined
    const api = controls({
      onMaximizedChange: vi.fn((next) => {
        listener = next
        return () => undefined
      }),
    })
    renderControls(api)
    expect(api.onMaximizedChange).toHaveBeenCalledTimes(1)
    expect(listener).toBeTypeOf('function')
    expect(screen.getByRole('button', { name: '最大化窗口' })).toBeTruthy()
    await act(async () => listener?.(true))
    expect(await screen.findByRole('button', { name: '还原窗口' })).toBeTruthy()
    await act(async () => listener?.(false))
    expect(await screen.findByRole('button', { name: '最大化窗口' })).toBeTruthy()
  })
})
