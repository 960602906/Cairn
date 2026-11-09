/**
 * 命令沙箱标记（M5-05）：终端、工具时间线与审批卡片共用。
 * 标记始终写明实际档位；未生效时写明原因，避免把“无网络”误读为网络已隔离。
 */
import { ShieldCheck, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SandboxExecution } from '@cairn/protocol'
import { sandboxLabels } from './sandbox-labels.js'
import { cn } from './ui/index.js'

export function SandboxBadge({
  execution,
  compact = false,
  className,
}: {
  readonly execution: SandboxExecution
  readonly compact?: boolean
  readonly className?: string
}) {
  const { t } = useTranslation('common')
  const labels = sandboxLabels(t, execution)
  const Icon = execution.enforced ? ShieldCheck : ShieldOff
  return (
    <span
      data-testid="sandbox-badge"
      data-sandbox-profile={execution.profile}
      data-sandbox-enforced={String(execution.enforced)}
      title={labels.warning ? `${labels.summary} — ${labels.warning}` : labels.summary}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-[5px] border-[0.5px] border-current/25 px-1.5 py-0.5 text-[11.5px] whitespace-nowrap',
        execution.enforced ? 'text-muted' : 'text-danger',
        compact && 'max-w-[230px]',
        className,
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{labels.summary}</span>
    </span>
  )
}
