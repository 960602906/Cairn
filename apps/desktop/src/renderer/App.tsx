/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 * 会话列表（M0-15b）之后是当前会话的消息流、输入框与运行状态（M0-15c）。没有 store（preload
 * 未加载，如在普通浏览器中打开）时只显示应用名称。
 */
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@nexus/i18n'
import { ChatPanel } from './ChatPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { SessionList } from './SessionList.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

export interface AppProps {
  readonly i18n: I18nInstance
  readonly store?: SessionStore
}

function Shell({ store }: { readonly store: SessionStore | undefined }) {
  const { t } = useTranslation()
  return (
    <main>
      <h1>{t('app.name')}</h1>
      {store && (
        <SessionStoreProvider store={store}>
          <ErrorBanner />
          <SessionList />
          <ChatPanel />
        </SessionStoreProvider>
      )}
    </main>
  )
}

export function App({ i18n, store }: AppProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <Shell store={store} />
    </I18nextProvider>
  )
}
