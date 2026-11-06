/** 显示 store 中最近的错误（经 i18n 翻译），可关闭。M2-02 起浮在纸面顶部。 */
import { CircleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import { useSessionStore } from './store-context.js'

export function ErrorBanner() {
  const { t, i18n } = useTranslation()
  const error = useSessionStore((s) => s.error)
  const clearError = useSessionStore((s) => s.clearError)
  if (!error) return null
  return (
    <div
      role="alert"
      className="absolute top-14 left-1/2 z-30 flex w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-start gap-2.5 rounded-card bg-raise px-3.5 py-2.5 text-ui text-fg shadow-2"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
      <span className="flex-1">{translateError(i18n, error)}</span>
      <button
        type="button"
        aria-label={t('action.close')}
        onClick={clearError}
        className="-m-1 inline-flex size-6 items-center justify-center rounded-[6px] text-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
