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
        const next: Settings = {
          ...settings,
          ...(patch.providers ? { providers: patch.providers } : {}),
          ...(patch.defaultModel ? { defaultModel: patch.defaultModel } : {}),
          ...(patch.auxiliaryModel ? { auxiliaryModel: patch.auxiliaryModel } : {}),
        }
        if (patch.defaultModel === null) delete next.defaultModel
        if (patch.auxiliaryModel === null) delete next.auxiliaryModel
        settings = next
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
      case 'settings.shell':
        return { detected: 'pwsh', options: ['auto', 'cmd'] }
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
  await userEvent.click(await screen.findByRole('button', { name: '设置' }))
  const nav = await screen.findByRole('navigation', { name: '设置分类' })
  await userEvent.click(within(nav).getByRole('button', { name: /^模型供应商/ }))
  return screen.findByRole('heading', { name: '模型供应商' })
}

const list = () => screen.getByRole('list', { name: '已配置的供应商' })
const providerButtons = () => within(list()).getAllByRole('listitem')

async function createProvider(format: 'Anthropic' | 'OpenAI' | 'Gemini') {
  await userEvent.click(screen.getAllByRole('button', { name: '添加供应商' })[0]!)
  const picker = screen.getByRole('dialog', { name: '选择接口格式' })
  await userEvent.click(within(picker).getByRole('radio', { name: new RegExp(`^${format}`) }))
  await userEvent.click(within(picker).getByRole('button', { name: '下一步' }))
  return screen.getByRole('dialog', { name: '新供应商' })
}

async function editProvider(name: RegExp) {
  await userEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('dialog', { name: '编辑供应商' })
}

describe('ProvidersSettings', () => {
  it('adds the first provider from the service picker with its key', async () => {
    const { request, updates } = setup(
      {},
      { 'provider.test': () => ({ ok: true, latencyMs: 312 }) },
    )
    await open()
    expect(screen.getByText('这个接口格式还没有供应商。')).toBeTruthy()

    const card = await createProvider('OpenAI')
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe('')
    expect(within(card).getByText('OpenAI · 兼容')).toBeTruthy()
    await userEvent.clear(within(card).getByLabelText('名称'))
    await userEvent.type(within(card).getByLabelText('名称'), 'DeepSeek')
    await userEvent.type(within(card).getByLabelText('Base URL'), 'https://api.deepseek.com')
    await userEvent.click(within(card).getByRole('button', { name: '手动添加' }))
    await userEvent.type(
      within(card).getByLabelText('模型名称，例如 deepseek-chat'),
      'deepseek-flash',
    )
    await userEvent.click(within(card).getByRole('button', { name: '添加' }))
    await userEvent.type(within(card).getByLabelText('API Key'), ' sk-new-key-1234 ')
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(await within(card).findByText(/312 ms/)).toBeTruthy()
    expect(request).toHaveBeenCalledWith('provider.test', {
      provider: expect.objectContaining({ id: 'deepseek' }),
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
    expect(within(list()).getByText('正常')).toBeTruthy()
    const savedCard = await editProvider(/^DeepSeek/)
    expect(await within(savedCard).findByText('••••••••1234')).toBeTruthy()
  })

  it('adds a second provider without replacing the first', async () => {
    const { updates, settings } = setup({ providers: [deepseek] })
    await open()
    const card = await createProvider('OpenAI')
    expect((within(card).getByLabelText('名称') as HTMLInputElement).value).toBe('自定义供应商')
    await userEvent.type(within(card).getByLabelText('Base URL'), 'https://relay.example.com/v1')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(settings().providers.map((provider) => provider.id)).toEqual(['deepseek', 'custom'])
    expect(providerButtons()).toHaveLength(2)
    expect(within(list()).getByText('自定义供应商')).toBeTruthy()
  })

  it('deletes providers per format and clears only the references they own', async () => {
    const third: ProviderConfig = {
      ...gateway,
      id: 'gw-2',
      displayName: '公司网关 2',
      credentialRef: 'gw-2',
      models: [{ ...gateway.models[0]!, id: 'claude-y' }],
    }
    const { updates } = setup({
      providers: [deepseek, gateway, third],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
      auxiliaryModel: { providerId: 'gw', modelId: 'claude-x' },
    })
    await open()
    await userEvent.click(screen.getByRole('tab', { name: /Anthropic/ }))
    expect(providerButtons()).toHaveLength(2)

    const gwRow = providerButtons().find((row) => within(row).queryByText('公司网关'))!
    await userEvent.click(within(gwRow).getByRole('button', { name: '删除' }))
    const firstDialog = await screen.findByRole('dialog', { name: '删除 公司网关？' })
    await userEvent.click(within(firstDialog).getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({ providers: [deepseek, third], auxiliaryModel: null })
    expect(providerButtons()).toHaveLength(1)

    await userEvent.click(screen.getByRole('tab', { name: /OpenAI/ }))
    const dsRow = providerButtons()[0]!
    await userEvent.click(within(dsRow).getByRole('button', { name: '删除' }))
    const secondDialog = await screen.findByRole('dialog', { name: '删除 DeepSeek？' })
    await userEvent.click(within(secondDialog).getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(updates).toHaveLength(2))
    expect(updates[1]).toEqual({ providers: [third], defaultModel: null })
    expect(screen.getByText('这个接口格式还没有供应商。')).toBeTruthy()
  })

  it('edits a model, changes the default and replaces the key', async () => {
    const { updates, request } = setup({
      providers: [deepseek],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    await open()
    const card = await editProvider(/^DeepSeek/)
    const save = within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    expect(
      (within(card).getByRole('switch', { name: '启用 DeepSeek V4.1 Flash' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await userEvent.click(within(card).getByRole('switch', { name: '启用 deepseek-v4-pro' }))
    expect(save.disabled).toBe(false)

    await userEvent.click(within(card).getByRole('button', { name: /deepseek-v4-pro/ }))
    const detail = within(card).getByRole('complementary', { name: '模型设置' })
    await userEvent.click(within(detail).getByRole('button', { name: '设为默认' }))
    const context = within(detail).getByLabelText('上下文长度') as HTMLInputElement
    await userEvent.clear(context)
    await userEvent.type(context, '200000')
    await userEvent.tab()
    await userEvent.click(within(detail).getByRole('switch', { name: '支持工具调用' }))

    await userEvent.click(within(card).getByRole('button', { name: '更换' }))
    await userEvent.click(within(card).getByRole('button', { name: '保留原来的' }))
    await userEvent.click(within(card).getByRole('button', { name: '更换' }))
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-replaced-9999')
    await userEvent.click(within(card).getByRole('switch', { name: '启用 DeepSeek V4.1 Flash' }))
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
            expect.objectContaining({
              id: 'deepseek-v4-pro',
              contextWindow: 200_000,
              supportsTools: false,
            }),
          ],
        }),
      ],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    })
    expect(request).toHaveBeenCalledWith('credentials.set', {
      ref: 'deepseek',
      secret: 'sk-replaced-9999',
    })
    expect((within(list()).getByText('DS') as HTMLElement).textContent).toBe('DS')
  })

  it('creates a custom relay from any format and validates the address', async () => {
    setup({ providers: [deepseek] })
    await open()
    const card = await createProvider('Gemini')
    expect(within(card).getByText('Gemini · 兼容')).toBeTruthy()
    const url = within(card).getByLabelText('Base URL') as HTMLInputElement
    expect(url.value).toBe('')
    const save = within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(url, 'ftp://x')
    expect(within(card).getByText(/地址需要以 http/)).toBeTruthy()
    await userEvent.clear(url)
    await userEvent.type(url, 'http://127.0.0.1:3425/v1beta')
    expect(save.disabled).toBe(false)

    await userEvent.click(within(card).getByRole('button', { name: /高级/ }))
    expect(within(card).getByText('这种接口格式没有需要调整的兼容参数。')).toBeTruthy()
    await userEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '新供应商' })).toBeNull()
  })

  it('creates a provider by double-clicking an interface format', async () => {
    setup()
    await open()
    await userEvent.click(screen.getAllByRole('button', { name: '添加供应商' })[0]!)
    const picker = screen.getByRole('dialog', { name: '选择接口格式' })
    await userEvent.dblClick(within(picker).getByRole('radio', { name: /^OpenAI/ }))
    expect(screen.getByRole('dialog', { name: '新供应商' })).toBeTruthy()
  })

  it('advances the compatibility parameters for OpenAI relays', async () => {
    const { updates } = setup({ providers: [deepseek] })
    await open()
    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: /高级/ }))
    expect((within(card).getByLabelText('思考参数格式') as HTMLSelectElement).value).toBe(
      'deepseek',
    )
    await userEvent.selectOptions(within(card).getByLabelText('思考参数格式'), 'qwen')
    await userEvent.selectOptions(within(card).getByLabelText('输出上限字段'), 'max_tokens')
    const reasoning = within(card).getByRole('radiogroup', { name: '回传推理内容' })
    await userEvent.click(within(reasoning).getByRole('radio', { name: '是' }))
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({
      providers: [
        expect.objectContaining({
          compat: {
            thinkingFormat: 'qwen',
            maxTokensField: 'max_tokens',
            requiresReasoningContentOnAssistantMessages: true,
          },
        }),
      ],
    })
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
    const card = await editProvider(/^公司网关/)
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
    await userEvent.click(within(card).getByRole('button', { name: /claude-w/ }))
    await userEvent.click(
      within(within(card).getByRole('complementary', { name: '模型设置' })).getByRole('button', {
        name: '删除 claude-w',
      }),
    )
    expect(within(card).queryByText('claude-w')).toBeNull()

    fail = true
    await userEvent.click(within(card).getByRole('button', { name: '拉取模型列表' }))
    expect((await within(card).findByRole('alert')).textContent).toContain('可以手动添加模型')
    const id = within(card).getByLabelText('模型名称，例如 deepseek-chat')
    const context = within(card).getAllByLabelText('上下文长度')[0] as HTMLInputElement
    expect(context.value).toBe('128000')
    await userEvent.type(id, 'my-model')
    await userEvent.clear(context)
    await userEvent.type(context, '64k000')
    expect(context.value).toBe('64000')
    await userEvent.click(within(card).getByRole('button', { name: '添加' }))
    expect(within(card).getByText('my-model')).toBeTruthy()
  })

  it('shows a failed connection test and deletes the provider', async () => {
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
    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    expect((await within(card).findByRole('status')).textContent).toContain(
      '连接失败 · 模型服务拒绝了 Key',
    )
    await userEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(within(list()).getByText('连接失败')).toBeTruthy()
    const reopened = await editProvider(/^DeepSeek/)
    await userEvent.type(within(reopened).getByLabelText('名称'), '!')
    expect(within(reopened).getByText('还没有测试连接。')).toBeTruthy()

    await userEvent.click(within(reopened).getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: '删除 DeepSeek？' })
    await userEvent.click(within(dialog).getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(updates).toEqual([{ providers: [gateway] }]))
    expect(screen.queryByRole('dialog', { name: '编辑供应商' })).toBeNull()
  })

  it('only offers enabled models as the auxiliary model', async () => {
    const withDisabled: ProviderConfig = {
      ...gateway,
      models: [...gateway.models, { id: 'claude-hidden', ...cap, enabled: false }],
    }
    const { updates } = setup({
      providers: [deepseek, withDisabled],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
      auxiliaryModel: { providerId: 'gw', modelId: 'claude-x' },
    })
    await open()
    const select = screen.getByLabelText('辅助模型') as HTMLSelectElement
    expect(select.value).toBe(JSON.stringify(['gw', 'claude-x']))
    expect(screen.getByRole('option', { name: '与主模型相同' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'DeepSeek · DeepSeek V4.1 Flash' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /claude-hidden/ })).toBeNull()

    await userEvent.selectOptions(select, JSON.stringify(['deepseek', 'deepseek-v4-pro']))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({
      auxiliaryModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    })

    await userEvent.selectOptions(select, '')
    await waitFor(() => expect(updates).toHaveLength(2))
    expect(updates[1]).toEqual({ auxiliaryModel: null })
  })

  it('handles an empty provider and missing model list', async () => {
    const empty: ProviderConfig = {
      id: 'empty',
      kind: 'openai',
      displayName: 'Empty',
      baseUrl: 'https://empty.example.com',
      models: [],
    }
    setup(
      { providers: [deepseek, empty] },
      { 'provider.models': () => undefined, 'provider.test': () => ({ ok: true, latencyMs: 5 }) },
    )
    await open()
    const card = await editProvider(/^Empty/)
    expect(within(card).getByText(/还没有模型/)).toBeTruthy()
    expect(
      (within(card).getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.click(within(card).getByRole('button', { name: '拉取模型列表' }))
    expect(within(card).queryByRole('list', { name: '拉取到的模型' })).toBeNull()
    await userEvent.click(within(card).getByRole('button', { name: /高级/ }))
    await userEvent.selectOptions(within(card).getByLabelText('思考参数格式'), 'qwen')
    expect((within(card).getByLabelText('思考参数格式') as HTMLSelectElement).value).toBe('qwen')
  })

  it('shows a missing URL, filters models and applies a compatibility preset', async () => {
    const noUrl: ProviderConfig = {
      id: 'nourl',
      kind: 'openai',
      displayName: 'No URL',
      baseUrl: '',
      models: [{ id: 'local-model', ...cap }],
    }
    setup({ providers: [deepseek, noUrl] })
    await open()
    expect(within(list()).getByText('未填写地址')).toBeTruthy()

    let card = await editProvider(/^No URL/)
    const search = within(card).getByLabelText('搜索模型')
    await userEvent.type(search, 'not-here')
    expect(within(card).getByText('没有匹配的模型。')).toBeTruthy()
    await userEvent.clear(search)
    expect(within(card).getAllByText('local-model').length).toBeGreaterThan(0)
    await userEvent.click(within(card).getByRole('button', { name: '取消' }))

    card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: /高级/ }))
    const preset = within(card).getByLabelText('兼容服务（可选）') as HTMLSelectElement
    await userEvent.selectOptions(preset, 'openai')
    expect(preset.value).toBe('openai')
  })

  it('closes dialogs with Escape and edits model names and capabilities', async () => {
    setup({ providers: [deepseek, gateway] })
    await open()
    await userEvent.click(screen.getAllByRole('button', { name: '添加供应商' })[0]!)
    expect(screen.getByRole('dialog', { name: '选择接口格式' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择接口格式' })).toBeNull())

    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: /deepseek-v4-pro/ }))
    const detail = within(card).getByRole('complementary', { name: '模型设置' })
    await userEvent.type(within(detail).getByLabelText('显示名称'), 'Pro')
    await userEvent.click(within(detail).getByRole('switch', { name: '并行工具调用' }))
    await userEvent.click(within(detail).getByRole('switch', { name: '支持思考' }))
    expect(within(card).getAllByText('Pro').length).toBeGreaterThan(0)
    const context = within(detail).getByLabelText('上下文长度') as HTMLInputElement
    await userEvent.clear(context)
    await userEvent.type(context, '0{Enter}')
    expect(context.value).toBe('1000000')
    await userEvent.clear(context)
    await userEvent.type(context, '200000{Enter}')
    expect(context.value).toBe('200000')

    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await userEvent.click(screen.getByRole('tab', { name: /Anthropic/ }))
    const gatewayCard = await editProvider(/^公司网关/)
    await userEvent.click(within(gatewayCard).getByRole('button', { name: '手动添加' }))
    await userEvent.type(
      within(gatewayCard).getByLabelText('模型名称，例如 deepseek-chat'),
      'manual-by-enter',
    )
    await userEvent.click(within(gatewayCard).getByRole('button', { name: '添加' }))
    expect(within(gatewayCard).getByText('manual-by-enter')).toBeTruthy()
  })

  it('disables the key input when system encryption is unavailable', async () => {
    setup(
      { providers: [deepseek] },
      { 'credentials.status': () => ({ configured: false, available: false }) },
    )
    await open()
    const card = await editProvider(/^DeepSeek/)
    const key = (await within(card).findByLabelText('API Key')) as HTMLInputElement
    await waitFor(() => expect(key.disabled).toBe(true))
    expect(within(card).getByText('系统加密不可用，无法保存 Key。')).toBeTruthy()
  })

  it('keeps the editor open when saving fails and when the key status is missing', async () => {
    setup(
      { providers: [deepseek] },
      {
        'settings.update': () => undefined,
        'credentials.status': () => undefined,
      },
    )
    await open()
    const card = await editProvider(/^DeepSeek/)
    await userEvent.type(within(card).getByLabelText('名称'), '!')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '编辑供应商' })).toBeTruthy())
    expect(within(card).getByLabelText('API Key')).toBeTruthy()
  })
})
