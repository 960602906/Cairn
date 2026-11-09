/**
 * 设置页“更新”（M5-07，ADR-0036）：版本、通道、自动检查、检查/下载/取消、进度、
 * 重启安装、跳过版本、错误详情与上次检查时间。
 *
 * - 状态全部来自主进程的 `update.status`；变化经 `update.status` 推送，不在这里猜。
 * - 安装必须经重启确认对话框；有运行中任务时禁用，主进程还会再校验一次。
 * - 通道由构建固定时不能修改，避免设置与构建矛盾。
 */
import { useEffect, useState } from 'react'
import { CircleAlert, Download, RefreshCw, RotateCw, ShieldCheck, ShieldX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translateError } from '@cairn/i18n'
import type { UpdateChannel, UpdateStatus } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import {
  formatBytes,
  formatSpeed,
  hasRunningSessions,
  installBlocked,
  progressPercent,
} from '../update-model.js'
import { Button, SegmentedControl, Spinner, Switch } from '../ui/index.js'
import { Field, SettingsGroup, ToggleRow } from './Field.js'
import { SettingsHeader } from './SettingsPage.js'
import { UpdateRestartDialog } from './UpdateRestartDialog.js'

function Mono({ children }: { readonly children: string }) {
  return (
    <span className="font-mono text-[13px] [font-variant-ligatures:none] break-all text-fg">
      {children}
    </span>
  )
}

function phaseTone(phase: UpdateStatus['phase']): string {
  switch (phase) {
    case 'available':
    case 'downloaded':
      return 'bg-accent-soft text-accent'
    case 'error':
      return 'bg-danger-soft text-danger'
    case 'checking':
    case 'downloading':
    case 'verifying':
    case 'installing':
      return 'bg-sunk text-fg2'
    default:
      return 'bg-sunk text-muted'
  }
}

function formatWhen(value: number | undefined, locale: string): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString(locale)
}

export function UpdateSettings() {
  const { t, i18n } = useTranslation('settings')
  const status = useSessionStore((s) => s.updateStatus)
  const settings = useSessionStore((s) => s.settings)
  const sessions = useSessionStore((s) => s.sessions)
  const loadUpdateStatus = useSessionStore((s) => s.loadUpdateStatus)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const checkUpdate = useSessionStore((s) => s.checkUpdate)
  const downloadUpdate = useSessionStore((s) => s.downloadUpdate)
  const cancelUpdate = useSessionStore((s) => s.cancelUpdate)
  const skipUpdateVersion = useSessionStore((s) => s.skipUpdateVersion)
  const restoreSkippedUpdate = useSessionStore((s) => s.restoreSkippedUpdate)
  const [restartOpen, setRestartOpen] = useState(false)

  useEffect(() => {
    void loadUpdateStatus()
  }, [loadUpdateStatus])

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [loadSettings, settings])

  const changeChannel = async (channel: UpdateChannel) => {
    if (await updateSettings({ updateChannel: channel })) await loadUpdateStatus()
  }

  const changeAutoCheck = async (checked: boolean) => {
    if (await updateSettings({ updateAutoCheck: checked })) await loadUpdateStatus()
  }

  const when = status ? formatWhen(status.lastCheckedAt, i18n.language) : undefined

  return (
    <>
      <SettingsHeader
        icon={<RefreshCw />}
        title={t('section.update.title')}
        description={t('section.update.description')}
      />
      <SettingsGroup
        icon={<Download />}
        title={t('update.status.title')}
        description={t('update.status.description')}
      >
        {status === undefined ? (
          <p className="flex items-center gap-2 text-ui text-muted">
            <Spinner aria-hidden />
            {t('update.loading')}
          </p>
        ) : (
          <>
            <Field label={t('update.current.label')}>
              <div className="flex flex-wrap items-center gap-2">
                <Mono>{`v${status.currentVersion}`}</Mono>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${phaseTone(status.phase)}`}
                >
                  {t(`update.phase.${status.phase}`)}
                </span>
              </div>
            </Field>
            <Field
              label={t('update.channel.label')}
              hint={
                status.channelPinned ? t('update.channel.pinnedHint') : t('update.channel.hint')
              }
            >
              {status.channelPinned ? (
                <p className="pt-1 text-ui text-fg">{t(`update.channel.${status.channel}`)}</p>
              ) : (
                <SegmentedControl
                  label={t('update.channel.label')}
                  value={status.channel}
                  options={[
                    { value: 'stable', label: t('update.channel.stable') },
                    { value: 'beta', label: t('update.channel.beta') },
                  ]}
                  onChange={(channel) => void changeChannel(channel)}
                />
              )}
            </Field>
            <ToggleRow title={t('update.autoCheck.label')} hint={t('update.autoCheck.hint')}>
              <Switch
                aria-label={t('update.autoCheck.label')}
                checked={status.autoCheck}
                onCheckedChange={(checked) => void changeAutoCheck(checked)}
              />
            </ToggleRow>
            <Field label={t('update.lastChecked.label')}>
              <span className="text-ui text-fg">{when ?? t('update.lastChecked.never')}</span>
            </Field>
            <UpdateDetail
              status={status}
              blocked={installBlocked(status, hasRunningSessions(sessions))}
              onCheck={() => void checkUpdate(true)}
              onDownload={() => void downloadUpdate()}
              onCancel={() => void cancelUpdate()}
              onRestart={() => setRestartOpen(true)}
              onSkip={(version) => void skipUpdateVersion(version)}
              onUnskip={() => void restoreSkippedUpdate()}
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title={t('update.source.title')} description={t('update.source.description')}>
        <Field label={t('update.source.label')}>
          <Mono>{status?.source ?? t('about.unknown')}</Mono>
        </Field>
        <p className="text-note leading-relaxed text-muted">{t('update.source.hint')}</p>
      </SettingsGroup>
      <UpdateRestartDialog open={restartOpen} onOpenChange={setRestartOpen} />
    </>
  )
}

function UpdateDetail({
  status,
  blocked,
  onCheck,
  onDownload,
  onCancel,
  onRestart,
  onSkip,
  onUnskip,
}: {
  readonly status: UpdateStatus
  readonly blocked: boolean
  readonly onCheck: () => void
  readonly onDownload: () => void
  readonly onCancel: () => void
  readonly onRestart: () => void
  readonly onSkip: (version: string) => void
  readonly onUnskip: () => void
}) {
  const { t, i18n } = useTranslation('settings')
  const version = status.availableVersion ?? status.currentVersion
  const percent = progressPercent(status)
  const speed = formatSpeed(status.progress?.bytesPerSecond)
  const skippedCurrent =
    status.availableVersion !== undefined && status.skippedVersion === status.availableVersion
  const canCheck = ['idle', 'up_to_date', 'available', 'skipped', 'error'].includes(status.phase)
  const release =
    status.releaseDate === undefined ? undefined : formatWhen(status.releaseDate, i18n.language)

  return (
    <div className="flex flex-col gap-3 rounded-[10px] bg-sunk/60 px-4 py-3.5 shadow-hair">
      {status.phase === 'disabled' && (
        <p role="status" className="text-ui leading-relaxed text-fg2">
          {status.disabledReason
            ? translateError(i18n, { code: status.disabledReason })
            : t('update.phase.disabled')}
        </p>
      )}
      {status.phase === 'checking' && (
        <p className="flex items-center gap-2 text-ui text-fg2">
          <Spinner aria-hidden />
          {t('update.detail.checking')}
        </p>
      )}
      {status.phase === 'up_to_date' && (
        <p className="text-ui text-fg2">{t('update.detail.upToDate')}</p>
      )}
      {status.phase === 'available' && (
        <div className="flex flex-col gap-1">
          <p className="text-ui text-fg">{t('update.detail.available', { version })}</p>
          {release && (
            <p className="text-note text-muted">{t('update.detail.released', { when: release })}</p>
          )}
        </div>
      )}
      {status.phase === 'skipped' && (
        <p className="text-ui text-fg2">{t('update.detail.skipped', { version })}</p>
      )}
      {status.phase === 'downloading' && (
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label={t('update.progress.label')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-sunk2"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="text-note text-muted">
            {speed
              ? t('update.progress.detailSpeed', {
                  percent,
                  transferred: formatBytes(status.progress?.transferred ?? 0),
                  total: formatBytes(status.progress?.total ?? 0),
                  speed,
                })
              : t('update.progress.detail', {
                  percent,
                  transferred: formatBytes(status.progress?.transferred ?? 0),
                  total: formatBytes(status.progress?.total ?? 0),
                })}
          </p>
        </div>
      )}
      {status.phase === 'verifying' && (
        <p className="flex items-center gap-2 text-ui text-fg2">
          <Spinner aria-hidden />
          {t('update.detail.verifying')}
        </p>
      )}
      {status.phase === 'downloaded' && (
        <div className="flex flex-col gap-1">
          <p className="text-ui text-fg">{t('update.detail.downloaded', { version })}</p>
          <p
            className={`flex items-center gap-1.5 text-note ${status.signatureVerified ? 'text-fg2' : 'text-warn'}`}
          >
            {status.signatureVerified ? (
              <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <ShieldX aria-hidden className="size-3.5 shrink-0" />
            )}
            {status.signatureVerified
              ? t('update.signature.verified')
              : t('update.signature.unverified')}
          </p>
          {blocked && <p className="text-note text-fg2">{t('update.detail.busy')}</p>}
        </div>
      )}
      {status.phase === 'installing' && (
        <p className="flex items-center gap-2 text-ui text-fg2">
          <Spinner aria-hidden />
          {t('update.detail.installing')}
        </p>
      )}
      {status.error && (
        <div
          role={status.phase === 'error' ? 'alert' : 'status'}
          className={
            status.phase === 'error'
              ? 'rounded-[9px] bg-danger-soft px-3 py-2.5 text-note text-danger'
              : 'text-note text-muted'
          }
        >
          <p className="flex items-start gap-2 leading-relaxed">
            {status.phase === 'error' && (
              <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
            )}
            <span>{translateError(i18n, status.error)}</span>
          </p>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-note text-fg2">
              {t('update.error.details')}
            </summary>
            <p className="mt-1 font-mono text-[11.5px] break-all text-muted">
              {status.error.code} · {status.error.message}
            </p>
          </details>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canCheck && (
          <Button
            size="sm"
            variant={status.phase === 'idle' || status.phase === 'error' ? 'primary' : 'secondary'}
            onClick={onCheck}
          >
            {status.phase === 'up_to_date' ||
            status.phase === 'available' ||
            status.phase === 'skipped'
              ? t('update.action.checkAgain')
              : status.phase === 'error'
                ? t('update.action.retry')
                : t('update.action.check')}
          </Button>
        )}
        {status.phase === 'available' && (
          <Button size="sm" variant="primary" onClick={onDownload}>
            {t('update.action.download')}
          </Button>
        )}
        {status.phase === 'available' &&
          (skippedCurrent ? (
            <Button size="sm" variant="secondary" onClick={onUnskip}>
              {t('update.action.unskip')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onSkip(version)}>
              {t('update.action.skip')}
            </Button>
          ))}
        {status.phase === 'skipped' && (
          <Button size="sm" variant="secondary" onClick={onUnskip}>
            {t('update.action.unskip')}
          </Button>
        )}
        {status.phase === 'downloading' && (
          <Button size="sm" variant="secondary" onClick={onCancel}>
            {t('update.action.cancel')}
          </Button>
        )}
        {status.phase === 'downloaded' && (
          <Button
            size="sm"
            variant="primary"
            disabled={blocked}
            title={blocked ? t('update.action.restartBlocked') : undefined}
            onClick={onRestart}
          >
            <RotateCw aria-hidden />
            {t('update.action.restart')}
          </Button>
        )}
      </div>
    </div>
  )
}
