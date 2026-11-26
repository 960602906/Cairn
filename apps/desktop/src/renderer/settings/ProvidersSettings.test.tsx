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
        }
        if (patch.defaultModel === null) delete next.defaultModel
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

async function openAddDialog() {
  await userEvent.click(screen.getAllByRole('button', { name: '添加供应商' })[0]!)
  return screen.getByRole('dialog', { name: '接入哪个服务？' })
}

async function addService(name: string | RegExp) {
  const picker = await openAddDialog()
  await userEvent.click(within(picker).getByRole('button', { name }))
  return screen.getByRole('dialog', { name: '新供应商' })
}

async function addCustomProvider(format: 'Anthropic' | 'OpenAI' | 'Gemini') {
  return addService(`自定义 / 第三方中转（${format} 格式）`)
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

    const card = await addCustomProvider('OpenAI')
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe('')
    expect(within(card).getByText('OpenAI · 第三方中转')).toBeTruthy()
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
    const card = await addCustomProvider('OpenAI')
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
    })
    await open()
    await userEvent.click(screen.getByRole('tab', { name: /Anthropic/ }))
    expect(providerButtons()).toHaveLength(2)

    const gwRow = providerButtons().find((row) => within(row).queryByText('公司网关'))!
    await userEvent.click(within(gwRow).getByRole('button', { name: '删除' }))
    const firstDialog = await screen.findByRole('dialog', { name: '删除 公司网关？' })
    await userEvent.click(within(firstDialog).getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({ providers: [deepseek, third] })
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

  it('switches provider formats with arrow keys, Home, and End', async () => {
    setup({ providers: [deepseek, gateway] })
    await open()
    const anthropic = screen.getByRole('tab', { name: /Anthropic/ })
    const openai = screen.getByRole('tab', { name: /OpenAI/ })
    const gemini = screen.getByRole('tab', { name: /Gemini/ })
    await userEvent.click(anthropic)
    expect(anthropic.getAttribute('aria-selected')).toBe('true')

    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(openai)
    expect(openai.getAttribute('aria-selected')).toBe('true')

    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(gemini)
    expect(gemini.getAttribute('aria-selected')).toBe('true')

    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(anthropic)
    expect(anthropic.getAttribute('aria-selected')).toBe('true')

    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(anthropic)
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
    await userEvent.click(within(card).getByRole('button', { name: '设为默认' }))
    const context = within(card).getByLabelText('上下文长度') as HTMLInputElement
    await userEvent.clear(context)
    await userEvent.type(context, '200000')
    await userEvent.tab()
    await userEvent.click(within(card).getByRole('button', { name: '更多设置' }))
    await userEvent.click(within(card).getByRole('switch', { name: '支持工具调用' }))

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
    const card = await addCustomProvider('Gemini')
    expect(within(card).getByText('Gemini · 第三方中转')).toBeTruthy()
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

  it('adds an official service with its template prefilled', async () => {
    const { updates, settings } = setup()
    await open()
    const card = await addService(/^DeepSeek/)

    expect((within(card).getByLabelText('名称') as HTMLInputElement).value).toBe('DeepSeek')
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://api.deepseek.com',
    )
    expect(within(card).getByText('OpenAI · 官方')).toBeTruthy()
    expect(within(card).getAllByText('deepseek-flash').length).toBeGreaterThan(0)
    expect(within(card).getAllByText('deepseek-v4-pro').length).toBeGreaterThan(0)

    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({
      providers: [
        expect.objectContaining({
          id: 'deepseek',
          kind: 'openai',
          displayName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          credentialRef: 'deepseek',
          template: 'deepseek',
          compat: expect.objectContaining({
            thinkingFormat: 'deepseek',
            maxTokensField: 'max_tokens',
          }),
          models: [
            expect.objectContaining({ id: 'deepseek-flash' }),
            expect.objectContaining({ id: 'deepseek-v4-pro' }),
          ],
        }),
      ],
      defaultModel: { providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    expect(settings().providers[0]?.template).toBe('deepseek')
    expect(within(list()).getByText('DeepSeek')).toBeTruthy()
  })

  it('opens the editor from a service row with Enter, without a confirm step', async () => {
    setup()
    await open()
    const picker = await openAddDialog()
    expect(within(picker).queryByRole('button', { name: '下一步' })).toBeNull()
    within(picker)
      .getByRole('button', { name: /^Anthropic/ })
      .focus()
    await userEvent.keyboard('{Enter}')

    const card = screen.getByRole('dialog', { name: '新供应商' })
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://api.anthropic.com',
    )
    expect(within(card).getByText('Anthropic · 官方')).toBeTruthy()
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

  it('fetches the model list into one list, caches it and falls back to manual adding', async () => {
    let fail = false
    const { request, updates } = setup(
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
    // 拉取到的模型和已配置的模型合并在同一个列表里
    expect(await within(card).findByText('Claude Y')).toBeTruthy()
    expect(within(card).getAllByText('200k').length).toBeGreaterThan(0)
    expect(within(card).getByText('已启用 1 / 4 个模型')).toBeTruthy()
    // 拉取结果立刻保存为缓存，下次打开不用重新拉取
    await waitFor(() => expect(updates.at(-1)?.providers?.[0]?.catalog).toHaveLength(4))
    await userEvent.click(within(card).getByRole('switch', { name: '添加 Claude Y' }))
    expect(within(card).getByText('已启用 2 / 4 个模型')).toBeTruthy()
    await userEvent.click(within(card).getByRole('switch', { name: '添加 claude-z' }))
    await userEvent.click(within(card).getByRole('switch', { name: '添加 claude-w' }))
    expect(within(card).getByText('已启用 4 / 4 个模型')).toBeTruthy()
    await userEvent.click(within(card).getByRole('button', { name: /claude-w/ }))
    await userEvent.click(within(card).getByRole('button', { name: '删除 claude-w' }))
    expect(within(card).queryByText('claude-w')).toBeNull()
    expect(within(card).getByText('已启用 3 / 3 个模型')).toBeTruthy()

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

  it('shows a cached model list and opens a fetched model by its row', async () => {
    const cached: ProviderConfig = {
      ...gateway,
      catalog: [{ id: 'claude-y', displayName: 'Claude Y', contextWindow: 200_000 }],
    }
    const { request } = setup({ providers: [cached] })
    await open()
    const card = await editProvider(/^公司网关/)
    // 上次拉取的结果直接显示，不用再请求一次
    expect(within(card).getByText('Claude Y')).toBeTruthy()
    expect(request).not.toHaveBeenCalledWith('provider.models', expect.anything())
    expect(within(card).getByText('已启用 1 / 2 个模型')).toBeTruthy()

    await userEvent.click(within(card).getByRole('button', { name: /claude-y/ }))
    expect(within(card).getByText('已启用 2 / 2 个模型')).toBeTruthy()
    expect(within(card).getByLabelText('上下文长度')).toBeTruthy()
  })

  it('summarizes a successful multi-model test without a latency', async () => {
    setup({ providers: [deepseek] }, { 'provider.test': () => ({ ok: true }) })
    await open()
    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    const bar = (await within(card).findByRole('status')).textContent ?? ''
    expect(bar).toContain('2 个模型连接正常')
    expect(bar).toContain('0 ms')
  })

  it('reports a single failed model', async () => {
    setup(
      { providers: [gateway] },
      {
        'provider.test': () => ({
          ok: false,
          latencyMs: 30,
          error: { code: 'provider.network' },
        }),
      },
    )
    await open()
    const card = await editProvider(/^公司网关/)
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    const bar = (await within(card).findByRole('status')).textContent ?? ''
    expect(bar).toContain('连接失败')
    expect(bar).toContain('claude-x')
  })

  it('closes the editor with Escape without saving', async () => {
    const { updates } = setup({ providers: [gateway] })
    await open()
    const card = await editProvider(/^公司网关/)
    await userEvent.type(within(card).getByLabelText('名称'), '!')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑供应商' })).toBeNull())
    expect(updates).toEqual([])
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
    const bar = (await within(card).findByRole('status')).textContent ?? ''
    expect(bar).toContain('2 / 2 个模型连接失败')
    expect(bar).toContain('模型服务拒绝了 Key')
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
    expect(screen.getByRole('dialog', { name: '接入哪个服务？' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '接入哪个服务？' })).toBeNull())

    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: /deepseek-v4-pro/ }))
    await userEvent.click(within(card).getByRole('button', { name: '更多设置' }))
    await userEvent.type(within(card).getByLabelText('显示名称'), 'Pro')
    await userEvent.click(within(card).getByRole('switch', { name: '并行工具调用' }))
    await userEvent.click(within(card).getByRole('switch', { name: '支持思考' }))
    expect(within(card).getAllByText('Pro').length).toBeGreaterThan(0)
    const context = within(card).getByLabelText('上下文长度') as HTMLInputElement
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

  it('picks a thinking level for models that support reasoning', async () => {
    const { updates } = setup({ providers: [deepseek, gateway] })
    await open()
    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: /deepseek-v4-pro/ }))
    await userEvent.click(within(card).getByRole('button', { name: '更多设置' }))
    // 不支持思考的模型没有档位可选
    expect(within(card).queryByRole('radiogroup', { name: '思考强度' })).toBeNull()

    await userEvent.click(within(card).getByRole('switch', { name: '支持思考' }))
    const group = within(card).getByRole('radiogroup', { name: '思考强度' })
    expect(within(group).getByRole('radio', { name: '高' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    await userEvent.click(within(group).getByRole('radio', { name: '中' }))
    expect(within(group).getByRole('radio', { name: '中' }).getAttribute('aria-checked')).toBe(
      'true',
    )

    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates.length).toBeGreaterThan(0))
    const saved = updates.at(-1)?.providers?.find((p) => p.id === 'deepseek')
    expect(saved?.models.find((m) => m.id === 'deepseek-v4-pro')).toMatchObject({
      supportsReasoning: true,
      thinkingLevel: 'medium',
    })
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

  it.each([
    ['system-encryption-unavailable', '本机的系统加密不可用，无法保存 Key。'],
    [
      'insecure-linux-backend',
      '未检测到系统密钥环，Key 无法安全保存。请安装并解锁 GNOME Keyring 或 KWallet，然后重启 Cairn。',
    ],
    ['unknown-linux-backend', '无法确认本机的系统密钥环，Key 不能安全保存。'],
  ] as const)('explains why keys cannot be saved: %s (M6-04)', async (reason, hint) => {
    setup(
      { providers: [deepseek] },
      { 'credentials.status': () => ({ configured: false, available: false, reason }) },
    )
    await open()
    const card = await editProvider(/^DeepSeek/)
    await waitFor(() => expect(within(card).getByText(hint)).toBeTruthy())
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
