/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 * 会话列表、消息流等界面在 M0-15 实现。
 */
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@nexus/i18n'

export interface AppProps {
  readonly i18n: I18nInstance
}

function Shell() {
  const { t } = useTranslation()
  return (
    <main>
      <h1>{t('app.name')}</h1>
    </main>
  )
}

export function App({ i18n }: AppProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <Shell />
    </I18nextProvider>
  )
}
