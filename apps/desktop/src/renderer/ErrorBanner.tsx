/**
 * 显示 store 中最近的错误（经 i18n 翻译），可关闭。M2-02 起浮在纸面顶部；M2-12 按视觉规范的卡片样式：
 * 浮起的卡片，左侧红色图标块，标题“操作没有完成”，下面是错误说明与错误码（等宽、灰色，便于反馈问题）。
 *
 * 超时类错误用更轻的标题，并在一段时间后自动收起，避免盖住对话；关闭按钮放在更明显的位置。
 */
import { CircleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState } from 'react'
import { DiagnosticsExportDialog } from './settings/DiagnosticsExportDialog.js'
import { translateError } from '@cairn/i18n'
import { useSessionStore } from './store-context.js'

/** 超时提示停留这么久后自动收起（毫秒）；其它错误保持到用户关闭。 */
const TIMEOUT_AUTO_DISMISS_MS = 12_000

export function ErrorBanner() {
  const [diagOpen, setDiagOpen] = useState(false)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const { t, i18n } = useTranslation()
  const error = useSessionStore((s) => s.error)
  const clearError = useSessionStore((s) => s.clearError)
  const timedOut = error?.code === 'rpc.timeout'
  const previousSession = useRef(activeSessionId)

  // 切会话时收起，避免旧错误盖住新的对话内容；首次挂载不清，以免刚报出的错误立刻消失。
  useEffect(() => {
    if (previousSession.current === activeSessionId) return
    previousSession.current = activeSessionId
    clearError()
  }, [activeSessionId, clearError])

  useEffect(() => {
    if (!timedOut) return
    const timer = setTimeout(() => clearError(), TIMEOUT_AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [timedOut, error, clearError])

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
          <span className="block font-medium text-fg">
            {t(timedOut ? 'error.timeoutTitle' : 'error.title')}
          </span>
          <span className="mt-0.5 block text-fg2">{translateError(i18n, error)}</span>
          <span className="mt-1 block truncate font-mono text-[11.5px] text-faint">
            {error.code}
          </span>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={clearError}
              className="inline-flex h-7 items-center rounded-[7px] bg-sunk px-2.5 text-note text-fg2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent"
            >
              {t('errorBanner.dismiss')}
            </button>
            <button
              type="button"
              onClick={() => setDiagOpen(true)}
              className="inline-flex h-7 items-center rounded-[7px] px-2 text-note text-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-accent"
            >
              {t('errorBanner.diagnostics')}
            </button>
          </div>
        </span>
        <button
          type="button"
          aria-label={t('action.close')}
          title={t('action.close')}
          onClick={clearError}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent"
        >
          <X className="size-4" />
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
