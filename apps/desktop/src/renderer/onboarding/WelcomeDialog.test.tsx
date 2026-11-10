// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { Settings } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { createSessionStore } from '../session-store.js'
import { SessionStoreContext } from '../store-context.js'
import { WelcomeDialog } from './WelcomeDialog.js'

afterEach(cleanup)

const provider = {
  id: 'p',
  kind: 'openai' as const,
  displayName: 'Provider',
  baseUrl: 'https://api.example',
  models: [],
}

function setup(
  settings: Settings | undefined,
  props: Partial<React.ComponentProps<typeof WelcomeDialog>> = {},
) {
  const store = createSessionStore({
    ready: async () => {},
    request: async () => ({}),
    on: () => () => {},
  } as unknown as MainApi)
  if (settings) store.setState({ settings })
  const onOpenChange = vi.fn()
  const onConfigure = vi.fn()
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SessionStoreContext.Provider value={store}>
        <WelcomeDialog open onOpenChange={onOpenChange} onConfigure={onConfigure} {...props} />
      </SessionStoreContext.Provider>
    </I18nextProvider>,
  )
  return { onOpenChange, onConfigure }
}

describe('WelcomeDialog', () => {
  it('explains local data, credentials, updates, diagnostics and limits', () => {
    setup({ locale: 'zh-CN', providers: [], onboardingSeen: false })
    expect(screen.getByRole('heading', { name: '欢迎使用 Cairn' })).toBeDefined()
    for (const title of [
      '不需要账号，也不收集遥测',
      '在你的项目里工作',
      '数据保存在本机',
      'API Key 只保存在本机',
      '更新检查与诊断包',
      '了解安全边界',
    ]) {
      expect(screen.getByText(title)).toBeDefined()
    }
    expect(screen.getByText(/%APPDATA%\\Cairn/)).toBeDefined()
    expect(screen.getByText(/命令沙箱不是虚拟机/)).toBeDefined()
  })

  it('guides users without a provider to model settings', async () => {
    const { onOpenChange, onConfigure } = setup({
      locale: 'zh-CN',
      providers: [],
      onboardingSeen: false,
    })
    expect(screen.getByText(/还没有配置模型供应商/)).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: '配置模型' }))
    expect(onConfigure).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('starts directly when a provider is configured', async () => {
    const { onOpenChange, onConfigure } = setup({
      locale: 'zh-CN',
      providers: [provider],
      onboardingSeen: false,
    })
    expect(screen.queryByText(/还没有配置模型供应商/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '开始使用' }))
    expect(onConfigure).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes without configuring from the later button', async () => {
    const { onOpenChange, onConfigure } = setup({
      locale: 'zh-CN',
      providers: [],
      onboardingSeen: false,
    })
    await userEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(onConfigure).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('offers only a close button when reopened from settings', async () => {
    const { onOpenChange } = setup(
      { locale: 'zh-CN', providers: [], onboardingSeen: true },
      { review: true },
    )
    expect(screen.queryByRole('button', { name: '稍后' })).toBeNull()
    expect(screen.queryByRole('button', { name: '配置模型' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not guess provider state before settings load', () => {
    setup(undefined)
    expect(screen.queryByText(/还没有配置模型供应商/)).toBeNull()
    expect(screen.getByRole('button', { name: '开始使用' })).toBeDefined()
  })
})
