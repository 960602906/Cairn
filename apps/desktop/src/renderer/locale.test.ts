// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from '@nexus/i18n'
import { loadLocale, syncDocumentLang } from './locale.js'

describe('loadLocale', () => {
  it('uses the locale from the settings', async () => {
    const request = vi.fn(async () => ({ locale: 'en-US' as const }))
    await expect(loadLocale({ request } as never, ['zh-CN'])).resolves.toBe('en-US')
    expect(request).toHaveBeenCalledWith('settings.get', {})
  })

  it('falls back to the browser languages without preload or when reading fails', async () => {
    await expect(loadLocale(undefined, ['zh-CN'])).resolves.toBe('zh-CN')
    const request = vi.fn(async () => {
      throw new Error('closed')
    })
    await expect(loadLocale({ request } as never, ['de-DE'])).resolves.toBe('en-US')
  })
})

describe('syncDocumentLang', () => {
  it('follows language changes until stopped', async () => {
    const i18n = createI18n('zh-CN')
    const root = { lang: '' }
    const stop = syncDocumentLang(i18n, root)
    expect(root.lang).toBe('zh-CN')
    await i18n.changeLanguage('en-US')
    expect(root.lang).toBe('en-US')
    await i18n.changeLanguage('fr-FR')
    expect(root.lang).toBe(i18n.resolvedLanguage)
    expect(['zh-CN', 'en-US']).toContain(root.lang)
    stop()
    await i18n.changeLanguage('zh-CN')
    expect(root.lang).toBe('en-US')
  })
})

describe('syncDocumentLang in the window', () => {
  it('updates <html lang> by default', async () => {
    const i18n = createI18n('en-US')
    const stop = syncDocumentLang(i18n)
    expect(document.documentElement.lang).toBe('en-US')
    await i18n.changeLanguage('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    stop()
  })
})
