// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { I18nextProvider } from 'react-i18next'
import { RpcError, type SandboxStatus, type Settings, type SettingsPatch } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreProvider } from '../store-context.js'
import { SettingsNav } from './SettingsPage.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type ShellResult = { detected: string; options: ('auto' | 'cmd')[] } | Error

const SANDBOX_STATUS: SandboxStatus = {
  platform: 'win32',
  mechanism: 'restricted-token',
  policy: { profile: 'workspace-write', network: 'none' },
  unavailable: 'deny',
  capability: {
    available: true,
    supported: true,
    mechanism: 'restricted-token',
    networkIsolated: false,
    checks: { restrictedToken: true, lowIntegrity: true, jobObject: true, appContainer: false },
  },
}

function setup(
  initial: Partial<Settings> = {},
  shell: ShellResult = { detected: 'bash', options: ['auto'] },
  sandbox: SandboxStatus | 'error' = SANDBOX_STATUS,
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
    if (method === 'sandbox.status') {
      if (sandbox === 'error') throw new RpcError('sandbox.status_failed')
      return sandbox
    }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'project.list') return { projects: [] }
    if (method === 'diagnostics.summary') {
      return {
        appVersion: '0.1.0',
        electronVersion: '45.2.1',
        build: {
          schemaVersion: 1,
          version: '0.1.0',
          channel: 'beta',
          commit: 'unknown',
          buildTime: '',
          electronVersion: '45.2.1',
          nodeVersion: '24.11.0',
          name: 'Cairn',
          appId: 'com.cairn.desktop',
          copyright: 'Copyright © 2026 Cairn contributors',
          packaged: false,
          databaseSchemaVersion: 17,
        },
        platform: 'win32',
        arch: 'x64',
        logs: { mainLogLines: 0, hostLogLines: 0 },
        settings: { providersCount: 0, mcpServersCount: 0, hasAuxiliaryModel: false },
        exportItems: ['manifest.json', 'build-info.json'],
      }
    }
    return {}
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  const i18n = createI18n('zh-CN')
  const store = createSessionStore(api)
  render(<App i18n={i18n} store={store} />)
  return {
    updates,
    i18n,
    store,
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
  it('shows the first-run welcome and records it when configuring models', async () => {
    const { updates } = setup({ onboardingSeen: false })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '欢迎使用 Cairn' })).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '配置模型' }))
    expect(await screen.findByRole('heading', { name: '模型供应商' })).toBeTruthy()
    expect(updates).toContainEqual({ onboardingSeen: true })
  })

  it('does not show the welcome again for returning users', async () => {
    setup({ onboardingSeen: true })
    await screen.findByRole('navigation', { name: '会话' })
    expect(screen.queryByRole('heading', { name: '欢迎使用 Cairn' })).toBeNull()
  })

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
      expect(within(theme).getByRole('radio', { name: /^黑曜/ }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    )
    await userEvent.click(within(theme).getByRole('radio', { name: /^苔原/ }))
    expect(updates).toContainEqual({ theme: 'tundra' })

    const language = screen.getByRole('radiogroup', { name: '界面语言' })
    await userEvent.click(within(language).getByRole('radio', { name: 'English' }))
    expect(updates).toContainEqual({ locale: 'en-US' })
    expect(i18n.language).toBe('en-US')
    expect(await screen.findByRole('heading', { name: 'General & appearance' })).toBeTruthy()
  })

  it('offers the system theme, reports instruction save failures and opens diagnostics', async () => {
    const { updates, fail } = setup()
    await openSettings()
    const theme = screen.getByRole('radiogroup', { name: '主题' })
    await userEvent.click(within(theme).getByRole('radio', { name: /^跟随系统/ }))
    expect(updates).toContainEqual({ theme: 'system' })

    fail()
    const instructions = screen.getByRole('textbox', { name: '全局指令' })
    await userEvent.type(instructions, '先给结论')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect((await screen.findByRole('alert')).textContent).toContain('设置保存失败')

    const exports = screen.getAllByRole('button', { name: '导出诊断包' })
    await userEvent.click(exports.at(-1)!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '导出诊断包' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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

  it('syncs instructions from outside only when there is no local draft', async () => {
    const { store } = setup()
    await openSettings()
    const box = screen.getByRole('textbox', { name: '全局指令' })
    await act(async () => {
      await store.getState().updateSettings({ instructions: '外部更新' })
    })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('外部更新'))

    await userEvent.type(box, '（本地）')
    await act(async () => {
      await store.getState().updateSettings({ instructions: '再次外部更新' })
    })
    expect((box as HTMLTextAreaElement).value).toBe('外部更新（本地）')
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

  it('edits the sandbox profile, network and unavailable behavior', async () => {
    const { updates } = setup({
      sandboxProfile: 'workspace-write',
      sandboxNetwork: 'none',
      sandboxUnavailable: 'deny',
    })
    await openSettings()

    const profile = await screen.findByRole('radiogroup', { name: '默认档位' })
    await userEvent.click(within(profile).getByRole('radio', { name: '只读' }))
    expect(updates).toContainEqual({ sandboxProfile: 'read-only' })
    expect(screen.getByText(/工作区不可写/)).toBeTruthy()

    const network = screen.getByRole('radiogroup', { name: '网络策略' })
    await userEvent.click(within(network).getByRole('radio', { name: '公网' }))
    expect(updates).toContainEqual({ sandboxNetwork: 'internet' })
    expect(screen.getByText(/受限令牌机制不能隔离网络/)).toBeTruthy()

    const unavailable = screen.getByRole('radiogroup', { name: '沙箱不可用时' })
    await userEvent.click(within(unavailable).getByRole('radio', { name: '每次询问' }))
    expect(updates).toContainEqual({ sandboxUnavailable: 'ask' })
  })

  it('shows the probed sandbox capability without claiming network isolation', async () => {
    setup()
    await openSettings()
    const panel = await screen.findByTestId('sandbox-capability')
    expect(panel.getAttribute('data-sandbox-available')).toBe('true')
    expect(within(panel).getByText(/可用 · 受限令牌/)).toBeTruthy()
    expect(within(panel).getByText(/网络：网络未隔离/)).toBeTruthy()
    expect(within(panel).getByText('AppContainer')).toBeTruthy()
  })

  it('reports a failed capability probe and points at the diagnostic bundle', async () => {
    setup({}, undefined, 'error')
    await openSettings()
    const panel = await screen.findByTestId('sandbox-capability')
    expect(within(panel).getByText('无法读取沙箱能力，请导出诊断包。')).toBeTruthy()
    expect(within(panel).getByText(/能力探测结果会写入诊断包/)).toBeTruthy()
  })

  it('shows an unavailable sandbox reason', async () => {
    setup({}, undefined, {
      ...SANDBOX_STATUS,
      mechanism: 'appcontainer',
      capability: {
        ...SANDBOX_STATUS.capability,
        available: false,
        reason: 'sandbox.platform_unsupported',
      },
    })
    await openSettings()
    const panel = await screen.findByTestId('sandbox-capability')
    expect(panel.getAttribute('data-sandbox-available')).toBe('false')
    expect(within(panel).getByText('不可用 · 当前平台不支持')).toBeTruthy()
    expect(within(panel).getByText('网络：网络未隔离')).toBeTruthy()
    expect(screen.getByText('由 AppContainer 能力执行。')).toBeTruthy()
  })

  it('explains when the preferred mechanism fell back', async () => {
    setup({}, undefined, { ...SANDBOX_STATUS, mechanism: 'appcontainer' })
    await openSettings()
    const panel = await screen.findByTestId('sandbox-capability')
    expect(within(panel).getByText(/所选机制 AppContainer 不可用，已回退到 受限令牌/)).toBeTruthy()
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

  it('renders collapsed and collapsible navigation states', async () => {
    const i18n = createI18n('zh-CN')
    const api = {
      ready: async () => {},
      request: async () => ({ locale: 'zh-CN', providers: [] }),
      on: () => () => {},
    } as unknown as MainApi
    const store = createSessionStore(api)
    const onCollapse = vi.fn()
    const nav = (open: boolean, collapsible: boolean) => (
      <I18nextProvider i18n={i18n}>
        <SessionStoreProvider store={store}>
          <SettingsNav
            open={open}
            collapsible={collapsible}
            section="general"
            onSelect={() => {}}
            onBack={() => {}}
            onCollapse={onCollapse}
          />
        </SessionStoreProvider>
      </I18nextProvider>
    )
    const { container, rerender } = render(nav(false, false))
    const hidden = container.querySelector('aside')!
    expect(hidden.getAttribute('aria-hidden')).toBe('true')
    expect(hidden.className).toContain('w-0')
    expect(screen.queryByRole('button', { name: '收起侧栏' })).toBeNull()

    rerender(nav(true, true))
    const shown = container.querySelector('aside')!
    expect(shown.getAttribute('aria-hidden')).toBe('false')
    expect(shown.className).toContain('w-[252px]')
    await userEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('filters the category list by title, description and keywords', async () => {
    setup({
      providers: [
        { id: 'p', kind: 'openai', displayName: 'P', baseUrl: 'https://p.example', models: [] },
      ],
    })
    await openSettings()
    const nav = screen.getByRole('navigation', { name: '设置分类' })
    const search = screen.getByRole('searchbox', { name: '搜索设置' })
    expect(within(nav).getByText('1')).toBeTruthy()

    await userEvent.type(search, 'shell')
    expect(within(nav).getByRole('button', { name: '通用与外观' })).toBeTruthy()
    expect(within(nav).queryByRole('button', { name: 'MCP 服务' })).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, '审批')
    expect(within(nav).getByRole('button', { name: '权限与审批' })).toBeTruthy()
    expect(within(nav).queryByRole('button', { name: /^模型供应商/ })).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, '不存在的设置')
    expect(within(nav).getByText('没有匹配的设置')).toBeTruthy()
    expect(within(nav).queryAllByRole('button')).toHaveLength(0)

    await userEvent.clear(search)
    expect(within(nav).getByRole('button', { name: 'MCP 服务' })).toBeTruthy()
  })
})
