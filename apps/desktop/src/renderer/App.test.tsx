import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { App } from './App.js'

describe('App', () => {
  it('renders the app name and the language switcher without preload', () => {
    const html = renderToStaticMarkup(<App i18n={createI18n('zh-CN')} />)
    expect(html).toMatch(/^<main[^>]*><h1[^>]*>Cairn<\/h1><label>语言<select>/)
    expect(html).not.toContain('事件查看器')
  })

  it('uses the given i18n instance', () => {
    const i18n = createI18n('en-US')
    i18n.addResource('en-US', 'common', 'app.name', 'Cairn Test')
    expect(renderToStaticMarkup(<App i18n={i18n} />)).toContain('>Cairn Test</h1>')
  })
})
