/**
 * 界面入口：按系统语言创建 i18n 实例并挂载 React 根组件。
 * 语言设置的读取在 M0-13 / M0-15 接入（通过 preload API），目前只按浏览器语言检测。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createI18n, detectLocale } from '@nexus/i18n'
import { getMainApi } from './api.js'
import { App } from './App.js'
import { createSessionStore } from './session-store.js'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

const api = getMainApi()
const store = api && createSessionStore(api)

createRoot(root).render(
  <StrictMode>
    <App i18n={createI18n(detectLocale(navigator.languages))} {...(store ? { store } : {})} />
  </StrictMode>,
)
