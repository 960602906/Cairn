// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { App } from './App.js'

afterEach(cleanup)

describe('LanguageSwitcher', () => {
  it('only switches the language without preload', async () => {
    const i18n = createI18n('en-US')
    render(<App i18n={i18n} />)
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['简体中文', 'English'])
    await userEvent.selectOptions(select, 'zh-CN')
    await waitFor(() => expect(screen.getByLabelText('语言')).toBeTruthy())
    expect(i18n.language).toBe('zh-CN')
  })
})
