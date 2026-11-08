/**
 * 右侧会话信息栏：文件改动、会话要点与完整计划。
 * 计划卡片在对话里只显示摘要，点击后切到这里查看详情并审批。
 */
import { Activity, FileDiff, ListChecks, NotebookText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import { SessionChangesPanel } from './FileChanges.js'
import { Inspector } from './Inspector.js'
import { PlanDetails } from './PlanCard.js'
import { SessionBriefPanel } from './SessionBrief.js'
import { cn, IconButton } from './ui/index.js'

export type SessionPanel = 'diff' | 'brief' | 'plan' | 'inspector'

const PANELS = [
  { id: 'diff', label: 'sidePanel.diff', Icon: FileDiff },
  { id: 'brief', label: 'sidePanel.brief', Icon: NotebookText },
  { id: 'plan', label: 'sidePanel.plan', Icon: ListChecks },
  { id: 'inspector', label: 'sidePanel.inspector', Icon: Activity },
] as const

export function SessionSidePanel({
  sessionId,
  view,
  panel,
  selectedPlanId,
  onPanelChange,
  open = true,
  onClose,
  onLocateTurn,
}: {
  readonly sessionId: string
  readonly view: SessionView | undefined
  readonly panel: SessionPanel
  readonly selectedPlanId: string | undefined
  readonly onPanelChange: (panel: SessionPanel) => void
  /** 由顶栏按钮控制；窄窗口为浮层，宽窗口占用布局宽度。 */
  readonly open?: boolean
  readonly onClose?: () => void
  /** 从运行树定位到对话轮次。 */
  readonly onLocateTurn?: ((runId: string, turnId: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const plans = view?.plans ?? []
  const plan = plans.find((item) => item.planId === selectedPlanId) ?? plans.at(-1)
  return (
    <aside
      id="session-side-panel"
      aria-label={t('sidePanel.label')}
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'absolute inset-y-0 right-0 z-20 flex shrink-0 flex-col overflow-hidden bg-paper shadow-2',
        'transition-[width,transform,opacity] duration-200 ease-out motion-reduce:transition-none',
        'min-[1200px]:static min-[1200px]:z-auto min-[1200px]:shadow-none',
        open
          ? 'w-[304px] translate-x-0 opacity-100'
          : 'pointer-events-none w-0 translate-x-full opacity-0 min-[1200px]:translate-x-0',
      )}
    >
      <div className="flex h-full w-[304px] shrink-0 flex-col border-l-[0.5px] border-hair">
        <div className="flex h-12 shrink-0 items-center border-b-[0.5px] border-hair px-2">
          <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5">
            {PANELS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={panel === id}
                onClick={() => onPanelChange(id)}
                className={cn(
                  'flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-item px-1.5 text-note transition-colors',
                  panel === id
                    ? 'bg-raise font-medium text-fg shadow-hair2'
                    : 'text-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{t(label)}</span>
              </button>
            ))}
          </div>
          {onClose && (
            <IconButton
              label={t('sidePanel.close')}
              size="icon-sm"
              className="ml-1"
              onClick={onClose}
            >
              <X />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {panel === 'diff' && <SessionChangesPanel sessionId={sessionId} />}
          {panel === 'brief' && <SessionBriefPanel sessionId={sessionId} />}
          {panel === 'plan' && (
            <div className="h-full overflow-y-auto p-3">
              {plan ? (
                <PlanDetails key={plan.planId} plan={plan} />
              ) : (
                <p className="text-ui text-muted">{t('sidePanel.emptyPlan')}</p>
              )}
            </div>
          )}
          {panel === 'inspector' && (
            <Inspector
              sessionId={sessionId}
              delegations={view?.delegations ?? []}
              onLocate={onLocateTurn}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
