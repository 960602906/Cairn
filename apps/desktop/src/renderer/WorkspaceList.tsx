/**
 * 工作空间列表（目录功能同步）：项目行与右键/更多菜单。
 *
 * 菜单顺序与 LiveAgent 一致：置顶、配置、归档、在文件树浏览、在资源管理器浏览、
 * 最后是危险操作“移除工作空间”。归档项目收进独立分组，仍可取消归档。
 */
import {
  Archive,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderTree,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { useSessionStore } from './store-context.js'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog.js'
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/index.js'

/** 置顶在前；同组按最近使用时间倒序，再按名称。归档始终排在最后。 */
export function sortWorkspaceProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((left, right) => {
    const archived = Number(left.archivedAt !== undefined) - Number(right.archivedAt !== undefined)
    if (archived !== 0) return archived
    const pinned = Number(right.isPinned === true) - Number(left.isPinned === true)
    if (pinned !== 0) return pinned
    const activity = (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
    if (activity !== 0) return activity
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
}

function WorkspaceRow({
  project,
  onConfigure,
  onBrowseInFileTree,
  onNewConversation,
}: {
  readonly project: ProjectSummary
  readonly onConfigure: (project: ProjectSummary) => void
  readonly onBrowseInFileTree: (project: ProjectSummary) => void
  readonly onNewConversation?: ((project: ProjectSummary) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const updateProject = useSessionStore((s) => s.updateProject)
  const removeProject = useSessionStore((s) => s.removeProject)
  const [confirming, setConfirming] = useState(false)
  const archived = project.archivedAt !== undefined
  const pinned = project.isPinned === true

  const browseExplorer = () => {
    void getMainApi()?.request('fs.reveal', { projectId: project.projectId })
  }

  return (
    <li className="group relative">
      <div
        className={cn(
          'flex h-[33px] items-center gap-2 rounded-[7px] pr-7 pl-2.5 text-note text-fg2',
          archived ? 'opacity-65' : 'hover:bg-hover',
        )}
      >
        <Folder aria-hidden className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate" title={project.path}>
          {project.name}
        </span>
        {pinned && (
          <Pin aria-label={t('workspace.unpin')} className="size-3 shrink-0 text-accent" />
        )}
        {archived && (
          <span className="shrink-0 text-[10px] text-faint">{t('workspace.archived')}</span>
        )}
      </div>
      <div className="absolute top-[5px] right-1 flex items-center gap-0.5">
        {!archived && onNewConversation && (
          <button
            type="button"
            aria-label={t('workspace.newConversation')}
            className="inline-flex size-6 items-center justify-center rounded-[6px] text-muted opacity-60 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 [&_svg]:size-3.5"
            onClick={() => onNewConversation(project)}
          >
            <SquarePen />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('workspace.actions')}
              className="inline-flex size-6 items-center justify-center rounded-[6px] text-muted opacity-60 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-3.5"
            >
              <MoreHorizontal />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() => void updateProject(project.projectId, { pinned: !pinned })}
            >
              {pinned ? <PinOff /> : <Pin />}
              {t(pinned ? 'workspace.unpin' : 'workspace.pin')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onConfigure(project)}>
              <Settings />
              {t('workspace.configure')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void updateProject(project.projectId, { archived: !archived })}
            >
              <Archive />
              {t(archived ? 'workspace.unarchive' : 'workspace.archive')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onBrowseInFileTree(project)}>
              <FolderTree />
              {t('workspace.browseFileTree')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={browseExplorer}>
              <FolderOpen />
              {t('workspace.browseExplorer')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onSelect={() => setConfirming(true)}>
              <Trash2 />
              {t('workspace.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent tone="danger">
          <DialogTitle>{t('workspace.remove.title', { name: project.name })}</DialogTitle>
          <DialogDescription>{t('workspace.remove.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="danger"
              onClick={() => {
                setConfirming(false)
                void removeProject(project.projectId)
              }}
            >
              {t('workspace.remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

export function WorkspaceList({
  onConfigure,
  onBrowseInFileTree,
  onNewConversation,
}: {
  readonly onConfigure: (project: ProjectSummary) => void
  readonly onBrowseInFileTree: (project: ProjectSummary) => void
  readonly onNewConversation?: ((project: ProjectSummary) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const ordered = sortWorkspaceProjects(projects)
  const [collapsed, setCollapsed] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (typeof refreshProjects === 'function') void refreshProjects()
  }, [refreshProjects])

  return (
    <section aria-label={t('workspace.section')} className="mb-2">
      <div className="flex items-center gap-1 px-2 pb-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'workspace.expand' : 'workspace.collapse')}
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 items-center gap-1 rounded-[6px] px-1 py-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase hover:bg-hover hover:text-fg2"
        >
          <ChevronDown
            aria-hidden
            className={cn('size-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
          />
          <span className="truncate">{t('workspace.section')}</span>
          <span className="tabular text-[10px] font-normal">{projects.length}</span>
        </button>
        <button
          type="button"
          aria-label={t('workspace.create')}
          title={t('workspace.create')}
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-faint hover:bg-hover hover:text-fg [&_svg]:size-3.5"
        >
          <Plus />
        </button>
      </div>
      {!collapsed &&
        (ordered.length === 0 ? (
          <p className="px-2.5 py-1.5 text-note text-faint">{t('workspace.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {ordered.map((project) => (
              <WorkspaceRow
                key={project.projectId}
                project={project}
                onConfigure={onConfigure}
                onBrowseInFileTree={onBrowseInFileTree}
                onNewConversation={onNewConversation}
              />
            ))}
          </ul>
        ))}
      <WorkspaceCreateDialog open={creating} onOpenChange={setCreating} />
    </section>
  )
}
