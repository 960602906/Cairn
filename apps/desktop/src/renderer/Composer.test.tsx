// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@cairn/i18n'
import type { ProviderConfig } from '@cairn/protocol'
import {
  enabledModelChoices,
  modelLabels,
  ModelPicker,
  resolveDefaultModel,
  sameModel,
} from './Composer.js'

afterEach(cleanup)

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsParallelToolCalls: true,
  supportsReasoning: false,
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
    ],
  },
  {
    id: 'p2',
    kind: 'openai',
    displayName: '供应商二',
    baseUrl: 'https://example.com',
    models: [{ id: 'strong', displayName: '强', ...capabilities }],
  },
]

const fast = { providerId: 'p1', modelId: 'fast' }
const strong = { providerId: 'p2', modelId: 'strong' }

describe('Composer model helpers', () => {
  it('lists enabled models, resolves defaults, and compares model refs', () => {
    expect(enabledModelChoices(providers).map((choice) => choice.name)).toEqual(['fast', '强'])
    expect(sameModel(fast, { ...fast })).toBe(true)
    expect(sameModel(fast, strong)).toBe(false)
    expect(sameModel(undefined, fast)).toBe(false)
    expect(resolveDefaultModel(providers, strong)).toEqual(strong)
    expect(resolveDefaultModel(providers, { providerId: 'p1', modelId: 'missing' })).toEqual(fast)
    expect(resolveDefaultModel([], fast)).toBeUndefined()
  })

  it('labels configured, unknown, and missing models', () => {
    expect(modelLabels(fast, providers)).toEqual({ short: 'fast', full: '供应商一 · fast' })
    expect(modelLabels({ providerId: 'missing', modelId: 'raw' }, providers)).toEqual({
      short: 'raw',
      full: 'raw',
    })
    expect(modelLabels({ providerId: 'p1', modelId: 'unknown' }, providers)).toEqual({
      short: 'unknown',
      full: '供应商一 · unknown',
    })
    expect(modelLabels(undefined, providers)).toEqual({ short: undefined, full: undefined })
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
  })

  it('only emits a change for a different selection', async () => {
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
    await user.click(screen.getByRole('menuitem', { name: /^fast/ }))
    expect(onSelect).not.toHaveBeenCalled()

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
    await user.click(screen.getByRole('menuitem', { name: /强/ }))
    expect(onSelect).toHaveBeenCalledWith(strong)
  })

  it('picks the thinking level of the current model', async () => {
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
    render(
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
    await user.click(screen.getByRole('menuitem', { name: '高' }))
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('high')
  })

  it('explains when the model does not support reasoning, and hides the section without a session', () => {
    const { rerender } = render(
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
  })
})
