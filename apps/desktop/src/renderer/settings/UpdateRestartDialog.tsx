/**
 * 重启安装确认（M5-07，ADR-0036）：更新只有下载并校验完成后才提供，且必须由用户确认；
 * 不提供静默重启。有运行中任务、待审批或检查点恢复时按钮禁用，主进程也会再次拒绝。
 */
import { useEffect, useState } from 'react'
import { CircleAlert, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import type { UpdateError } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { hasRunningSessions, installBlocked } from '../update-model.js'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Spinner,
} from '../ui/index.js'

export function UpdateRestartDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation('settings')
  const status = useSessionStore((s) => s.updateStatus)
  const sessions = useSessionStore((s) => s.sessions)
  const installUpdate = useSessionStore((s) => s.installUpdate)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<UpdateError | undefined>()

  useEffect(() => {
    if (open) setFailure(undefined)
  }, [open])

  const version = status?.availableVersion ?? status?.currentVersion ?? ''
  const blocked = status !== undefined && installBlocked(status, hasRunningSessions(sessions))
  const unsigned = status !== undefined && !status.signatureVerified

  const confirm = async () => {
    if (pending) return
    setPending(true)
    setFailure(undefined)
    const result = await installUpdate()
    setPending(false)
    if (!result) return
    if (result.error && result.phase !== 'installing') {
      setFailure(result.error)
      return
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent icon={<RotateCw />}>
        <DialogTitle>{t('update.restart.title', { version })}</DialogTitle>
        <DialogDescription>{t('update.restart.description')}</DialogDescription>
        {blocked && (
          <p
            role="status"
            className="mt-4 flex items-start gap-2 rounded-[9px] bg-warn-soft px-3 py-2.5 text-note leading-relaxed text-fg2"
          >
            <CircleAlert aria-hidden className="mt-px size-4 shrink-0 text-warn" />
            <span>{t('update.restart.busy')}</span>
          </p>
        )}
        {unsigned && (
          <p className="mt-3 rounded-[9px] bg-sunk px-3 py-2.5 text-note leading-relaxed text-muted">
            {t('update.restart.unsigned')}
          </p>
        )}
        {failure && (
          <p
            role="alert"
            className="mt-3 rounded-[9px] bg-danger-soft px-3 py-2.5 text-note leading-relaxed text-danger"
          >
            {translateError(i18n, failure)}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('update.restart.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={pending || blocked}>
            {pending && <Spinner aria-hidden />}
            {pending ? t('update.restart.installing') : t('update.restart.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
