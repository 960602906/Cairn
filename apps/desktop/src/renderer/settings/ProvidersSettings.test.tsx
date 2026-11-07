// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { ProviderConfig, Settings, SettingsPatch } from '@cairn/protocol'
import type { MainApi } from '../api.js'
import { App } from '../App.js'
import { createSessionStore } from '../session-store.js'

afterEach(cleanup)

const cap = {
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

const deepseek: ProviderConfig = {
  id: 'deepseek',
  kind: 'openai',
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  credentialRef: 'deepseek',
  template: 'deepseek',
  compat: { thinkingFormat: 'deepseek' },
  models: [
    { id: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', ...cap, supportsReasoning: true },
    { id: 'deepseek-v4-pro', ...cap, contextWindow: 1_000_000 },
  ],
}

const gateway: ProviderConfig = {
  id: 'gw',
  kind: 'anthropic',
  displayName: '公司网关',
  baseUrl: 'https://gw.example.com',
  credentialRef: 'gw',
  models: [{ id: 'claude-x', ...cap, supportsTools: false }],
}

type Handler = (params: never) => unknown

function setup(initial: Partial<Settings> = {}, handlers: Record<string, Handler> = {}) {
  let settings: Settings = { locale: 'zh-CN', providers: [], ...initial }
  // 只有已配置的供应商保存过 Key
  const keys = new Map<string, string>(
    (
      [
        ['deepseek', 'sk-0000-3f9a'],
        ['gw', 'short'],
      ] as const
    ).filter(([ref]) => settings.providers.some((p) => p.credentialRef === ref)),
  )
  const updates: SettingsPatch[] = []
  const request = vi.fn(async (method: string, params: never) => {
    if (handlers[method]) return handlers[method](params)
    switch (method) {
      case 'settings.get':
        return settings
      case 'settings.update': {
        const patch = params as SettingsPatch
        updates.push(patch)
        settings = {
          ...settings,
          ...(patch.providers ? { providers: patch.providers } : {}),
          ...(patch.defaultModel ? { defaultModel: patch.defaultModel } : {}),
        }
        return settings
      }
      case 'credentials.status': {
        const key = keys.get((params as { ref: string }).ref)
        return {
          configured: key !== undefined,
          available: true,
          ...(key && key.length >= 8 ? { last4: key.slice(-4) } : {}),
        }
      }
      case 'credentials.set': {
        const { ref, secret } = params as { ref: string; secret: string }
        keys.set(ref, secret)
        return {}
      }
      case 'session.list':
        return { sessions: [] }
      case 'project.list':
        return { projects: [] }
      default:
        return {}
    }
  })
  const api = { ready: async () => {}, request, on: () => () => {} } as unknown as MainApi
  render(<App i18n={createI18n('zh-CN')} store={createSessionStore(api)} />)
  return { request, updates, settings: () => settings }
}

const open = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /^模型供应商/ }))
  return screen.findByRole('heading', { name: '模型供应商' })
}

const editor = (name: string) => screen.getByRole('region', { name })

describe('ProvidersSettings', () => {
  it('opens from the sidebar card and adds the first provider with its key', async () => {
    const { request, updates } = setup(
      {},
      { 'provider.test': () => ({ ok: true, latencyMs: 312 }) },
    )
    await open()
    expect(screen.getByText(/还没有配置模型供应商/)).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '设置分类' })
    expect(
      within(nav).getByRole('button', { name: '模型供应商' }).getAttribute('aria-current'),
    ).toBe('page')

    await userEvent.click(screen.getAllByRole('button', { name: '添加供应商' })[0]!)
    const card = editor('新供应商')
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://api.deepseek.com',
    )
    expect(within(card).getByRole('radio', { name: '官方' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    await userEvent.type(within(card).getByLabelText('API Key'), ' sk-new-key-1234 ')
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(await within(card).findByText(/312 ms/)).toBeTruthy()
    expect(request).toHaveBeenCalledWith('provider.test', {
      provider: expect.objectContaining({ id: 'deepseek', template: 'deepseek' }),
      modelId: 'deepseek-flash',
      secret: 'sk-new-key-1234',
    })

    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({
      providers: [expect.objectContaining({ id: 'deepseek', credentialRef: 'deepseek' })],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    expect(request).toHaveBeenCalledWith('credentials.set', {
      ref: 'deepseek',
      secret: 'sk-new-key-1234',
    })
    // 保存后选中新的供应商，测试结果跟着它
    const list = await screen.findByRole('list', { name: '已配置的供应商' })
    expect(within(list).getByText('正常')).toBeTruthy()
    expect(await screen.findByText('••••••••1234')).toBeTruthy()
  })

  it('lists providers with source, default, key and test status', async () => {
    setup({
      providers: [
        deepseek,
        gateway,
        { ...gateway, id: 'nokey', credentialRef: 'nokey', displayName: 'X' },
      ],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    await open()
    const list = screen.getByRole('list', { name: '已配置的供应商' })
    const rows = within(list).getAllByRole('button')
    expect(rows[0]!.textContent).toMatch(/DeepSeek官方OpenAI 格式 · 2 个模型默认未测试/)
    expect(rows[1]!.textContent).toMatch(/公司网关第三方中转Anthropic 格式 · 1 个模型/)
    await waitFor(() => expect(rows[2]!.textContent).toMatch(/未保存 Key.*未配置/))
    expect(await screen.findByText('••••••••3f9a')).toBeTruthy()
    expect(screen.getByText('已保存到系统钥匙串')).toBeTruthy()

    // 短 Key 不显示末 4 位
    await userEvent.click(rows[1]!)
    const card = editor('公司网关')
    expect(await within(card).findByText('••••••••')).toBeTruthy()
    expect(within(card).getByText('128k 上下文 · 不支持工具')).toBeTruthy()
    expect(within(card).getByText('不需要带 /v1。')).toBeTruthy()
  })

  it('edits models, the default and the key, and reverts with cancel', async () => {
    const { updates, request } = setup({
      providers: [deepseek],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    await open()
    const card = editor('DeepSeek')
    const save = within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    // 默认模型不能停用或删除
    expect(
      (within(card).getByRole('switch', { name: '启用 DeepSeek V4.1 Flash' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await userEvent.click(within(card).getByRole('switch', { name: '启用 deepseek-v4-pro' }))
    expect(save.disabled).toBe(false)
    await userEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(save.disabled).toBe(true)

    await userEvent.click(within(card).getByRole('button', { name: '设为默认' }))
    await userEvent.click(within(card).getByRole('switch', { name: '启用 DeepSeek V4.1 Flash' }))
    await userEvent.click(within(card).getByRole('button', { name: '更换' }))
    await userEvent.click(within(card).getByRole('button', { name: '保留原来的' }))
    await userEvent.click(within(card).getByRole('button', { name: '更换' }))
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-replaced-9999')
    await userEvent.clear(within(card).getByLabelText('名称'))
    await userEvent.type(within(card).getByLabelText('名称'), 'DS')
    await userEvent.click(save)
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({
      providers: [
        expect.objectContaining({
          id: 'deepseek',
          displayName: 'DS',
          models: [
            expect.objectContaining({ id: 'deepseek-flash', enabled: false }),
            expect.not.objectContaining({ enabled: expect.anything() }),
          ],
        }),
      ],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    })
    expect(request).toHaveBeenCalledWith('credentials.set', {
      ref: 'deepseek',
      secret: 'sk-replaced-9999',
    })
  })

  it('switches to a relay, changes the format and validates the address', async () => {
    setup({ providers: [deepseek] })
    await open()
    await userEvent.click(screen.getByRole('button', { name: '添加供应商' }))
    const card = editor('新供应商')
    await userEvent.click(within(card).getByRole('radio', { name: '第三方中转' }))
    const url = within(card).getByLabelText('Base URL') as HTMLInputElement
    expect(url.value).toBe('')
    const service = within(card).getByLabelText('服务') as HTMLSelectElement
    expect(service.value).toBe('deepseek')
    expect(within(card).getByRole('option', { name: '兼容 DeepSeek' })).toBeTruthy()
    const save = within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(url, 'ftp://x')
    expect(within(card).getByText(/地址需要以 http/)).toBeTruthy()
    await userEvent.clear(url)
    await userEvent.type(url, 'http://127.0.0.1:3425/v1')
    expect(save.disabled).toBe(false)

    await userEvent.selectOptions(service, '')
    await userEvent.click(within(card).getByRole('button', { name: /高级/ }))
    expect((within(card).getByLabelText('思考参数格式') as HTMLSelectElement).value).toBe('')
    await userEvent.selectOptions(within(card).getByLabelText('思考参数格式'), 'qwen')
    await userEvent.selectOptions(within(card).getByLabelText('输出上限字段'), 'max_tokens')
    const reasoning = within(card).getByRole('radiogroup', { name: '回传推理内容' })
    await userEvent.click(within(reasoning).getByRole('radio', { name: '是' }))
    await userEvent.click(within(reasoning).getByRole('radio', { name: '否' }))
    await userEvent.click(within(reasoning).getByRole('radio', { name: '自动' }))
    await userEvent.selectOptions(within(card).getByLabelText('输出上限字段'), '')

    await userEvent.click(within(card).getByRole('radio', { name: /Anthropic/ }))
    expect(within(card).getByText('这种接口格式没有需要调整的兼容参数。')).toBeTruthy()
    expect(within(card).getByText('claude-sonnet-5-5')).toBeTruthy()
    expect(url.value).toBe('http://127.0.0.1:3425/v1')
    await userEvent.click(within(card).getByRole('radio', { name: '官方' }))
    expect(url.value).toBe('https://api.anthropic.com')

    await userEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('region', { name: '新供应商' })).toBeNull()
  })

  it('fetches the model list, or falls back to adding models manually', async () => {
    let fail = false
    const { request } = setup(
      { providers: [gateway] },
      {
        'provider.models': () =>
          fail
            ? { ok: false, error: { code: 'provider.invalid_response' } }
            : {
                ok: true,
                models: [
                  { id: 'claude-x' },
                  { id: 'claude-y', displayName: 'Claude Y', contextWindow: 200_000 },
                  { id: 'claude-z' },
                  { id: 'claude-w' },
                ],
              },
      },
    )
    await open()
    const card = editor('公司网关')
    await userEvent.click(within(card).getByRole('button', { name: '拉取模型列表' }))
    expect(request).toHaveBeenCalledWith('provider.models', {
      provider: expect.objectContaining({ id: 'gw' }),
    })
    const found = await within(card).findByRole('list', { name: '拉取到的模型' })
    expect(within(card).getByText('找到 3 个未添加的模型')).toBeTruthy()
    expect(within(found).getByText('200k 上下文')).toBeTruthy()
    await userEvent.click(within(found).getByRole('button', { name: '添加 claude-y' }))
    expect(within(card).getByText('Claude Y')).toBeTruthy()
    await userEvent.click(within(card).getByRole('button', { name: '全部添加' }))
    expect(within(card).getByText('找到 0 个未添加的模型')).toBeTruthy()
    await userEvent.click(within(card).getByRole('button', { name: '收起' }))
    await userEvent.click(within(card).getByRole('button', { name: '删除 claude-w' }))
    expect(within(card).queryByText('claude-w')).toBeNull()

    fail = true
    await userEvent.click(within(card).getByRole('button', { name: '拉取模型列表' }))
    expect((await within(card).findByRole('alert')).textContent).toContain('可以手动添加模型')
    const id = within(card).getByLabelText('模型名称，例如 deepseek-chat')
    const context = within(card).getByLabelText('上下文长度') as HTMLInputElement
    expect(context.value).toBe('128000')
    await userEvent.type(id, 'my-model')
    await userEvent.clear(context)
    await userEvent.type(context, '64k000')
    expect(context.value).toBe('64000')
    await userEvent.click(within(card).getByRole('button', { name: '添加' }))
    expect(within(card).getByText('my-model')).toBeTruthy()
    expect(within(card).getAllByText('64k 上下文').length).toBeGreaterThan(0)
    await userEvent.click(within(card).getByRole('button', { name: '手动添加' }))
    expect(within(card).queryByLabelText('上下文长度')).toBeNull()
  })

  it('shows a failed connection test and deletes a provider after confirming', async () => {
    const { updates } = setup(
      { providers: [deepseek, gateway] },
      {
        'provider.test': () => ({
          ok: false,
          latencyMs: 80,
          error: { code: 'model.auth_failed', params: { status: 401 } },
        }),
      },
    )
    await open()
    const card = editor('DeepSeek')
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    expect((await within(card).findByRole('status')).textContent).toContain(
      '连接失败 · 模型服务拒绝了 Key',
    )
    expect(
      within(screen.getByRole('list', { name: '已配置的供应商' })).getByText('连接失败'),
    ).toBeTruthy()
    // 改动后测试结果失效
    await userEvent.type(within(card).getByLabelText('名称'), '!')
    expect(within(card).getByText('还没有测试连接。')).toBeTruthy()

    await userEvent.click(within(card).getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: '删除 DeepSeek？' })
    await userEvent.click(within(dialog).getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(updates).toEqual([{ providers: [gateway] }]))
    expect(await screen.findByRole('region', { name: '公司网关' })).toBeTruthy()
  })
})
