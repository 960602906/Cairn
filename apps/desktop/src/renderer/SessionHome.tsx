/**
 * 右侧工作台首页：把当前会话最常用的入口摊成几张紧凑卡片。
 *
 * 文件树和检查始终显示；点击卡片在标签栏打开完整页面。
 * 改动从对话里的「本轮变更」进入，计划从对话里的计划卡片进入，都不在首页重复出现。
 * 首页只读，文件树等多写操作都在对应的标签页里完成。
 */
import { Activity, ChevronRight, File, Folder, FolderTree } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import type { FileTreeEntry, ProjectSummary, SessionStatus } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { formatCompactTokens } from './format.js'
import { lastSegment } from './paths.js'
import { projectDisplayName } from './project-name.js'
import { useSessionStore } from './store-context.js'
import { cn } from './ui/index.js'

const TREE_PREVIEW_LIMIT = 6
const EMPTY_PROJECTS: readonly ProjectSummary[] = []

function statusTone(status: SessionStatus): string {
  if (status === 'failed' || status === 'interrupted') return 'text-danger'
  if (status === 'waiting_approval') return 'text-warn'
  if (status === 'running') return 'text-accent'
  return 'text-muted'
}

function HomeCard({
  icon,
  title,
  meta,
  onClick,
  children,
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly meta?: ReactNode
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  const { t } = useTranslation('session')
  return (
    <button
      type="button"
      aria-label={t('sidePanel.openSection', { name: title })}
      onClick={onClick}
      className="group flex w-full flex-col gap-1.5 rounded-item px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-sunk text-muted transition-colors group-hover:text-fg2 [&_svg]:size-3.5">
          {icon}
        </span>
        <span className="min-w-0 text-ui font-medium text-fg">{title}</span>
        {meta !== undefined && (
          <span className="ml-auto flex min-w-0 items-center gap-2 text-note text-muted">
            {meta}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 shrink-0 text-faint', meta === undefined && 'ml-auto')}
        />
      </span>
      <span className="flex min-w-0 flex-col gap-1 pl-8 text-note">{children}</span>
    </button>
  )
}

export function SessionHome({
  view,
  status,
  onOpenFiles,
  onOpenInspector,
}: {
  readonly view: SessionView | undefined
  readonly status: SessionStatus
  readonly onOpenFiles: () => void
  readonly onOpenInspector: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const projects = useSessionStore((state) => state.projects ?? EMPTY_PROJECTS)
  const [entries, setEntries] = useState<readonly FileTreeEntry[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState(false)
  const projectPath = view?.info?.projectPath
  const project = useMemo<ProjectSummary | undefined>(
    () =>
      projectPath === undefined ? undefined : projects.find((item) => item.path === projectPath),
    [projectPath, projects],
  )
  const projectName = projectDisplayName(
    project,
    tc('project.defaultName'),
    projectPath === undefined ? '' : lastSegment(projectPath),
  )
  const contextTokens = view?.contextTokens
  const totalTokens =
    view === undefined ? undefined : view.usage.inputTokens + view.usage.outputTokens
  const runCount = view?.runOrder.length ?? 0

  useEffect(() => {
    if (project === undefined) {
      setEntries([])
      setTreeLoading(false)
      setTreeError(false)
      return
    }
    const api = getMainApi()
    if (!api) {
      setEntries([])
      setTreeLoading(false)
      setTreeError(false)
      return
    }
    let alive = true
    setTreeLoading(true)
    setTreeError(false)
    void api
      .request('fs.list', { projectId: project.projectId, limit: TREE_PREVIEW_LIMIT })
      .then((result) => {
        if (!alive) return
        setEntries(result?.entries ?? [])
      })
      .catch(() => {
        if (alive) setTreeError(true)
      })
      .finally(() => {
        if (alive) setTreeLoading(false)
      })
    return () => {
      alive = false
    }
  }, [project])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex shrink-0 items-start gap-2 px-4 pt-3 pb-2">
        <span className="min-w-0 flex-1">
          <h2 className="truncate text-ui font-semibold text-fg">{t('sidePanel.title')}</h2>
          <p className="mt-0.5 truncate text-note text-faint" title={projectPath}>
            {projectName === '' ? t('sidePanel.home.noProjectLabel') : projectName}
          </p>
        </span>
        <span className={cn('shrink-0 pt-0.5 text-note', statusTone(status))}>
          {t(`status.${status}`)}
        </span>
      </header>

      <div className="flex flex-col gap-0.5 px-2 pb-4">
        <HomeCard icon={<FolderTree />} title={t('sidePanel.files')} onClick={onOpenFiles}>
          {project === undefined ? (
            <span className="text-faint">{t('fileTree.noProject')}</span>
          ) : treeLoading ? (
            <span className="text-muted">{t('fileTree.loading')}</span>
          ) : treeError ? (
            <span className="text-faint">{t('sidePanel.home.treeError')}</span>
          ) : entries.length === 0 ? (
            <span className="text-faint">{t('fileTree.empty')}</span>
          ) : (
            entries.slice(0, TREE_PREVIEW_LIMIT).map((entry) => (
              <span key={entry.path} className="flex items-center gap-1.5 text-fg2">
                {entry.kind === 'dir' ? (
                  <Folder aria-hidden className="size-3.5 shrink-0 text-muted" />
                ) : (
                  <File aria-hidden className="size-3.5 shrink-0 text-muted" />
                )}
                <span className="min-w-0 truncate">{entry.name}</span>
              </span>
            ))
          )}
        </HomeCard>

        <HomeCard
          icon={<Activity />}
          title={t('sidePanel.inspectorShort')}
          meta={<span className={statusTone(status)}>{t(`status.${status}`)}</span>}
          onClick={onOpenInspector}
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
            <span>{t('sidePanel.home.runs', { count: runCount })}</span>
            {contextTokens !== undefined && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {t('sidePanel.home.context', { tokens: formatCompactTokens(contextTokens) })}
                </span>
              </>
            )}
            {totalTokens !== undefined && totalTokens > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {t('sidePanel.home.tokens', { tokens: formatCompactTokens(totalTokens) })}
                </span>
              </>
            )}
          </span>
          {runCount === 0 && <span className="text-faint">{t('sidePanel.home.noUsage')}</span>}
        </HomeCard>
      </div>
    </div>
  )
}
