/**
 * 显示 store 中最近的错误（经 i18n 翻译），可关闭。M2-02 起浮在纸面顶部；M2-12 按视觉规范的卡片样式：
 * 浮起的卡片，左侧红色图标块，标题“操作没有完成”，下面是错误说明与错误码（等宽、灰色，便于反馈问题）。
 */
import { CircleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { DiagnosticsExportDialog } from './settings/DiagnosticsExportDialog.js'
import { translateError } from '@cairn/i18n'
import { useSessionStore } from './store-context.js'

export function ErrorBanner() {
  const [diagOpen, setDiagOpen] = useState(false)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const { t, i18n } = useTranslation()
  const error = useSessionStore((s) => s.error)
  const clearError = useSessionStore((s) => s.clearError)
  if (!error) return null
  return (
    <>
      <div
        role="alert"
        className="absolute top-14 left-1/2 z-30 flex w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-start gap-3 rounded-card bg-raise py-3 pr-3 pl-3 text-ui text-fg shadow-2"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-danger-soft text-danger [&_svg]:size-4">
          <CircleAlert />
        </span>
        <span className="min-w-0 flex-1 pt-px">
          <span className="block font-medium text-fg">{t('error.title')}</span>
          <span className="mt-0.5 block text-fg2">{translateError(i18n, error)}</span>
          <span className="mt-1 block truncate font-mono text-[11.5px] text-faint">
            {error.code}
          </span>
        </span>
        <button
          type="button"
          aria-label={t('action.close')}
          onClick={clearError}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setDiagOpen(true)}
          className="ml-2 shrink-0 text-note underline text-fg2 hover:text-fg"
        >
          {t('errorBanner.diagnostics')}
        </button>
      </div>
      <DiagnosticsExportDialog
        open={diagOpen}
        onOpenChange={setDiagOpen}
        sessionId={activeSessionId}
      />
    </>
  )
}
