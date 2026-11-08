/**
 * 右侧会话信息栏：文件改动、会话要点与完整计划。
 * 计划卡片在对话里只显示摘要，点击后切到这里查看详情并审批。
 */
import { Activity, ChevronRight, FileDiff, ListChecks, NotebookText, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import type { ChangeSetSummary } from '@cairn/protocol'
import { ChangeSetReview } from './ChangeSetReview.js'
import { ChangeCounts } from './DiffCard.js'
import { SessionChangesPanel } from './FileChanges.js'
import { Inspector } from './Inspector.js'
import { PlanDetails } from './PlanCard.js'
import { SessionBriefPanel } from './SessionBrief.js'
import { useSessionStore } from './store-context.js'
import { cn, IconButton, SegmentedControl } from './ui/index.js'

export type SessionPanel = 'diff' | 'brief' | 'plan' | 'inspector'

const PANELS = [
  { id: 'diff', label: 'sidePanel.diff', Icon: FileDiff },
  { id: 'brief', label: 'sidePanel.brief', Icon: NotebookText },
  { id: 'plan', label: 'sidePanel.plan', Icon: ListChecks },
  { id: 'inspector', label: 'sidePanel.inspector', Icon: Activity },
] as const

const EMPTY_CHANGE_SETS: readonly ChangeSetSummary[] = []

function ChangeSetList({
  sessionId,
  view,
  onSelect,
}: {
  readonly sessionId: string
  readonly view: SessionView | undefined
  readonly onSelect: (changeSetId: string) => void
}) {
  const { t } = useTranslation('session')
  const changeSets = useSessionStore((state) => state.changeSets?.[sessionId] ?? EMPTY_CHANGE_SETS)
  const loading = useSessionStore((state) => state.changeSetsLoading?.[sessionId] === true)
  const delegations = new Map(
    (view?.delegations ?? []).flatMap((delegation) =>
      delegation.completed?.changeSetId === undefined
        ? []
        : [[delegation.completed.changeSetId, delegation] as const],
    ),
  )
  if (loading && changeSets.length === 0) {
    return (
      <p role="status" className="px-4 py-3 text-ui text-muted">
        {t('changeset.loading')}
      </p>
    )
  }
  if (changeSets.length === 0) {
    return <p className="px-4 py-3 text-ui text-muted">{t('changeset.empty')}</p>
  }
  return (
    <ul aria-label={t('changeset.list')} className="divide-y-[0.5px] divide-hair">
      {changeSets.map((changeSet) => {
        const delegation = delegations.get(changeSet.changeSetId)
        return (
          <li key={changeSet.changeSetId}>
            <button
              type="button"
              onClick={() => onSelect(changeSet.changeSetId)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover"
            >
              <FileDiff aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-note font-medium text-fg2">
                    {delegation?.task ?? changeSet.changeSetId.slice(0, 8)}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]',
                      changeSet.status === 'applied'
                        ? 'bg-ok-soft text-ok'
                        : changeSet.status === 'rejected'
                          ? 'bg-danger-soft text-danger'
                          : 'bg-warn-soft text-warn',
                    )}
                  >
                    {t(`changeset.status.${changeSet.status}`)}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-note text-muted">
                  <span>{t('changeset.fileCount', { count: changeSet.files })}</span>
                  <ChangeCounts added={changeSet.added} removed={changeSet.removed} />
                  {changeSet.conflicts > 0 && (
                    <span className="text-warn">
                      {t('changeset.conflictCount', { count: changeSet.conflicts })}
                    </span>
                  )}
                </span>
              </span>
              <ChevronRight aria-hidden className="mt-1 size-3.5 shrink-0 text-faint" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function SessionSidePanel({
  sessionId,
  view,
  panel,
  selectedPlanId,
  selectedChangeSetId,
  onSelectChangeSet,
  onPanelChange,
  open = true,
  onClose,
  onLocateTurn,
}: {
  readonly sessionId: string
  readonly view: SessionView | undefined
  readonly panel: SessionPanel
  readonly selectedPlanId: string | undefined
  /** 从委派卡片、活动中心或检查器打开的改动集。 */
  readonly selectedChangeSetId?: string | undefined
  readonly onSelectChangeSet?: ((changeSetId: string | undefined) => void) | undefined
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
  const changeSets = useSessionStore((state) => state.changeSets?.[sessionId] ?? EMPTY_CHANGE_SETS)
  const [diffTab, setDiffTab] = useState<'changesets' | 'files'>('files')
  const autoSwitched = useRef(false)
  useEffect(() => {
    autoSwitched.current = false
    setDiffTab('files')
  }, [sessionId])
  useEffect(() => {
    if (!autoSwitched.current && changeSets.length > 0) {
      autoSwitched.current = true
      setDiffTab('changesets')
    }
  }, [changeSets.length])
  const delegation =
    selectedChangeSetId === undefined
      ? undefined
      : view?.delegations.find((item) => item.completed?.changeSetId === selectedChangeSetId)
  const openChangeSet = (changeSetId: string) => {
    onSelectChangeSet?.(changeSetId)
    onPanelChange('diff')
  }
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
          {panel === 'diff' &&
            (selectedChangeSetId !== undefined ? (
              <ChangeSetReview
                sessionId={sessionId}
                changeSetId={selectedChangeSetId}
                {...(delegation === undefined ? {} : { delegation })}
                {...(onSelectChangeSet === undefined
                  ? {}
                  : { onBack: () => onSelectChangeSet(undefined) })}
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex h-9 shrink-0 items-center justify-center border-b-[0.5px] border-hair">
                  <SegmentedControl
                    value={diffTab}
                    label={t('changeset.view')}
                    options={[
                      { value: 'changesets', label: t('changeset.tab.changesets') },
                      { value: 'files', label: t('changeset.tab.files') },
                    ]}
                    onChange={setDiffTab}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {diffTab === 'changesets' ? (
                    <div className="h-full overflow-y-auto">
                      <ChangeSetList
                        sessionId={sessionId}
                        view={view}
                        onSelect={(changeSetId) => onSelectChangeSet?.(changeSetId)}
                      />
                    </div>
                  ) : (
                    <SessionChangesPanel sessionId={sessionId} />
                  )}
                </div>
              </div>
            ))}
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
              {...(onSelectChangeSet === undefined ? {} : { onOpenChanges: openChangeSet })}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
