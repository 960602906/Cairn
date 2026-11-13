/**
 * 右侧工作台的面板内容与注册表。
 *
 * 每个面板是一个独立组件，只依赖 `SessionPanelContext`；新增面板（例如子 Agent 详情）时，
 * 写一个内容组件并在 `SESSION_PANEL_DEFINITIONS` 里追加一条定义即可。只有 `addable` 的面板
 * 会出现在「+」菜单；改动、概要、计划这类对话里点开的内容不主动列出来。
 */
import { ChevronRight, FileDiff, ListTodo } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import type { ChangeSetSummary, ProjectSummary, SessionStatus } from '@cairn/protocol'
import { ChangeSetReview } from './ChangeSetReview.js'
import { ChangeCounts } from './DiffCard.js'
import { SessionChangesPanel } from './FileChanges.js'
import { FileTreeBrowser } from './FileTreeBrowser.js'
import { PlanDetails } from './PlanCard.js'
import { SessionBriefPanel } from './SessionBrief.js'
import { useSessionStore } from './store-context.js'
import { cn, PanelEmpty, SegmentedControl } from './ui/index.js'

export type SessionPanel = 'files' | 'diff' | 'brief' | 'plan'
/** 文件预览标签的标识：`file:` + 相对项目根的路径。 */
export type FileTabId = `file:${string}`
/** 标签栏里的一项：固定面板或一个文件。 */
export type SessionTab = SessionPanel | FileTabId
export type SessionPanelView = SessionTab | 'home'

export const fileTabId = (path: string): FileTabId => `file:${path}`
export const fileTabPath = (tab: FileTabId): string => tab.slice('file:'.length)
export const isFileTab = (tab: SessionPanelView): tab is FileTabId => tab.startsWith('file:')

/** 面板内容共享的会话上下文；新增面板时从这里取需要的字段。 */
export interface SessionPanelContext {
  readonly sessionId: string
  readonly view: SessionView | undefined
  readonly status: SessionStatus
  /** 当前标签是否可见；文件树在后台隐藏时不再重新加载。 */
  readonly active: boolean
  /** 单击文件时打开预览标签。 */
  readonly onOpenFile?: ((path: string) => void) | undefined
  /** 文件树重命名后同步已打开的文件标签。 */
  readonly onFileRenamed?: ((from: string, to: string) => void) | undefined
  /** 文件树删除后关闭受影响的文件标签。 */
  readonly onFileDeleted?: ((path: string) => void) | undefined
  readonly selectedPlanId: string | undefined
  readonly selectedChangeSetId: string | undefined
  readonly onSelectChangeSet?: ((changeSetId: string | undefined) => void) | undefined
  readonly onOpenPanel: (panel: SessionPanel) => void
}

export interface SessionPanelDefinition {
  readonly id: SessionPanel
  /** 标签栏里的短名字。 */
  readonly shortLabel: string
  /** 无障碍名称与关闭按钮使用的完整名字。 */
  readonly label: string
  /** 是否在标签栏的「+」菜单里主动列出；只能从对话打开的面板设为 `false`。 */
  readonly addable: boolean
  readonly content: ComponentType<SessionPanelContext>
}

const EMPTY_PROJECTS: readonly ProjectSummary[] = []
const EMPTY_CHANGE_SETS: readonly ChangeSetSummary[] = []

function FilesPanel({
  view,
  active,
  onOpenFile,
  onFileRenamed,
  onFileDeleted,
}: SessionPanelContext) {
  const projects = useSessionStore((state) => state.projects ?? EMPTY_PROJECTS)
  const projectPath = view?.info?.projectPath
  const project = projects.find((item) => item.path === projectPath)
  return (
    <FileTreeBrowser
      project={project}
      variant="panel"
      active={active}
      {...(onOpenFile === undefined ? {} : { onOpenFile })}
      {...(onFileRenamed === undefined ? {} : { onFileRenamed })}
      {...(onFileDeleted === undefined ? {} : { onFileDeleted })}
    />
  )
}

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

function DiffPanel({
  sessionId,
  view,
  selectedChangeSetId,
  onSelectChangeSet,
}: SessionPanelContext) {
  const { t } = useTranslation('session')
  const changeSets = useSessionStore((state) => state.changeSets?.[sessionId] ?? EMPTY_CHANGE_SETS)
  const changeSetsLoading = useSessionStore(
    (state) => state.changeSetsLoading?.[sessionId] === true,
  )
  // 改动集只在委派子运行后才有；没有时不显示这层切换，直接列出文件改动。
  const hasChangeSets = changeSets.length > 0 || changeSetsLoading
  const [diffTab, setDiffTab] = useState<'changesets' | 'files'>('files')
  const autoSwitched = useRef(false)
  const delegation =
    selectedChangeSetId === undefined
      ? undefined
      : view?.delegations.find((item) => item.completed?.changeSetId === selectedChangeSetId)
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
  if (selectedChangeSetId !== undefined) {
    return (
      <ChangeSetReview
        sessionId={sessionId}
        changeSetId={selectedChangeSetId}
        {...(delegation === undefined ? {} : { delegation })}
        {...(onSelectChangeSet === undefined ? {} : { onBack: () => onSelectChangeSet(undefined) })}
      />
    )
  }
  return (
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
  )
}

function BriefPanel({ sessionId }: SessionPanelContext) {
  return <SessionBriefPanel sessionId={sessionId} />
}

function PlanPanel({ view, selectedPlanId, status }: SessionPanelContext) {
  const { t } = useTranslation('session')
  const plans = view?.plans ?? []
  const plan = plans.find((item) => item.planId === selectedPlanId) ?? plans.at(-1)
  return (
    <div className="h-full overflow-y-auto">
      {plan ? (
        <PlanDetails key={plan.planId} plan={plan} running={status === 'running'} />
      ) : (
        <PanelEmpty icon={<ListTodo />}>{t('sidePanel.emptyPlan')}</PanelEmpty>
      )}
    </div>
  )
}

/**
 * 面板注册表：顺序就是标签栏与「+」菜单里的顺序。
 * 子 Agent 详情等新面板追加到这里即可，不需要再改 `SessionSidePanel`。
 */
export const SESSION_PANEL_DEFINITIONS: readonly SessionPanelDefinition[] = [
  {
    id: 'files',
    shortLabel: 'sidePanel.filesShort',
    label: 'sidePanel.files',
    addable: true,
    content: FilesPanel,
  },
  {
    id: 'diff',
    shortLabel: 'sidePanel.diff',
    label: 'sidePanel.diff',
    addable: false,
    content: DiffPanel,
  },
  {
    id: 'brief',
    shortLabel: 'sidePanel.briefShort',
    label: 'sidePanel.brief',
    addable: false,
    content: BriefPanel,
  },
  {
    id: 'plan',
    shortLabel: 'sidePanel.plan',
    label: 'sidePanel.plan',
    addable: false,
    content: PlanPanel,
  },
]

export const SESSION_PANELS: readonly SessionPanel[] = SESSION_PANEL_DEFINITIONS.map(
  (item) => item.id,
)

export function SessionPanelContent({
  panel,
  ...context
}: SessionPanelContext & { readonly panel: SessionPanel }) {
  const definition = SESSION_PANEL_DEFINITIONS.find((item) => item.id === panel)
  if (!definition) return null
  const Content = definition.content
  return <Content {...context} />
}
