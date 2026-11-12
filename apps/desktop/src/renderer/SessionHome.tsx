/**
 * 右侧工作台首页：只保留当前项目文件树的紧凑预览。
 *
 * 上下文用量已移到输入框的圆环弹层，检查器和运行统计卡片不再占用右栏。
 */
import { FolderTree } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@cairn/core'
import type { FileTreeEntry, ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { FileTypeIcon, FolderTypeIcon } from './file-icons.js'
import { lastSegment } from './paths.js'
import { projectDisplayName } from './project-name.js'
import { useSessionStore } from './store-context.js'

const TREE_PREVIEW_LIMIT = 6
const EMPTY_PROJECTS: readonly ProjectSummary[] = []

function HomeCard({
  icon,
  title,
  onClick,
  children,
}: {
  readonly icon: ReactNode
  readonly title: string
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
      </span>
      <span className="flex min-w-0 flex-col gap-1 pl-8 text-note">{children}</span>
    </button>
  )
}

export function SessionHome({
  view,
  onOpenFiles,
}: {
  readonly view: SessionView | undefined
  readonly onOpenFiles: () => void
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
                  <FolderTypeIcon name={entry.name} />
                ) : (
                  <FileTypeIcon name={entry.name} />
                )}
                <span className="min-w-0 truncate">{entry.name}</span>
              </span>
            ))
          )}
        </HomeCard>
      </div>
    </div>
  )
}
