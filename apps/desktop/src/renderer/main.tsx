/**
 * 界面入口：读取设置中的语言、创建 i18n 实例与会话 store，挂载 React 根组件。
 * 地址带 `#preview` 时显示组件预览页（M2-01）。
 */
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createI18n } from '@cairn/i18n'
import { getMainApi } from './api.js'
import { App } from './App.js'
import { ComponentPreview } from './dev/ComponentPreview.js'
import { loadLocale, syncDocumentLang } from './locale.js'
import { createSessionStore } from './session-store.js'
import { applyTheme } from './theme.js'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// 设置读到之前先跟随系统，避免深色系统下闪一下白屏；之后由 ThemeSync 接管
applyTheme('system')()

const dev = import.meta.env.DEV
if (dev && location.hash === '#preview') {
  createRoot(root).render(
    <StrictMode>
      <ComponentPreview />
    </StrictMode>,
  )
} else {
  const api = getMainApi()
  const store = api && createSessionStore(api)

  void loadLocale(api, navigator.languages).then((locale) => {
    const i18n = createI18n(locale)
    syncDocumentLang(i18n)
    createRoot(root).render(
      <StrictMode>
        <App i18n={i18n} {...(store ? { store } : {})} />
      </StrictMode>,
    )
  })
}
