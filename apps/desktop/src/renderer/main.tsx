/**
 * 界面入口：先用系统语言创建 i18n 与会话 store 并立即挂载，再异步读取设置中的语言校正。
 * 首帧不再等待一次 IPC；`#preview` 只在开发模式下动态加载组件预览页（M2-01）。
 */
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createI18n, detectLocale, type Locale } from '@cairn/i18n'
import { getMainApi } from './api.js'
import { App } from './App.js'
import { syncDocumentLang } from './locale.js'
import { createSessionStore } from './session-store.js'
import { instrumentRequests, mark, markFirstPaint, observeLongTasks } from './startup-trace.js'
import { applyTheme } from './theme.js'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// 设置读到之前先跟随系统，避免深色系统下闪一下白屏；之后由 ThemeSync 接管
applyTheme('system')()
mark('renderer_module_start')
observeLongTasks()

const dev = import.meta.env.DEV
if (dev && location.hash === '#preview') {
  void import('./dev/ComponentPreview.js').then(({ ComponentPreview }) => {
    createRoot(root).render(
      <StrictMode>
        <ComponentPreview />
      </StrictMode>,
    )
    mark('preview_rendered')
  })
} else {
  const api = getMainApi()
  const store = api ? createSessionStore(instrumentRequests(api)) : undefined

  // 先用系统语言渲染。设置里的语言在首帧之后到达，再与当前语言比较后校正。
  const initial = detectLocale(navigator.languages)
  const i18n = createI18n(initial)
  syncDocumentLang(i18n)
  mark('i18n_ready')

  createRoot(root).render(
    <StrictMode>
      <App i18n={i18n} {...(store ? { store } : {})} />
    </StrictMode>,
  )
  mark('render_called')
  markFirstPaint()

  if (store) {
    const applySavedLocale = (saved: Locale | undefined): void => {
      // 用户已经手动切换过语言时不再覆盖。
      if (saved === undefined || saved === i18n.resolvedLanguage) return
      if (i18n.resolvedLanguage !== initial) return
      void i18n.changeLanguage(saved)
    }
    void store
      .getState()
      .loadSettings()
      .then((settings) => applySavedLocale(settings?.locale))
  }
}
