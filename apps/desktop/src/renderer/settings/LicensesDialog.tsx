/**
 * 第三方许可声明（M5-07）：关于页的入口按需读取随包的 `THIRD_PARTY_NOTICES.txt`。
 *
 * 文本只含依赖与许可证；不显示路径，不做网络请求。读取失败时说明文件缺失，
 * 超大时提示已截断。
 */
import { useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppLicenses } from '@cairn/protocol'
import { CopyButton } from '../CopyButton.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Spinner,
} from '../ui/index.js'

type LicenseState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: AppLicenses }
  | { readonly kind: 'failed' }

export function LicensesDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const licenses = useSessionStore((s) => s.licenses)
  const [state, setState] = useState<LicenseState>({ kind: 'loading' })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ kind: 'loading' })
    void licenses().then((value) => {
      if (cancelled) return
      setState(value ? { kind: 'ready', value } : { kind: 'failed' })
    })
    return () => {
      cancelled = true
    }
  }, [licenses, open])

  const ready = state.kind === 'ready' ? state.value : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        icon={<ScrollText />}
        className="flex max-h-[min(680px,calc(100vh-64px))] w-[min(760px,calc(100vw-32px))] flex-col"
      >
        <div className="flex items-start justify-between gap-4">
          <DialogTitle>{t('licenses.title')}</DialogTitle>
          {ready?.available && <CopyButton text={ready.text} className="text-fg2 hover:bg-hover" />}
        </div>
        <DialogDescription>{t('licenses.description')}</DialogDescription>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-[9px] bg-sunk/60 p-3">
          {state.kind === 'loading' && (
            <p className="flex items-center gap-2 text-ui text-muted">
              <Spinner aria-hidden />
              {t('licenses.loading')}
            </p>
          )}
          {state.kind === 'failed' && (
            <p className="text-ui leading-relaxed text-fg2">{t('licenses.failed')}</p>
          )}
          {ready && !ready.available && (
            <p className="text-ui leading-relaxed text-fg2">{t('licenses.unavailable')}</p>
          )}
          {ready?.available && (
            <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [font-variant-ligatures:none] break-words text-fg2">
              {ready.text}
            </pre>
          )}
          {ready?.truncated && (
            <p className="mt-3 text-note leading-relaxed text-warn">{t('licenses.truncated')}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('licenses.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
