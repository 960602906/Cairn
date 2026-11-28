/**
 * 左栏头部的更新入口（Codex 式）：发现新版本时出现下载按钮；下载中按钮外圈显示进度；
 * 下载完成后变成「更新」，点击确认重启安装。更新不占用对话区域。
 *
 * 状态全部来自主进程的 `update.status`；检查由主进程按设置自动进行，这里不主动检查。
 */
import { useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, RefreshCw, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store-context.js'
import { hasRunningSessions, installBlocked, progressPercent } from '../update-model.js'
import { UpdateRestartDialog } from '../settings/UpdateRestartDialog.js'
import { Button, IconButton, Spinner } from '../ui/index.js'

function Ring({ percent, label }: { readonly percent: number; readonly label: string }) {
  const radius = 10
  const length = 2 * Math.PI * radius
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="relative grid size-7 place-items-center"
    >
      <svg
        viewBox="0 0 24 24"
        style={{ width: 22, height: 22 }}
        className="absolute -rotate-90"
        aria-hidden
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="opacity-20"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - percent / 100)}
          className="transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none"
        />
      </svg>
      <ArrowDownToLine aria-hidden strokeWidth={2.5} style={{ width: 13, height: 13 }} />
    </span>
  )
}

export function UpdateButton() {
  const { t } = useTranslation('settings')
  const status = useSessionStore((s) => s.updateStatus)
  const sessions = useSessionStore((s) => s.sessions)
  const checkUpdate = useSessionStore((s) => s.checkUpdate)
  const downloadUpdate = useSessionStore((s) => s.downloadUpdate)
  const [restartOpen, setRestartOpen] = useState(false)

  if (!status) return null
  const version = status.availableVersion ?? status.currentVersion
  const percent = progressPercent(status)

  switch (status.phase) {
    case 'available': {
      // macOS / Linux 不做原地安装：打开下载页，由用户手动安装新版本。
      if (!status.installable) {
        const url = status.releaseUrl ?? status.source
        if (!url) return null
        const label = t('update.button.openRelease', { version })
        return (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="text-accent"
            aria-label={label}
            title={label}
          >
            <a href={url} target="_blank" rel="noreferrer">
              <ArrowUpRight strokeWidth={2.2} />
            </a>
          </Button>
        )
      }
      return (
        <IconButton
          label={t('update.button.download', { version })}
          size="icon-sm"
          className="text-accent"
          onClick={() => void downloadUpdate()}
        >
          <ArrowDownToLine strokeWidth={2.2} />
        </IconButton>
      )
    }
    case 'downloading':
      return (
        <span className="grid size-7 place-items-center text-accent">
          <Ring percent={percent} label={t('update.button.progress', { percent })} />
        </span>
      )
    case 'verifying':
    case 'installing':
      return (
        <span
          role="status"
          aria-label={t(`update.phase.${status.phase}`)}
          className="grid size-7 place-items-center text-muted"
        >
          <Spinner aria-hidden />
        </span>
      )
    case 'downloaded': {
      const blocked = installBlocked(status, hasRunningSessions(sessions))
      return (
        <>
          <IconButton
            label={blocked ? t('update.button.busy') : t('update.button.installHint', { version })}
            size="icon-sm"
            className="text-accent"
            disabled={blocked}
            onClick={() => setRestartOpen(true)}
          >
            <RefreshCw strokeWidth={2.2} />
          </IconButton>
          <UpdateRestartDialog open={restartOpen} onOpenChange={setRestartOpen} />
        </>
      )
    }
    case 'error':
      return (
        <IconButton
          label={t('update.button.retry')}
          size="icon-sm"
          onClick={() => {
            void checkUpdate(true).then((result) => {
              if (result?.phase === 'available' && result.installable) void downloadUpdate()
            })
          }}
        >
          <RotateCw strokeWidth={2.2} />
        </IconButton>
      )
    default:
      return null
  }
}
