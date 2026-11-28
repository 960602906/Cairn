// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import type { ProviderConfig } from '@cairn/protocol'
import { buildModelPickerRows, MODEL_PICKER_VIRTUALIZE_AFTER, ModelPicker } from './ModelPicker.js'
import { enabledModelChoices } from './model-labels.js'
import { RECENT_MODELS_KEY, rememberRecentModel } from './recent-models.js'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
}

/** ~36 启用模型 + 每供应商一个停用：跨 openai / anthropic / gemini，用来压长列表行为。 */
function largeProviderFixture(): ProviderConfig[] {
  const kinds = ['openai', 'anthropic', 'gemini'] as const
  return kinds.map((kind) => ({
    id: `prov-${kind}`,
    kind,
    displayName: `供应商${kind}`,
    baseUrl: `https://${kind}.example`,
    models: [
      ...Array.from({ length: 12 }, (_, m) => ({
        id: `${kind}-m${m}`,
        displayName: `${kind.toUpperCase()} 模型 ${m}`,
        ...capabilities,
        ...(m === 0 ? { supportsReasoning: true, contextWindow: 200_000 } : {}),
        ...(m === 1 ? { supportsTools: false } : {}),
      })),
      {
        id: `${kind}-off`,
        displayName: `${kind} 停用`,
        enabled: false,
        ...capabilities,
      },
    ],
  }))
}

const providers: ProviderConfig[] = [
  {
    id: 'p1',
    kind: 'openai',
    displayName: '供应商一',
    baseUrl: 'https://example.com',
    models: [
      { id: 'fast', ...capabilities },
      { id: 'off', displayName: '停用模型', enabled: false, ...capabilities },
      {
        id: 'think',
        displayName: '思考',
        ...capabilities,
        supportsReasoning: true,
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'p2',
    kind: 'anthropic',
    displayName: '供应商二',
    baseUrl: 'https://example.com',
    models: [{ id: 'strong', displayName: '强', ...capabilities, supportsTools: false }],
  },
]

const fast = { providerId: 'p1', modelId: 'fast' }
const strong = { providerId: 'p2', modelId: 'strong' }
const think = { providerId: 'p1', modelId: 'think' }

describe('buildModelPickerRows', () => {
  it('groups by provider, omits disabled models, and lifts recents without double-listing', () => {
    const choices = enabledModelChoices(providers)
    expect(choices.map((c) => c.name)).toEqual(['fast', '思考', '强'])

    const { rows, options } = buildModelPickerRows(choices, [strong, fast], '', '最近使用')
    expect(options.map((o) => o.name)).toEqual(['强', 'fast', '思考'])
    expect(rows.filter((r) => r.kind === 'header').map((r) => r.label)).toEqual([
      '最近使用',
      '供应商一',
    ])
    // 最近里的强与 fast 不再出现在供应商分组。
    expect(
      rows
        .filter((r) => r.kind === 'option')
        .map((r) => (r.kind === 'option' ? r.choice.name : '')),
    ).toEqual(['强', 'fast', '思考'])
    expect(rows.find((r) => r.kind === 'header' && r.key === 'provider:p2')).toBeUndefined()
    const p1 = rows.find((r) => r.kind === 'header' && r.key === 'provider:p1')
    expect(p1?.kind === 'header' ? p1.protocol : undefined).toBe('openai')
  })

  it('filters by display name, model id, and provider name', () => {
    const choices = enabledModelChoices(providers)
    expect(
      buildModelPickerRows(choices, [strong], '强', '最近').options.map((o) => o.name),
    ).toEqual(['强'])
    expect(
      buildModelPickerRows(choices, [], 'fast', '最近').options.map((o) => o.ref.modelId),
    ).toEqual(['fast'])
    expect(
      buildModelPickerRows(choices, [], '供应商二', '最近').options.map((o) => o.name),
    ).toEqual(['强'])
    expect(buildModelPickerRows(choices, [strong], '没有', '最近').options).toEqual([])
  })
})

describe('ModelPicker', () => {
  it('shows only the short model name on the trigger', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={strong}
          fixed={false}
          disabled={false}
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    const trigger = screen.getByRole('button', { name: '模型：供应商二 · 强' })
    expect(trigger.textContent).toContain('强')
    expect(trigger.textContent).not.toContain('供应商二')
  })

  it('marks a fixed model', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed
          disabled={false}
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
          align="start"
        />
      </I18nextProvider>,
    )
    const trigger = screen.getByRole('button', { name: '模型：供应商一 · fast' })
    expect(trigger.getAttribute('title')).toBe('由 Agent 固定')
    expect(trigger.textContent).toContain('fast')
    expect(trigger.textContent).not.toContain('供应商一')
  })

  it('omits disabled models and still labels the current one', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.queryByRole('option', { name: /停用模型/ })).toBeNull()
    expect(screen.getByRole('option', { name: /^fast/ })).toBeTruthy()
    await user.type(screen.getByRole('combobox', { name: '搜索模型' }), '停用')
    expect(screen.getByText('没有匹配的模型')).toBeTruthy()
  })

  it('only emits a change for a different selection and records recents', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={onSelect}
        />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('option', { name: /^fast/ }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) ?? '[]')).toEqual([fast])

    cleanup()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={onSelect}
        />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('option', { name: /强/ }))
    expect(onSelect).toHaveBeenCalledWith(strong)
    expect(JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) ?? '[]')).toEqual([
      strong,
      fast,
    ])
  })

  it('shows a recent section and provider protocol icons', async () => {
    rememberRecentModel(strong)
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.getByText('最近使用')).toBeTruthy()
    expect(screen.getByText('供应商一')).toBeTruthy()
    // 最近里的强不在供应商二分组重复列出。
    expect(screen.queryByText('供应商二')).toBeNull()
    const list = screen.getByRole('listbox', { name: '下一轮使用的模型' })
    expect(
      within(list)
        .getAllByRole('option')
        .map((el) => el.textContent),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('强'), expect.stringContaining('fast')]),
    )
  })

  it('lands on the current model so Enter does not switch away', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    function PickerHarness() {
      const [open, setOpen] = useState(false)
      return (
        <ModelPicker
          providers={providers}
          model={strong}
          fixed={false}
          disabled={false}
          open={open}
          onOpenChange={setOpen}
          onSelect={onSelect}
        />
      )
    }
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <PickerHarness />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: '模型：供应商二 · 强' }))
    const search = await screen.findByRole('combobox', { name: '搜索模型' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    const current = screen.getByRole('option', { name: /强/ })
    expect(current.getAttribute('data-active')).toBe('true')
    await user.keyboard('{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('pins thinking level at the bottom and hides it without a session', async () => {
    const user = userEvent.setup()
    const onSelectThinkingLevel = vi.fn()
    const reasoning: ProviderConfig[] = [
      {
        id: 'p2',
        kind: 'openai',
        displayName: '供应商二',
        baseUrl: 'https://example.com',
        models: [{ id: 'strong', displayName: '强', ...capabilities, supportsReasoning: true }],
      },
    ]
    const { rerender } = render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={reasoning}
          model={strong}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
          thinkingLevel="low"
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nextProvider>,
    )
    expect(screen.getByText('思考强度')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '高' }))
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('high')

    rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
          onSelectThinkingLevel={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.getByText('思考强度')).toBeTruthy()
    expect(screen.getByText('当前模型不支持推理')).toBeTruthy()

    rerender(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.queryByText('思考强度')).toBeNull()
  })

  it('shows quiet capability chips from the model profile', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={think}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    const row = screen.getByRole('option', { name: /思考/ })
    expect(within(row).getByText('1M')).toBeTruthy()
    expect(within(row).getByTitle('思考')).toBeTruthy()
    expect(within(row).getByTitle('工具')).toBeTruthy()

    const plain = screen.getByRole('option', { name: /强/ })
    expect(within(plain).getByText('100k')).toBeTruthy()
    expect(within(plain).queryByTitle('工具')).toBeNull()
    expect(within(plain).queryByTitle('思考')).toBeNull()
  })

  it('shows the empty label when no model is configured', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={[]}
          model={undefined}
          fixed={false}
          disabled
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nextProvider>,
    )
    const trigger = screen.getByRole('button', { name: '模型：未配置模型' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('title')).toBeNull()
    expect(trigger.textContent).toContain('未配置模型')
  })

  it('navigates with the keyboard and returns focus on Escape', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const returnFocus = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open={open}
          onOpenChange={setOpen}
          onSelect={onSelect}
          returnFocus={returnFocus}
        />
      )
    }
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <Harness />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: '模型：供应商一 · fast' }))
    const search = await screen.findByRole('combobox', { name: '搜索模型' })
    await waitFor(() => expect(document.activeElement).toBe(search))

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /思考/ }).getAttribute('data-active')).toBe('true')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('option', { name: /^fast/ }).getAttribute('data-active')).toBe('true')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('option', { name: /强/ }).getAttribute('data-active')).toBe('true')
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(strong)
    await waitFor(() => expect(returnFocus).toHaveBeenCalled())

    cleanup()
    const onOpenChange = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={onOpenChange}
          onSelect={() => {}}
          returnFocus={returnFocus}
        />
      </I18nextProvider>,
    )
    await screen.findByRole('combobox', { name: '搜索模型' })
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('virtualizes long lists and keeps arrow navigation working', async () => {
    const user = userEvent.setup()
    const many: ProviderConfig[] = Array.from({ length: 3 }, (_, p) => ({
      id: `prov-${p}`,
      kind: (['openai', 'anthropic', 'gemini'] as const)[p]!,
      displayName: `供应商${p}`,
      baseUrl: 'https://example.com',
      models: Array.from({ length: 8 }, (_, m) => ({
        id: `m${p}-${m}`,
        displayName: `模型${p}-${m}`,
        ...capabilities,
      })),
    }))
    const current = { providerId: 'prov-2', modelId: 'm2-7' }
    const onSelect = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={many}
          model={current}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={onSelect}
        />
      </I18nextProvider>,
    )
    const list = screen.getByRole('listbox', { name: '下一轮使用的模型' })
    // 虚拟列表只挂载可视附近的行，不会一次渲染全部 24 个 option。
    expect(within(list).getAllByRole('option').length).toBeLessThan(24)
    expect(screen.getByRole('option', { name: /模型2-7/ }).getAttribute('data-active')).toBe('true')
    fireEvent.scroll(list, { target: { scrollTop: 0 } })
    const search = screen.getByRole('combobox', { name: '搜索模型' })
    search.focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('option', { name: /模型2-6/ }).getAttribute('data-active')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /模型2-7/ }).getAttribute('data-active')).toBe('true')
    await user.keyboard('{Enter}')
    // 当前项再按 Enter 不切换。
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('handles dozens of models across providers: search, recents, virtualization, pinned thinking', async () => {
    const user = userEvent.setup()
    const many = largeProviderFixture()
    const choices = enabledModelChoices(many)
    expect(choices).toHaveLength(36)
    expect(choices.every((c) => !c.name.includes('停用'))).toBe(true)

    const recentA = { providerId: 'prov-gemini', modelId: 'gemini-m3' }
    const recentB = { providerId: 'prov-openai', modelId: 'openai-m5' }
    rememberRecentModel(recentA)
    rememberRecentModel(recentB)
    const current = { providerId: 'prov-anthropic', modelId: 'anthropic-m0' }

    const { rows } = buildModelPickerRows(choices, [recentB, recentA], '', '最近使用')
    // 最近 2 + 三个供应商头 + 34 个分组模型 = 远超虚拟化阈值。
    expect(rows.length).toBeGreaterThan(MODEL_PICKER_VIRTUALIZE_AFTER)
    expect(rows.filter((r) => r.kind === 'header').map((r) => r.label)).toEqual([
      '最近使用',
      '供应商openai',
      '供应商anthropic',
      '供应商gemini',
    ])
    expect(
      rows
        .filter((r) => r.kind === 'header' && r.key.startsWith('provider:'))
        .map((r) => (r.kind === 'header' ? r.protocol : undefined)),
    ).toEqual(['openai', 'anthropic', 'gemini'])
    // 最近项不在供应商分组里重复。
    const groupedKeys = rows
      .filter((r) => r.kind === 'option' && !r.key.startsWith('recent:'))
      .map((r) => (r.kind === 'option' ? `${r.choice.ref.providerId}/${r.choice.ref.modelId}` : ''))
    expect(groupedKeys).not.toContain('prov-openai/openai-m5')
    expect(groupedKeys).not.toContain('prov-gemini/gemini-m3')

    const onSelectThinkingLevel = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={many}
          model={current}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
          thinkingLevel="medium"
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nextProvider>,
    )

    const trigger = screen.getByRole('button', {
      name: '模型：供应商anthropic · ANTHROPIC 模型 0',
    })
    expect(trigger.textContent).toContain('ANTHROPIC 模型 0')
    expect(trigger.textContent).not.toContain('供应商anthropic')
    expect(screen.queryByText(/停用/)).toBeNull()

    const list = screen.getByRole('listbox', { name: '下一轮使用的模型' })
    // 虚拟窗口：挂载的 option 远少于全部启用模型；外层垫高超过可视高度。
    const mountedNearCurrent = within(list).getAllByRole('option').length
    expect(mountedNearCurrent).toBeLessThan(choices.length)
    expect(mountedNearCurrent).toBeLessThanOrEqual(MODEL_PICKER_VIRTUALIZE_AFTER + 12)
    const spacer = list.firstElementChild as HTMLElement
    expect(Number.parseInt(spacer.style.height, 10)).toBeGreaterThan(288)

    // 滚到顶部：最近分区可见，且带协议图标的供应商头出现在分组里。
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 })
    fireEvent.scroll(list)
    await waitFor(() => expect(screen.getByText('最近使用')).toBeTruthy())
    expect(within(list).getByRole('option', { name: /OPENAI 模型 5/ })).toBeTruthy()
    expect(within(list).getByRole('option', { name: /GEMINI 模型 3/ })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('供应商openai')).toBeTruthy())
    expect(screen.getByText('供应商openai').parentElement?.querySelector('svg')).toBeTruthy()

    // 思考强度钉在 listbox 外的底部，不随列表滚走。
    const thinking = screen.getByRole('group', { name: '思考强度' })
    expect(list.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(thinking).getByRole('button', { name: '中' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.scroll(list, { target: { scrollTop: 800 } })
    expect(screen.getByRole('group', { name: '思考强度' })).toBeTruthy()

    const search = screen.getByRole('combobox', { name: '搜索模型' })
    await user.clear(search)
    await user.type(search, 'gemini-m7')
    expect(
      within(list)
        .getAllByRole('option')
        .map((el) => el.textContent),
    ).toEqual([expect.stringContaining('GEMINI 模型 7')])
    expect(screen.queryByText('最近使用')).toBeNull()

    await user.clear(search)
    await user.type(search, '供应商anthropic')
    expect(
      within(list)
        .getAllByRole('option')
        .every((el) => el.textContent?.includes('ANTHROPIC')),
    ).toBe(true)
    expect(within(list).getAllByRole('option')).toHaveLength(12)
    expect(screen.getByText('供应商anthropic').parentElement?.querySelector('svg')).toBeTruthy()

    await user.clear(search)
    await user.type(search, 'OPENAI 模型 2')
    expect(within(list).getByRole('option', { name: /OPENAI 模型 2/ })).toBeTruthy()
  })

  it('does not select when Enter is pressed with an empty match list', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ModelPicker
          providers={providers}
          model={fast}
          fixed={false}
          disabled={false}
          open
          onOpenChange={() => {}}
          onSelect={onSelect}
        />
      </I18nextProvider>,
    )
    const search = screen.getByRole('combobox', { name: '搜索模型' })
    await user.type(search, '没有这个')
    expect(screen.getByText('没有匹配的模型')).toBeTruthy()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
