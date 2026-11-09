// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError, type Settings, type SettingsPatch } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type ShellResult = { detected: string; options: ('auto' | 'cmd')[] } | Error

function setup(
  initial: Partial<Settings> = {},
  shell: ShellResult = { detected: 'bash', options: ['auto'] },
) {
  let settings: Settings = { locale: 'zh-CN', providers: [], ...initial }
  const updates: SettingsPatch[] = []
  let failing = false
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'settings.get') return settings
    if (method === 'settings.update') {
      if (failing) throw new RpcError('settings.write_failed')
      const patch = params as SettingsPatch
      updates.push(patch)
      const { instructions, ...rest } = patch
      settings = { ...settings, ...rest } as Settings
      if (instructions !== undefined) {
        const { instructions: _, ...without } = settings
        settings = instructions?.trim() ? { ...without, instructions } : without
      }
      return settings
    }
    if (method === 'settings.shell') {
      if (shell instanceof Error) throw shell
      return shell
    }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'project.list') return { projects: [] }
    return {}
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  const i18n = createI18n('zh-CN')
  render(<App i18n={i18n} store={createSessionStore(api)} />)
  return {
    updates,
    i18n,
    fail: () => {
      failing = true
    },
  }
}

const openSettings = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /^设置/ }))
  return screen.findByRole('heading', { name: '通用与外观' })
}

describe('SettingsPage', () => {
  it('opens from the sidebar and goes back with the button or Esc', async () => {
    setup()
    await openSettings()
    const nav = screen.getByRole('navigation', { name: '设置分类' })
    expect(
      within(nav).getByRole('button', { name: '通用与外观' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(screen.queryByRole('navigation', { name: '会话' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /返回对话/ }))
    expect(screen.queryByRole('heading', { name: '通用与外观' })).toBeNull()
    expect(screen.getByRole('navigation', { name: '会话' })).toBeTruthy()

    await openSettings()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('heading', { name: '通用与外观' })).toBeNull()
  })

  it('opens with Ctrl+, and leaves Esc to an open dialog', async () => {
    setup()
    await screen.findByRole('navigation', { name: '会话' })
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    await screen.findByRole('heading', { name: '通用与外观' })
    // 已经在设置页时再按不变
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('heading', { name: '通用与外观' })).toBeTruthy()
    dialog.remove()
    // 新对话的快捷键也会离开设置页
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    expect(screen.queryByRole('heading', { name: '通用与外观' })).toBeNull()
  })

  it('saves the theme and the language', async () => {
    const { updates, i18n } = setup({ theme: 'obsidian' })
    await openSettings()
    const theme = screen.getByRole('radiogroup', { name: '主题' })
    await waitFor(() =>
      expect(
        within(theme).getByRole('radio', { name: /^黑曜/ }).getAttribute('aria-checked'),
      ).toBe('true'),
    )
    await userEvent.click(within(theme).getByRole('radio', { name: /^苔原/ }))
    expect(updates).toContainEqual({ theme: 'tundra' })

    const language = screen.getByRole('radiogroup', { name: '界面语言' })
    await userEvent.click(within(language).getByRole('radio', { name: 'English' }))
    expect(updates).toContainEqual({ locale: 'en-US' })
    expect(i18n.language).toBe('en-US')
    expect(await screen.findByRole('heading', { name: 'General & appearance' })).toBeTruthy()
  })

  it('keeps the new language and shows an error when saving fails', async () => {
    const { fail } = setup()
    await openSettings()
    fail()
    const language = screen.getByRole('radiogroup', { name: '界面语言' })
    await userEvent.click(within(language).getByRole('radio', { name: 'English' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to save settings')
    expect(screen.getByRole('heading', { name: 'General & appearance' })).toBeTruthy()
  })

  it('shows the detected shell and offers cmd on Windows', async () => {
    const { updates } = setup({}, { detected: 'PowerShell 7.5.4', options: ['auto', 'cmd'] })
    await openSettings()
    const shell = await screen.findByRole('radiogroup', { name: '默认 Shell' })
    const auto = within(shell).getByRole('radio', { name: '自动（PowerShell 7.5.4）' })
    expect(auto.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(within(shell).getByRole('radio', { name: 'cmd' }))
    expect(updates).toContainEqual({ shell: 'cmd' })
    expect(screen.getByText(/优先 PowerShell 7/)).toBeTruthy()
  })

  it('shows the shell as text elsewhere, and when detection fails', async () => {
    setup()
    await openSettings()
    expect(await screen.findByText('自动（bash）')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: '默认 Shell' })).toBeNull()
    cleanup()
    setup({}, new Error('probe failed'))
    await openSettings()
    expect(await screen.findByText('自动（无法检测）')).toBeTruthy()
  })

  it('edits, reverts and saves the global instructions', async () => {
    const { updates } = setup({ instructions: '用中文回复' })
    await openSettings()
    const box = screen.getByRole('textbox', { name: '全局指令' })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('用中文回复'))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.getByText('5 / 10000')).toBeTruthy()

    await userEvent.type(box, '。')
    await userEvent.click(screen.getByRole('button', { name: '还原' }))
    expect((box as HTMLTextAreaElement).value).toBe('用中文回复')

    await userEvent.clear(box)
    await userEvent.type(box, '先说明计划')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(updates).toContainEqual({ instructions: '先说明计划' })
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).toBeNull())

    // 只有空白时清除
    await userEvent.clear(box)
    await userEvent.type(box, '   ')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(updates).toContainEqual({ instructions: null })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))
  })

  it('turns automatic session briefs off and back on', async () => {
    const { updates } = setup()
    await openSettings()
    const toggle = await screen.findByRole('switch', { name: '自动更新会话要点' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(toggle)
    expect(updates).toContainEqual({ sessionBrief: false })
    await userEvent.click(toggle)
    expect(updates).toContainEqual({ sessionBrief: true })
  })

  it('keeps the category list visible in a narrow window', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    setup()
    await openSettings()
    const nav = screen.getByRole('navigation', { name: '设置分类' })
    expect(nav).toBeTruthy()
    expect(within(nav).getByRole('button', { name: '通用与外观' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '收起侧栏' })).toBeNull()
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull()
  })

  it('keeps the category list static when it cannot collapse', async () => {
    setup()
    await openSettings()
    const nav = screen.getByRole('navigation', { name: '设置分类' })
    const aside = nav.closest('aside')!
    expect(aside.className).toContain('w-[252px]')
    expect(aside.className).toContain('opacity-100')
    expect(aside.getAttribute('aria-hidden')).toBe('false')
    expect(screen.queryByRole('button', { name: '收起侧栏' })).toBeNull()
  })
})
