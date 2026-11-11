/**
 * 右侧会话信息栏：文件改动、会话要点、完整计划与运行检查。
 * 计划卡片在对话里只显示摘要，点击后切到这里查看详情并审批。
 *
 * 视觉上它是对话纸面的延伸：和对话同一底色，只用一条发丝线分开，标签是一排安静的胶囊，
 * 不再有单独的标题栏和底色。常驻时由顶栏按钮开合，所以只在浮层模式下显示关闭按钮。
 */
import { ChevronRight, FileDiff, ListTodo, Plus, X } from 'lucide-react'
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
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  PanelEmpty,
  SegmentedControl,
} from './ui/index.js'

export type SessionPanel = 'diff' | 'brief' | 'plan' | 'inspector'

const PANELS = [
  { id: 'diff', label: 'sidePanel.diff' },
  { id: 'brief', label: 'sidePanel.briefShort' },
  { id: 'plan', label: 'sidePanel.plan' },
  { id: 'inspector', label: 'sidePanel.inspectorShort' },
] as const

/** 全部面板，按固定顺序；标签栏按这个顺序排列已打开的标签。 */
export const SESSION_PANELS: readonly SessionPanel[] = PANELS.map((item) => item.id)

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
  // 列表为空且不在加载时，上层不显示这个标签页（见 hasChangeSets）。
  return (
    <ul aria-label={t('changeset.list')} className="flex flex-col gap-0.5 px-2 pb-2">
      {changeSets.map((changeSet) => {
        const delegation = delegations.get(changeSet.changeSetId)
        return (
          <li key={changeSet.changeSetId}>
            <button
              type="button"
              onClick={() => onSelect(changeSet.changeSetId)}
              className="flex w-full items-start gap-2 rounded-item px-2 py-2 text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
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
  tabs = SESSION_PANELS,
  onCloseTab,
  open = true,
  placement = 'side',
  docked = false,
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
  /** 已打开的标签；默认全部打开。给出 `onCloseTab` 后每个标签可以关闭，未打开的从「+」菜单打开。 */
  readonly tabs?: readonly SessionPanel[]
  readonly onCloseTab?: ((panel: SessionPanel) => void) | undefined
  /** 由顶栏按钮控制；窄窗口为浮层，宽窗口占用布局宽度。 */
  readonly open?: boolean
  /** 叠层布局把工作台放在对话下方；`side` 保持原有的右侧浮层/侧栏。 */
  readonly placement?: 'side' | 'bottom'
  /** 宽屏时占用布局宽度；窄屏时作为右侧浮层。 */
  readonly docked?: boolean
  readonly onClose?: () => void
  /** 从运行树定位到对话轮次。 */
  readonly onLocateTurn?: ((runId: string, turnId: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const bottom = placement === 'bottom'
  const plans = view?.plans ?? []
  const plan = plans.find((item) => item.planId === selectedPlanId) ?? plans.at(-1)
  const changeSets = useSessionStore((state) => state.changeSets?.[sessionId] ?? EMPTY_CHANGE_SETS)
  const changeSetsLoading = useSessionStore(
    (state) => state.changeSetsLoading?.[sessionId] === true,
  )
  // 改动集只在委派子运行后才有；没有时不显示这层切换，直接列出文件改动。
  const hasChangeSets = changeSets.length > 0 || changeSetsLoading
  const [diffTab, setDiffTab] = useState<'changesets' | 'files'>('files')
  const autoSwitched = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
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
  // 浮层模式是模态的：把焦点收进面板，Tab 在面板内循环，关闭后还给原控件。
  useEffect(() => {
    if (!open || docked) return
    const panel = panelRef.current
    if (!panel) return
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const focusable = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getAttribute('aria-hidden') !== 'true')
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      if (
        document.querySelector(
          '[role="menu"], [role="listbox"], [role="dialog"]:not([data-side-panel-dialog]):not([aria-hidden="true"])',
        )
      )
        return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? index <= 0
          ? items.length - 1
          : index - 1
        : index === items.length - 1
          ? 0
          : index + 1
      event.preventDefault()
      items[next]?.focus()
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [docked, open])
  return (
    <aside
      ref={panelRef}
      id="session-side-panel"
      role={docked ? 'complementary' : 'dialog'}
      aria-label={t('sidePanel.label')}
      aria-modal={docked ? undefined : true}
      aria-hidden={!open}
      inert={!open}
      data-side-panel-dialog={docked ? undefined : ''}
      className={cn(
        'flex shrink-0 flex-col overflow-hidden bg-paper',
        bottom
          ? 'relative h-full min-h-0 w-full border-t-[0.5px] border-hair'
          : cn(
              'w-[348px]',
              docked
                ? 'static z-auto border-l-[0.5px] border-hair'
                : 'absolute inset-y-0 right-0 z-20 shadow-3',
              'transition-[width,transform,opacity] duration-200 ease-out motion-reduce:transition-none',
              open
                ? 'translate-x-0 opacity-100'
                : 'pointer-events-none w-0 translate-x-full opacity-0',
            ),
      )}
    >
      <div className={cn('flex h-full shrink-0 flex-col', bottom ? 'w-full' : 'w-[348px]')}>
        <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-2.5">
          <div role="tablist" className="flex min-w-0 items-center gap-0.5">
            {PANELS.filter(({ id }) => tabs.includes(id)).map(({ id, label }) => {
              const full = t(
                id === 'brief'
                  ? 'sidePanel.brief'
                  : id === 'inspector'
                    ? 'sidePanel.inspector'
                    : label,
              )
              const selected = panel === id
              return (
                <div
                  key={id}
                  className={cn(
                    'group/tab flex h-7 min-w-0 items-center rounded-item transition-colors',
                    selected ? 'bg-sunk text-fg' : 'text-muted hover:bg-hover hover:text-fg2',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={full}
                    aria-selected={selected}
                    onClick={() => onPanelChange(id)}
                    className={cn(
                      'flex h-7 min-w-0 items-center rounded-item pl-2.5 text-note outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      onCloseTab ? 'pr-1' : 'pr-2.5',
                      selected && 'font-medium',
                    )}
                  >
                    <span className="truncate">{t(label)}</span>
                  </button>
                  {onCloseTab && (
                    <button
                      type="button"
                      aria-label={t('sidePanel.closeTab', { name: full })}
                      onClick={() => onCloseTab(id)}
                      className={cn(
                        'mr-1 grid size-4 shrink-0 place-items-center rounded-[4px] text-faint outline-none transition-opacity hover:bg-press hover:text-fg focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent',
                        selected ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
                      )}
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {onCloseTab && tabs.length < PANELS.length && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t('sidePanel.addTab')} size="icon-sm">
                  <Plus />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[140px]">
                {PANELS.filter(({ id }) => !tabs.includes(id)).map(({ id, label }) => (
                  <DropdownMenuItem key={id} onSelect={() => onPanelChange(id)}>
                    {t(label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="flex-1" />
          {onClose && !docked && (
            <IconButton label={t('sidePanel.close')} size="icon-sm" onClick={onClose}>
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
                {hasChangeSets && (
                  <div className="flex shrink-0 items-center px-3 pt-1 pb-2">
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
                )}
                <div className="min-h-0 flex-1 overflow-hidden">
                  {hasChangeSets && diffTab === 'changesets' ? (
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
            <div className="h-full overflow-y-auto">
              {plan ? (
                <PlanDetails key={plan.planId} plan={plan} />
              ) : (
                <PanelEmpty icon={<ListTodo />}>{t('sidePanel.emptyPlan')}</PanelEmpty>
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
