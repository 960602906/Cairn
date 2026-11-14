/**
 * 工作空间列表（目录功能同步）：工作空间行下直接列出各自的会话，行与菜单负责项目管理。
 *
 * 菜单顺序与 LiveAgent 一致：置顶、重命名、归档、在资源管理器浏览，最后是危险操作
 * “移除工作空间”。归档的工作空间默认隐藏，打开侧栏的“显示已归档”后仍在原位显示，可取消归档。
 */
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { PROJECT_NAME_MAX_LENGTH, type ProjectSummary, type SessionSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { FolderTypeIcon } from './file-icons.js'
import { lastSegment } from './paths.js'
import { projectDisplayName } from './project-name.js'
import { SessionItem } from './SessionList.js'
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

/** 每个工作空间默认只展示最近这么多条会话，避免侧栏被单个工作空间撑满。 */
const WORKSPACE_SESSION_PREVIEW = 8

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
  sessions,
  activeSessionId,
  onSelectSession,
  onNewConversation,
}: {
  readonly project: ProjectSummary
  /** 该工作空间的会话（最近更新在前）。 */
  readonly sessions: readonly SessionSummary[]
  readonly activeSessionId: string | undefined
  readonly onSelectSession: (sessionId: string) => void
  readonly onNewConversation?: ((project: ProjectSummary) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const updateProject = useSessionStore((s) => s.updateProject)
  const removeProject = useSessionStore((s) => s.removeProject)
  const isDefault = project.isDefault === true
  const displayName = projectDisplayName(project, tc('project.defaultName'))
  const [confirming, setConfirming] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(displayName)
  const [savingName, setSavingName] = useState(false)
  const [renameFailed, setRenameFailed] = useState(false)
  const archived = project.archivedAt !== undefined
  const pinned = project.isPinned === true
  const visible = showAll ? sessions : sessions.slice(0, WORKSPACE_SESSION_PREVIEW)
  const remaining = sessions.length - visible.length

  const browseExplorer = () => {
    void getMainApi()?.request('fs.reveal', { projectId: project.projectId })
  }

  const openRename = () => {
    setNameDraft(displayName)
    setRenameFailed(false)
    setRenaming(true)
  }

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const next = nameDraft.trim()
    if (savingName || next === '' || next === project.name) {
      if (next === project.name || next === '') setRenaming(false)
      return
    }
    setSavingName(true)
    setRenameFailed(false)
    const saved = await updateProject(project.projectId, { name: next })
    setSavingName(false)
    if (saved) {
      setRenaming(false)
      return
    }
    setRenameFailed(true)
  }

  return (
    <li className="group relative">
      <div
        className={cn(
          'flex h-[33px] items-center rounded-[7px] pr-7 pl-1 text-note text-fg2',
          archived ? 'opacity-65' : 'hover:bg-hover',
        )}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={t('workspace.toggleSessions', { name: displayName })}
          title={project.path}
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1.5 py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3 shrink-0 text-faint transition-transform duration-200',
              !collapsed && 'rotate-90',
            )}
          />
          <FolderTypeIcon name={lastSegment(project.path)} expanded={!collapsed} />
          <span className="min-w-0 flex-1 truncate">{displayName}</span>
          {pinned && (
            <Pin aria-label={t('workspace.unpin')} className="size-3 shrink-0 text-accent" />
          )}
          {archived && (
            <span className="shrink-0 text-[11px] text-faint">{t('workspace.archived')}</span>
          )}
        </button>
      </div>
      {!collapsed && visible.length > 0 && (
        <div className="mt-0.5 pl-5">
          <ul className="flex flex-col gap-px">
            {visible.map((session) => (
              <SessionItem
                key={session.sessionId}
                session={session}
                active={session.sessionId === activeSessionId}
                onSelect={() => onSelectSession(session.sessionId)}
              />
            ))}
          </ul>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex h-6 w-full items-center rounded-[6px] px-2 text-left text-[11px] text-faint outline-none transition-colors hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent"
            >
              {t('list.showMore', { count: remaining })}
            </button>
          )}
          {remaining === 0 && showAll && sessions.length > WORKSPACE_SESSION_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="flex h-6 w-full items-center rounded-[6px] px-2 text-left text-[11px] text-faint outline-none transition-colors hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent"
            >
              {t('list.showLess')}
            </button>
          )}
        </div>
      )}
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
            {!isDefault && (
              <DropdownMenuItem onSelect={openRename}>
                <Pencil />
                {t('workspace.rename')}
              </DropdownMenuItem>
            )}
            {!isDefault && (
              <DropdownMenuItem
                onSelect={() => void updateProject(project.projectId, { archived: !archived })}
              >
                <Archive />
                {t(archived ? 'workspace.unarchive' : 'workspace.archive')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={browseExplorer}>
              <FolderOpen />
              {t('workspace.browseExplorer')}
            </DropdownMenuItem>
            {!isDefault && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setConfirming(true)}>
                  <Trash2 />
                  {t('workspace.remove')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="w-[min(420px,calc(100vw-32px))]">
          <DialogTitle>{t('workspace.rename.title')}</DialogTitle>
          <DialogDescription>{t('workspace.rename.description')}</DialogDescription>
          <form onSubmit={(event) => void rename(event)}>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-note font-medium text-fg2">
                {t('workspace.rename.name')}
              </span>
              <input
                autoFocus
                value={nameDraft}
                maxLength={PROJECT_NAME_MAX_LENGTH}
                onChange={(event) => setNameDraft(event.target.value)}
                className="h-9 w-full rounded-item bg-raise px-3 text-ui text-fg shadow-hair2 outline-none placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)]"
              />
            </label>
            {renameFailed && (
              <p role="alert" className="mt-3 text-note text-danger">
                {t('workspace.rename.failed')}
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg">{tc('action.cancel')}</Button>
              </DialogClose>
              <Button
                type="submit"
                size="lg"
                variant="primary"
                disabled={savingName || nameDraft.trim() === ''}
              >
                {t('workspace.rename.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {!isDefault && (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent tone="danger">
            <DialogTitle>{t('workspace.remove.title', { name: displayName })}</DialogTitle>
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
      )}
    </li>
  )
}

export function WorkspaceList({
  onNewConversation,
  onSelectSession,
}: {
  readonly onNewConversation?: ((project: ProjectSummary) => void) | undefined
  /** 选中会话后收起窄窗口里的抽屉。 */
  readonly onSelectSession?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const projects = useSessionStore((s) => s.projects)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const sessions = useSessionStore((s) => s.sessions) ?? []
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const showArchivedSessions = useSessionStore((s) => s.showArchivedSessions)
  const setShowArchivedSessions = useSessionStore((s) => s.setShowArchivedSessions)
  // 归档的工作空间默认不进侧栏；打开“显示已归档”后一并列出（与归档会话同一个开关）
  const ordered = sortWorkspaceProjects(projects).filter(
    (project) => showArchivedSessions || project.archivedAt === undefined,
  )
  const [collapsed, setCollapsed] = useState(false)
  const [creating, setCreating] = useState(false)
  const sessionsByPath = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const list = sessionsByPath.get(session.projectPath)
    if (list) list.push(session)
    else sessionsByPath.set(session.projectPath, [session])
  }

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
          className="flex min-w-0 items-center gap-1 rounded-[6px] px-1 py-0.5 text-[11.5px] font-semibold tracking-[0.02em] text-muted outline-none hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ChevronDown
            aria-hidden
            className={cn('size-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
          />
          <span className="truncate">{t('workspace.section')}</span>
          <span className="tabular text-[10.5px] font-normal text-faint">{ordered.length}</span>
        </button>
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-label={t(showArchivedSessions ? 'list.hideArchived' : 'list.showArchived')}
            title={t(showArchivedSessions ? 'list.hideArchived' : 'list.showArchived')}
            aria-pressed={showArchivedSessions}
            onClick={() => void setShowArchivedSessions(!showArchivedSessions)}
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] hover:bg-hover hover:text-fg [&_svg]:size-3.5',
              showArchivedSessions ? 'bg-press text-fg' : 'text-faint',
            )}
          >
            <Archive />
          </button>
          <button
            type="button"
            aria-label={t('workspace.create')}
            title={t('workspace.create')}
            onClick={() => setCreating(true)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-faint hover:bg-hover hover:text-fg [&_svg]:size-3.5"
          >
            <Plus />
          </button>
        </span>
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
                sessions={sessionsByPath.get(project.path) ?? []}
                activeSessionId={activeSessionId}
                onSelectSession={(sessionId) => {
                  void selectSession?.(sessionId)
                  onSelectSession?.()
                }}
                onNewConversation={onNewConversation}
              />
            ))}
          </ul>
        ))}
      <WorkspaceCreateDialog open={creating} onOpenChange={setCreating} />
    </section>
  )
}
