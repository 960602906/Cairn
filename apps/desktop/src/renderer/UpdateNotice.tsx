/**
 * 可用更新的非模态提示（M5-07）：挂在会话标题栏下方一条，不抢焦点、不打断任务。
 *
 * - 发现新版本：下载或稍后；下载中显示百分比并可取消。
 * - 下载完成：提示重启安装；有运行中任务时显示延迟提示并禁用按钮（主进程也会拒绝）。
 * - 错误不在这里弹：更新设置里显示原因并可重试，避免错误风暴。
 */
import { useEffect, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from './store-context.js'
import {
  hasRunningSessions,
  installBlocked,
  noticeKey,
  noticeKind,
  progressPercent,
} from './update-model.js'
import { Button } from './ui/index.js'
import { UpdateRestartDialog } from './settings/UpdateRestartDialog.js'

export function UpdateNotice({ onOpenSettings }: { readonly onOpenSettings: () => void }) {
  const { t } = useTranslation('settings')
  const status = useSessionStore((s) => s.updateStatus)
  const sessions = useSessionStore((s) => s.sessions)
  const downloadUpdate = useSessionStore((s) => s.downloadUpdate)
  const cancelUpdate = useSessionStore((s) => s.cancelUpdate)
  const loadUpdateStatus = useSessionStore((s) => s.loadUpdateStatus)
  const [dismissed, setDismissed] = useState<string | undefined>()
  const [restartOpen, setRestartOpen] = useState(false)

  const running = hasRunningSessions(sessions)
  const kind = noticeKind(status, dismissed)
  const blocked = status !== undefined && installBlocked(status, running)

  // 下载完成后的延迟提示取决于“当时有没有任务”，任务结束或开始时重新读取主进程的判定。
  const downloaded = status?.phase === 'downloaded'
  const blockedReason = status?.blockedReason
  useEffect(() => {
    if (downloaded) void loadUpdateStatus()
  }, [blockedReason, downloaded, loadUpdateStatus, running])

  if (!status || !kind) return null
  const version = status.availableVersion ?? status.currentVersion
  const percent = progressPercent(status)
  const text =
    kind === 'available'
      ? t('update.notice.available', { version })
      : kind === 'downloading'
        ? t('update.notice.downloading', { percent })
        : blocked
          ? t('update.notice.downloadedBusy', { version })
          : t('update.notice.downloaded', { version })

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="flex shrink-0 items-center gap-3 border-b-[0.5px] border-hair bg-accent-soft px-5 py-2 text-ui text-fg"
      >
        <ArrowDownToLine aria-hidden className="size-4 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 truncate">{text}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {kind === 'available' && (
            <Button size="sm" variant="primary" onClick={() => void downloadUpdate()}>
              {t('update.notice.download')}
            </Button>
          )}
          {kind === 'downloading' && (
            <Button size="sm" variant="secondary" onClick={() => void cancelUpdate()}>
              {t('update.notice.cancel')}
            </Button>
          )}
          {kind === 'downloaded' && (
            <Button
              size="sm"
              variant="primary"
              disabled={blocked}
              title={blocked ? t('update.notice.busyHint') : undefined}
              onClick={() => setRestartOpen(true)}
            >
              {t('update.notice.restart')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDismissed(noticeKey(status))}>
            {t('update.notice.later')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            {t('update.notice.settings')}
          </Button>
        </div>
      </div>
      <UpdateRestartDialog open={restartOpen} onOpenChange={setRestartOpen} />
    </>
  )
}
