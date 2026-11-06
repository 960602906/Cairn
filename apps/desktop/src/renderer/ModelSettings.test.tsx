// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ProviderConfig, Settings, SettingsPatch } from '@cairn/protocol'
import type { MainApi } from './api.js'
import { App } from './App.js'
import { uniqueProviderId } from './ModelSettings.js'
import { createSessionStore } from './session-store.js'

afterEach(cleanup)

function setup({ available = true, initial = [] as ProviderConfig[] } = {}) {
  let settings: Settings = { locale: 'zh-CN', providers: initial }
  const keys = new Set<string>()
  const request = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case 'settings.get':
        return settings
      case 'settings.update': {
        const patch = params as SettingsPatch
        const { defaultModel, ...rest } = patch
        settings = { ...settings, ...rest } as Settings
        if (defaultModel === null) {
          const { defaultModel: _removed, ...without } = settings
          settings = without
        } else if (defaultModel !== undefined) settings = { ...settings, defaultModel }
        return settings
      }
      case 'credentials.set':
        keys.add((params as { ref: string }).ref)
        return {}
      case 'credentials.status':
        return { configured: keys.has((params as { ref: string }).ref), available }
      case 'session.list':
        return { sessions: [] }
      default:
        return {}
    }
  })
  const api = { ready: () => Promise.resolve(), request, on: () => () => {} } as unknown as MainApi
  const store = createSessionStore(api)
  render(<App i18n={createI18n('zh-CN')} store={store} />)
  return { request, store, settings: () => settings }
}

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: '模型设置' }))
  return screen.findByRole('dialog', { name: '模型与 Key' })
}

describe('ModelSettings', () => {
  it('adds a provider from a template with its key and sets the default model', async () => {
    const { request, settings } = setup()
    const dialog = await open()
    expect(within(dialog).getByText('还没有配置模型。选择一个模板添加。')).toBeTruthy()
    const baseUrl = within(dialog).getByLabelText('接口地址') as HTMLInputElement
    expect(baseUrl.value).toBe('https://api.deepseek.com')
    await userEvent.clear(baseUrl)
    await userEvent.type(baseUrl, 'http://127.0.0.1:3425/v1')
    await userEvent.type(within(dialog).getByLabelText('Key'), ' sk-test ')
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }))

    await waitFor(() => expect(within(dialog).getByText('已保存 Key')).toBeTruthy())
    expect(request).toHaveBeenCalledWith('credentials.set', { ref: 'deepseek', secret: 'sk-test' })
    const provider = settings().providers[0]!
    expect(provider).toMatchObject({
      id: 'deepseek',
      baseUrl: 'http://127.0.0.1:3425/v1',
      credentialRef: 'deepseek',
      template: 'deepseek',
    })
    // 第一个提供方的第一个模型成为默认模型
    expect(settings().defaultModel).toEqual({
      providerId: 'deepseek',
      modelId: provider.models[0]!.id,
    })
    const select = within(dialog).getByLabelText('默认模型') as HTMLSelectElement
    expect(select.selectedOptions[0]!.textContent).toContain('DeepSeek /')

    // 同一模板再加一个：id 加序号，默认模型不变
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }))
    await waitFor(() => expect(settings().providers).toHaveLength(2))
    expect(settings().providers[1]!.id).toBe('deepseek-2')
    expect(settings().defaultModel?.providerId).toBe('deepseek')

    // 取消默认模型
    await userEvent.selectOptions(select, '')
    await waitFor(() => expect(settings().defaultModel).toBeUndefined())
    // 删除第二个
    await userEvent.click(within(dialog).getAllByRole('button', { name: '删除 DeepSeek' })[1]!)
    await waitFor(() => expect(settings().providers.map((p) => p.id)).toEqual(['deepseek']))
  })

  it('saves a key for an existing provider and adds templates without keys', async () => {
    const { request, settings } = setup({
      initial: [
        {
          id: 'openai',
          kind: 'openai',
          displayName: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          credentialRef: 'openai',
          models: [],
        },
      ],
    })
    const dialog = await open()
    const row = await within(dialog).findByRole('listitem')
    expect(within(row).getByText('未保存 Key')).toBeTruthy()
    const save = within(row).getByRole('button', { name: '保存 Key' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(within(row).getByLabelText('OpenAI 的 Key'), 'k1')
    await userEvent.click(save)
    await waitFor(() => expect(within(row).getByText('已保存 Key')).toBeTruthy())
    expect(request).toHaveBeenCalledWith('credentials.set', { ref: 'openai', secret: 'k1' })
    expect((within(row).getByLabelText('OpenAI 的 Key') as HTMLInputElement).value).toBe('')

    await userEvent.selectOptions(within(dialog).getByLabelText('模板'), 'gemini')
    await userEvent.type(within(dialog).getByLabelText('Key'), 'k2')
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }))
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(2))
    expect(settings().providers.map((p) => [p.id, p.credentialRef])).toEqual([
      ['openai', 'openai'],
      ['gemini', 'gemini'],
    ])
    expect(request).toHaveBeenCalledWith('credentials.set', { ref: 'gemini', secret: 'k2' })

    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains that keys cannot be saved without system encryption', async () => {
    setup({
      available: false,
      initial: [
        {
          id: 'openai',
          kind: 'openai',
          displayName: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          credentialRef: 'openai',
          models: [],
        },
      ],
    })
    const dialog = await open()
    expect(await within(dialog).findByText('系统加密不可用，无法保存 Key。')).toBeTruthy()
    expect(within(dialog).queryByLabelText('OpenAI 的 Key')).toBeNull()
    expect(within(dialog).queryByLabelText('Key')).toBeNull()
  })

  it('numbers provider ids that are taken', () => {
    const p = (id: string) => ({ id }) as ProviderConfig
    expect(uniqueProviderId('a', [])).toBe('a')
    expect(uniqueProviderId('a', [p('a'), p('a-2')])).toBe('a-3')
  })
})
