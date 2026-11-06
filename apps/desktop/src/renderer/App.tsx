/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 * 标题旁是语言切换（M0-15d）；之后是模型设置（M1-16a）、会话列表（M0-15b）与当前会话的消息流、输入框与运行状态
 * （M0-15c）；开发模式下最后是事件查看器（M0-15d）。没有 store（preload 未加载，如在普通浏览器中
 * 打开）时只显示应用名称与语言切换。
 */
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@nexus/i18n'
import { ChatPanel } from './ChatPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { EventViewer } from './EventViewer.js'
import { LanguageSwitcher } from './LanguageSwitcher.js'
import { ModelSettings } from './ModelSettings.js'
import { SessionList } from './SessionList.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

export interface AppProps {
  readonly i18n: I18nInstance
  readonly store?: SessionStore
  /** 显示开发工具（事件查看器）；store 需开启事件记录。 */
  readonly devTools?: boolean
}

function Shell({ store, devTools }: Omit<AppProps, 'i18n'>) {
  const { t } = useTranslation()
  return (
    <main>
      <header>
        <h1>{t('app.name')}</h1>
        <LanguageSwitcher
          {...(store
            ? { onSave: (locale) => void store.getState().updateSettings({ locale }) }
            : {})}
        />
      </header>
      {store && (
        <SessionStoreProvider store={store}>
          <ErrorBanner />
          <ModelSettings />
          <SessionList />
          <ChatPanel />
          {devTools && <EventViewer />}
        </SessionStoreProvider>
      )}
    </main>
  )
}

export function App({ i18n, store, devTools = false }: AppProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <Shell {...(store ? { store } : {})} devTools={devTools} />
    </I18nextProvider>
  )
}
