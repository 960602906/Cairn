// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { RpcError, type ProviderConfig, type Settings, type SettingsPatch } from '@cairn/protocol'
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
    const confirm = screen.getByRole('dialog', { name: '放弃未保存的改动？' })
    await userEvent.click(within(confirm).getByRole('button', { name: '放弃改动' }))
    await waitFor(() => expect(screen.queryAllByRole('dialog', { hidden: true })).toHaveLength(0))
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

  it('tests one model by default and all enabled models only after confirming', async () => {
    const { request } = setup(
      {
        providers: [deepseek],
        defaultModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      },
      { 'provider.test': () => ({ ok: true }) },
    )
    await open()
    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(within(card).getByRole('button', { name: '测试连接' }))
    let bar = (await within(card).findByRole('status')).textContent ?? ''
    expect(bar).toContain('连接正常')
    expect(bar).toContain('deepseek-v4-pro · 0 ms')
    const tested = () => request.mock.calls.filter(([method]) => method === 'provider.test')
    // 默认只测默认模型
    expect(tested().map(([, params]) => (params as { modelId: string }).modelId)).toEqual([
      'deepseek-v4-pro',
    ])

    await userEvent.click(within(card).getByRole('button', { name: '测试全部 2 个' }))
    const confirm = screen.getByRole('dialog', { name: '测试全部 2 个模型？' })
    expect(within(confirm).getByText(/可能消耗额度/)).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(tested()).toHaveLength(1)

    await userEvent.click(within(card).getByRole('button', { name: '测试全部 2 个' }))
    await userEvent.click(
      within(screen.getByRole('dialog', { name: '测试全部 2 个模型？' })).getByRole('button', {
        name: '全部测试',
      }),
    )
    await waitFor(() => expect(tested()).toHaveLength(3))
    bar = (await within(card).findByRole('status')).textContent ?? ''
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

  it('closes a clean editor with Escape and asks before discarding changes', async () => {
    const { updates } = setup({ providers: [gateway] })
    await open()
    await editProvider(/^公司网关/)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑供应商' })).toBeNull())
    expect(screen.queryByRole('dialog', { name: '放弃未保存的改动？' })).toBeNull()

    const card = await editProvider(/^公司网关/)
    await userEvent.type(within(card).getByLabelText('名称'), '!')
    await userEvent.keyboard('{Escape}')
    let confirm = screen.getByRole('dialog', { name: '放弃未保存的改动？' })
    expect(within(confirm).getByText('对这个供应商的改动将会丢失。')).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '放弃未保存的改动？' })).toBeNull(),
    )
    expect((within(card).getByLabelText('名称') as HTMLInputElement).value).toBe('公司网关!')

    // 只填了 Key 也算改动，关闭按钮同样要确认
    await userEvent.click(within(card).getByRole('button', { name: '更换' }))
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-new')
    await userEvent.click(within(card).getByRole('button', { name: '关闭' }))
    confirm = screen.getByRole('dialog', { name: '放弃未保存的改动？' })
    expect(within(confirm).getByText(/刚填写的 API Key/)).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '放弃改动' }))
    await waitFor(() => expect(screen.queryAllByRole('dialog', { hidden: true })).toHaveLength(0))
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
    let bar = (await within(card).findByRole('status')).textContent ?? ''
    expect(bar).toContain('连接失败')
    expect(bar).toContain('deepseek-flash')
    expect(bar).toContain('模型服务拒绝了 Key')
    await userEvent.click(within(card).getByRole('button', { name: '测试全部 2 个' }))
    await userEvent.click(screen.getByRole('button', { name: '全部测试' }))
    await waitFor(async () => {
      bar = (await within(card).findByRole('status')).textContent ?? ''
      expect(bar).toContain('2 / 2 个模型连接失败')
    })
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
    await userEvent.click(screen.getByRole('button', { name: '放弃改动' }))
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

  it('adds a catalog service by pasting only the key (ADR-0049)', async () => {
    const { request, updates } = setup(
      {},
      {
        'provider.models': () => ({
          ok: true,
          models: [{ id: 'moonshot-v1-8k' }, { id: 'kimi-k3' }, { id: 'kimi-k2.5' }],
        }),
      },
    )
    await open()
    const picker = await openAddDialog()
    // 按类别分组，不再按接口格式
    expect(within(picker).getByRole('heading', { name: '模型厂商' })).toBeTruthy()
    expect(within(picker).getByRole('heading', { name: '聚合平台与中转' })).toBeTruthy()
    expect(within(picker).getByRole('heading', { name: '本机运行' })).toBeTruthy()
    await userEvent.click(within(picker).getByRole('button', { name: /^Kimi/ }))
    const card = screen.getByRole('dialog', { name: '新供应商' })

    // 中文界面默认中国大陆站，申请 Key 的链接跟着接入点
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://api.moonshot.cn/v1',
    )
    expect(
      within(card)
        .getByRole('link', { name: /获取 API Key/ })
        .getAttribute('href'),
    ).toBe('https://platform.moonshot.cn/console/api-keys')
    expect(within(card).getByText('OpenAI · 官方')).toBeTruthy()
    const key = within(card).getByLabelText('API Key')
    await waitFor(() => expect(document.activeElement).toBe(key))
    expect(within(card).getByText('填入 API Key 后会自动拉取模型列表。')).toBeTruthy()

    await userEvent.type(key, 'sk-kimi-key-0001')
    // 停止输入后自动拉取，并启用建议的模型
    expect(
      await within(card).findByRole('switch', { name: '启用 kimi-k3' }, { timeout: 3000 }),
    ).toBeTruthy()
    expect(within(card).getByRole('switch', { name: '启用 kimi-k2.5' })).toBeTruthy()
    expect(within(card).getByRole('switch', { name: '添加 moonshot-v1-8k' })).toBeTruthy()
    expect(request.mock.calls.filter(([method]) => method === 'provider.models')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('provider.models', {
      provider: expect.objectContaining({ baseUrl: 'https://api.moonshot.cn/v1' }),
      secret: 'sk-kimi-key-0001',
    })

    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({
      providers: [
        expect.objectContaining({
          id: 'moonshot',
          kind: 'openai',
          displayName: 'Kimi',
          baseUrl: 'https://api.moonshot.cn/v1',
          credentialRef: 'moonshot',
          template: 'moonshot',
          compat: expect.objectContaining({ maxTokensField: 'max_tokens' }),
          models: [
            expect.objectContaining({ id: 'kimi-k3', contextWindow: 262_144 }),
            expect.objectContaining({ id: 'kimi-k2.5' }),
          ],
        }),
      ],
      defaultModel: { providerId: 'moonshot', modelId: 'kimi-k3' },
    })
    // Key 先于设置写入
    const methods = request.mock.calls.map(([method]) => method)
    expect(methods.indexOf('credentials.set')).toBeLessThan(methods.indexOf('settings.update'))
  })

  it('switches a service between its global and China endpoints', async () => {
    setup()
    await open()
    const card = await addService(/^Qwen/)
    const url = within(card).getByLabelText('Base URL') as HTMLInputElement
    expect(url.value).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    const regions = within(card).getByRole('radiogroup', { name: '区域' })
    await userEvent.click(within(regions).getByRole('radio', { name: '国际' }))
    expect(url.value).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
    expect(
      within(card)
        .getByRole('link', { name: /获取 API Key/ })
        .getAttribute('href'),
    ).toBe('https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key')
    expect(within(card).getByText('OpenAI · 官方')).toBeTruthy()
    // 手改地址后不属于任何接入点，来源变为第三方中转
    await userEvent.clear(url)
    await userEvent.type(url, 'https://proxy.example.com/v1')
    expect(within(regions).queryByRole('radio', { checked: true })).toBeNull()
    expect(within(card).getByText('OpenAI · 第三方中转')).toBeTruthy()
  })

  it('adds a local server without a key and enables its installed models', async () => {
    const { request, updates } = setup(
      {},
      {
        'provider.models': () => ({ ok: true, models: [{ id: 'qwen3:8b' }, { id: 'llama4' }] }),
      },
    )
    await open()
    const picker = await openAddDialog()
    const tile = within(picker).getByRole('button', { name: /^Ollama/ })
    expect(within(tile).getByText('免 Key')).toBeTruthy()
    await userEvent.click(tile)
    const card = screen.getByRole('dialog', { name: '新供应商' })
    expect(within(card).getByText(/本机服务通常不需要 Key/)).toBeTruthy()
    expect(await within(card).findByRole('switch', { name: '启用 qwen3:8b' })).toBeTruthy()
    expect(within(card).getByRole('switch', { name: '启用 llama4' })).toBeTruthy()
    expect(request).toHaveBeenCalledWith('provider.models', {
      provider: expect.objectContaining({ baseUrl: 'http://localhost:11434/v1' }),
    })
    // 只有自动拉取，没有用户改动：直接关闭不用确认
    await userEvent.click(within(card).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新供应商' })).toBeNull())

    const again = await addService(/^Ollama/)
    await within(again).findByRole('switch', { name: '启用 qwen3:8b' })
    await userEvent.click(within(again).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    const saved = updates[0]!.providers![0]!
    expect(saved).toMatchObject({ id: 'ollama', template: 'ollama' })
    expect(saved).not.toHaveProperty('credentialRef')
    expect(request).not.toHaveBeenCalledWith('credentials.set', expect.anything())
    expect(within(list()).queryByText('未保存 Key')).toBeNull()
  })

  it('searches the catalog and keeps the custom formats', async () => {
    setup()
    await open()
    const picker = await openAddDialog()
    const search = within(picker).getByLabelText('搜索服务')
    await userEvent.type(search, 'silicon')
    expect(within(picker).getByRole('button', { name: /^SiliconFlow/ })).toBeTruthy()
    expect(within(picker).queryByRole('button', { name: /^DeepSeek/ })).toBeNull()
    await userEvent.clear(search)
    await userEvent.type(search, 'openrouter.ai')
    expect(within(picker).getByRole('button', { name: /^OpenRouter/ })).toBeTruthy()
    await userEvent.clear(search)
    await userEvent.type(search, 'no-such-service')
    expect(within(picker).getByText(/没有匹配的服务/)).toBeTruthy()
    for (const format of ['OpenAI', 'Anthropic', 'Gemini']) {
      expect(
        within(picker).getByRole('button', { name: `自定义 / 第三方中转（${format} 格式）` }),
      ).toBeTruthy()
    }
  })

  it('does not save the provider when the key cannot be saved', async () => {
    const { updates } = setup(
      {},
      {
        'credentials.set': () => {
          throw new Error('keychain locked')
        },
      },
    )
    await open()
    const card = await addService(/^DeepSeek/)
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-deepseek-0001')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    expect((await within(card).findByRole('alert')).textContent).toBe(
      'Key 没有保存成功，所以没有改动任何设置。',
    )
    expect(updates).toEqual([])
    expect(screen.getByRole('dialog', { name: '新供应商' })).toBeTruthy()
  })

  it('rolls back a new key when the settings cannot be saved', async () => {
    const { request } = setup({}, { 'settings.update': () => undefined })
    await open()
    const card = await addService(/^DeepSeek/)
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-deepseek-0001')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    expect((await within(card).findByRole('alert')).textContent).toBe(
      '供应商没有保存成功，没有改动任何设置。',
    )
    expect(request).toHaveBeenCalledWith('credentials.set', {
      ref: 'deepseek',
      secret: 'sk-deepseek-0001',
    })
    expect(request).toHaveBeenCalledWith('credentials.delete', { ref: 'deepseek' })
  })

  it('explains that a replaced key stays when the settings cannot be saved', async () => {
    const { request } = setup({ providers: [deepseek] }, { 'settings.update': () => undefined })
    await open()
    const card = await editProvider(/^DeepSeek/)
    await userEvent.click(await within(card).findByRole('button', { name: '更换' }))
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-replaced-0002')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    expect((await within(card).findByRole('alert')).textContent).toContain(
      '新的 Key 已经替换了原来的 Key',
    )
    expect(request).not.toHaveBeenCalledWith('credentials.delete', expect.anything())
  })

  it('lists plugin services in the catalog and adds one', async () => {
    const plugin = {
      id: 'acme',
      name: 'Acme Cloud',
      version: '1.2.0',
      templates: [
        {
          id: 'acme.gateway',
          kind: 'openai',
          category: 'relay',
          displayName: 'Acme Gateway',
          baseUrl: 'https://api.acme.example/v1',
          requiresKey: true,
          keysUrl: 'https://acme.example/keys',
          compat: { maxTokensField: 'max_tokens' },
          models: [{ id: 'acme-large', ...cap }],
          modelDefaults: cap,
          pluginId: 'acme',
        },
      ],
    }
    const { updates } = setup(
      {},
      { 'providerPlugin.list': () => ({ plugins: [plugin], skipped: [] }) },
    )
    await open()
    const picker = await openAddDialog()
    const tile = within(picker).getByRole('button', { name: /^Acme Gateway/ })
    expect(within(tile).getByText('插件')).toBeTruthy()
    const installed = within(picker).getByRole('list', { name: '已安装的插件' })
    expect(within(installed).getByText('Acme Cloud')).toBeTruthy()
    expect(within(installed).getByText('v1.2.0')).toBeTruthy()
    await userEvent.click(tile)
    const card = screen.getByRole('dialog', { name: '新供应商' })
    expect((within(card).getByLabelText('Base URL') as HTMLInputElement).value).toBe(
      'https://api.acme.example/v1',
    )
    expect(
      within(card)
        .getByRole('link', { name: /获取 API Key/ })
        .getAttribute('href'),
    ).toBe('https://acme.example/keys')
    expect(within(card).getByText('OpenAI · 官方')).toBeTruthy()
    await userEvent.type(within(card).getByLabelText('API Key'), 'sk-acme-0001')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]!.providers![0]).toMatchObject({
      id: 'acme.gateway',
      template: 'acme.gateway',
      credentialRef: 'acme.gateway',
      compat: { maxTokensField: 'max_tokens' },
      models: [expect.objectContaining({ id: 'acme-large' })],
    })
  })

  it('installs a provider plugin after previewing it, and removes it', async () => {
    const plugin = {
      id: 'acme',
      name: 'Acme Cloud',
      templates: [
        {
          id: 'acme.gateway',
          kind: 'openai',
          category: 'relay',
          displayName: 'Acme Gateway',
          baseUrl: 'https://api.acme.example/v1',
          requiresKey: true,
          models: [],
          modelDefaults: cap,
          pluginId: 'acme',
        },
      ],
    }
    let installed = false
    let invalid = true
    const { request } = setup(
      {},
      {
        'providerPlugin.list': () => ({
          plugins: installed ? [plugin] : [],
          skipped: [{ file: 'broken.json', code: 'providers.plugin.invalid' }],
        }),
        'providerPlugin.pick': () => ({ path: '/downloads/acme.json' }),
        'providerPlugin.install': (params: never) => {
          const { confirm } = params as { confirm?: boolean }
          if (invalid) throw new RpcError('providers.plugin.unsupported_version')
          if (confirm) installed = true
          return { installed: confirm === true, replaces: false, plugin }
        },
        'providerPlugin.remove': () => {
          installed = false
          return {}
        },
      },
    )
    await open()
    const picker = await openAddDialog()
    expect(within(picker).getByText(/broken\.json 未能加载/)).toBeTruthy()

    await userEvent.click(within(picker).getByRole('button', { name: '从文件安装…' }))
    expect((await within(picker).findByRole('alert')).textContent).toContain(
      '这个插件需要更新版本的 Cairn',
    )

    invalid = false
    await userEvent.click(within(picker).getByRole('button', { name: '从文件安装…' }))
    let preview = await screen.findByRole('dialog', { name: '安装 Acme Cloud？' })
    await userEvent.click(within(preview).getByRole('button', { name: '取消' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '安装 Acme Cloud？' })).toBeNull(),
    )
    expect(request).not.toHaveBeenCalledWith(
      'providerPlugin.install',
      expect.objectContaining({ confirm: true }),
    )

    await userEvent.click(within(picker).getByRole('button', { name: '从文件安装…' }))
    preview = await screen.findByRole('dialog', { name: '安装 Acme Cloud？' })
    expect(within(preview).getByText('https://api.acme.example/v1')).toBeTruthy()
    expect(within(preview).getByText(/请只安装你信任的插件/)).toBeTruthy()
    expect(request).toHaveBeenCalledWith('providerPlugin.install', { path: '/downloads/acme.json' })
    await userEvent.click(within(preview).getByRole('button', { name: '安装' }))
    expect(request).toHaveBeenCalledWith('providerPlugin.install', {
      path: '/downloads/acme.json',
      confirm: true,
    })
    expect(await within(picker).findByRole('button', { name: /^Acme Gateway/ })).toBeTruthy()

    await userEvent.click(within(picker).getByRole('button', { name: '卸载 Acme Cloud' }))
    const confirm = screen.getByRole('dialog', { name: '卸载 Acme Cloud？' })
    expect(within(confirm).getByText(/仍可使用/)).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '卸载插件' }))
    expect(request).toHaveBeenCalledWith('providerPlugin.remove', { id: 'acme' })
    await waitFor(() =>
      expect(within(picker).queryByRole('button', { name: /^Acme Gateway/ })).toBeNull(),
    )
  })
})
