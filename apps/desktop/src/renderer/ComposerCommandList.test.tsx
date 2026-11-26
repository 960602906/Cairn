// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { ComposerCommandList } from './ComposerCommandList.js'
import type { AvailableComposerCommand } from './composer-shared.js'

afterEach(() => {
  cleanup()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

const command = (id: string): AvailableComposerCommand => ({
  id,
  name: id,
  description: `${id} 的说明`,
  args: 'none',
  kind: 'command',
})

it('keeps the active command in view when the selection moves', () => {
  const scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  const commands = [command('plan'), command('model'), command('help')]
  const list = (activeIndex: number) => (
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <ComposerCommandList
        commands={commands}
        activeIndex={activeIndex}
        onSelect={() => {}}
        onHover={() => {}}
      />
    </I18nextProvider>
  )
  const { rerender } = render(list(0))
  scrollIntoView.mockClear()

  rerender(list(2))
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView.mock.contexts[0]).toBe(screen.getAllByRole('option')[2])
})
