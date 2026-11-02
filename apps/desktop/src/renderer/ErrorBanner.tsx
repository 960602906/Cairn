/** 显示 store 中最近的错误（经 i18n 翻译），可关闭。 */
import { useTranslation } from 'react-i18next'
import { translateError } from '@nexus/i18n'
import { useSessionStore } from './store-context.js'

export function ErrorBanner() {
  const { t, i18n } = useTranslation()
  const error = useSessionStore((s) => s.error)
  const clearError = useSessionStore((s) => s.clearError)
  if (!error) return null
  return (
    <div role="alert">
      <span>{translateError(i18n, error)}</span>
      <button type="button" onClick={clearError}>
        {t('action.close')}
      </button>
    </div>
  )
}
