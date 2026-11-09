/**
 * 设置页“命令沙箱”（M5-05，ADR-0034）：默认档位、网络策略、不可用行为与能力状态。
 *
 * - 档位只提供可保存的 `read-only` / `workspace-write`；`danger-full-access` 只能逐次审批，不能设成默认。
 * - 受限令牌机制不隔离网络；这里必须如实显示“网络未隔离”，不能只按所选策略暗示已隔离。
 * - 能力探测结果来自主进程（`sandbox.status`）；失败时提示导出诊断包，不静默隐藏。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ShieldCheck, ShieldOff, X } from 'lucide-react'
import {
  SandboxStatus as SandboxStatusSchema,
  type SandboxDefaultProfile,
  type SandboxNetwork,
  type SandboxStatus,
  type SandboxUnavailableBehavior,
} from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { sandboxReason } from '../sandbox-labels.js'
import { cn, SegmentedControl, Spinner } from '../ui/index.js'
import { Field, SettingsGroup } from './Field.js'

const PROFILE_OPTIONS: readonly SandboxDefaultProfile[] = ['read-only', 'workspace-write']
const NETWORK_OPTIONS: readonly SandboxNetwork[] = ['none', 'internet', 'private']
const UNAVAILABLE_OPTIONS: readonly SandboxUnavailableBehavior[] = ['deny', 'ask']
const CHECK_KEYS = ['restrictedToken', 'lowIntegrity', 'jobObject', 'appContainer'] as const

function CapabilityPanel({ status }: { readonly status: SandboxStatus | 'loading' | 'failed' }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')

  if (status === 'loading') {
    return (
      <div
        data-testid="sandbox-capability"
        className="flex items-center gap-2 rounded-card bg-sunk px-3.5 py-3 text-note text-muted"
      >
        <Spinner className="size-3.5" />
        {t('general.sandbox.status.loading')}
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div
        data-testid="sandbox-capability"
        className="flex flex-col gap-1 rounded-card bg-danger-soft px-3.5 py-3"
      >
        <p className="flex items-center gap-2 text-ui text-danger">
          <ShieldOff aria-hidden className="size-4 shrink-0" />
          {t('general.sandbox.status.failed')}
        </p>
        <p className="text-note text-muted">{t('general.sandbox.diagnostics')}</p>
      </div>
    )
  }

  const { capability } = status
  const available = capability.available && capability.mechanism !== 'none'
  const mechanism = tc(`sandbox.mechanism.${capability.mechanism}`)
  const preferred = tc(`sandbox.mechanism.${status.mechanism}`)
  const fallback = available && capability.mechanism !== status.mechanism
  const network = capability.networkIsolated
    ? tc(`sandbox.network.${status.policy.network}`)
    : tc('sandbox.network.notIsolated')

  return (
    <div
      data-testid="sandbox-capability"
      data-sandbox-available={String(available)}
      className="flex flex-col gap-2.5 rounded-card bg-sunk px-3.5 py-3"
    >
      <p
        className={cn(
          'flex items-center gap-2 text-ui font-medium',
          available ? 'text-ok' : 'text-danger',
        )}
      >
        {available ? (
          <ShieldCheck aria-hidden className="size-4 shrink-0" />
        ) : (
          <ShieldOff aria-hidden className="size-4 shrink-0" />
        )}
        {available
          ? t('general.sandbox.status.available', { mechanism })
          : t('general.sandbox.status.unavailable', {
              reason: sandboxReason(tc, capability.reason),
            })}
      </p>
      {fallback && (
        <p className="text-note text-warn">
          {t('general.sandbox.status.fallback', { preferred, actual: mechanism })}
        </p>
      )}
      <p className="text-note text-fg2">{t('general.sandbox.status.network', { network })}</p>
      <div className="flex flex-col gap-1.5 border-t-[0.5px] border-hair pt-2.5">
        <span className="text-note font-medium text-fg2">{t('general.sandbox.status.checks')}</span>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          {CHECK_KEYS.map((key) => {
            const ok = capability.checks[key]
            return (
              <li key={key} className="flex items-center gap-1.5 text-note text-muted">
                {ok ? (
                  <Check aria-hidden className="size-3 shrink-0 text-ok" />
                ) : (
                  <X aria-hidden className="size-3 shrink-0 text-faint" />
                )}
                <span>{t(`general.sandbox.check.${key}`)}</span>
                <span className="sr-only">
                  {ok ? t('general.sandbox.status.yes') : t('general.sandbox.status.no')}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="text-note text-faint">{t('general.sandbox.diagnostics')}</p>
    </div>
  )
}

export function SandboxSettings() {
  const { t } = useTranslation('settings')
  const profile = useSessionStore((s) => s.settings?.sandboxProfile ?? 'workspace-write')
  const network = useSessionStore((s) => s.settings?.sandboxNetwork ?? 'none')
  const unavailable = useSessionStore((s) => s.settings?.sandboxUnavailable ?? 'deny')
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const sandboxStatus = useSessionStore((s) => s.sandboxStatus)
  const [status, setStatus] = useState<SandboxStatus | 'loading' | 'failed'>('loading')

  useEffect(() => {
    let cancelled = false
    void sandboxStatus().then((result) => {
      if (cancelled) return
      const parsed = SandboxStatusSchema.safeParse(result)
      setStatus(parsed.success ? parsed.data : 'failed')
    })
    return () => {
      cancelled = true
    }
  }, [sandboxStatus])

  const mechanism = status === 'loading' || status === 'failed' ? undefined : status.mechanism

  return (
    <SettingsGroup
      icon={<ShieldCheck />}
      title={t('general.sandbox.title')}
      description={t('general.sandbox.description')}
    >
      <Field
        label={t('general.sandbox.profile.label')}
        hint={`${t('general.sandbox.profile.hint')} ${t(`general.sandbox.profile.${profile}.hint`)}`}
      >
        <SegmentedControl
          label={t('general.sandbox.profile.label')}
          value={profile}
          options={PROFILE_OPTIONS.map((value) => ({
            value,
            label: t(`general.sandbox.profile.${value}`),
          }))}
          onChange={(next) => void updateSettings({ sandboxProfile: next })}
        />
      </Field>
      <Field
        label={t('general.sandbox.network.label')}
        hint={t(
          mechanism === 'appcontainer'
            ? 'general.sandbox.network.hintAppContainer'
            : 'general.sandbox.network.hintRestricted',
        )}
      >
        <SegmentedControl
          label={t('general.sandbox.network.label')}
          value={network}
          options={NETWORK_OPTIONS.map((value) => ({
            value,
            label: t(`general.sandbox.network.${value}`),
          }))}
          onChange={(next) => void updateSettings({ sandboxNetwork: next })}
        />
      </Field>
      <Field
        label={t('general.sandbox.unavailable.label')}
        hint={t('general.sandbox.unavailable.hint')}
      >
        <SegmentedControl
          label={t('general.sandbox.unavailable.label')}
          value={unavailable}
          options={UNAVAILABLE_OPTIONS.map((value) => ({
            value,
            label: t(`general.sandbox.unavailable.${value}`),
          }))}
          onChange={(next) => void updateSettings({ sandboxUnavailable: next })}
        />
      </Field>
      <CapabilityPanel status={status} />
    </SettingsGroup>
  )
}
