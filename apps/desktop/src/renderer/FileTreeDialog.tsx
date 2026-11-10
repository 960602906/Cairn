/**
 * 工作空间文件树（目录功能同步）：懒加载目录、展开/折叠、搜索过滤、
 * 新建文件/目录、重命名、删除、复制路径与在系统文件管理器中定位。
 *
 * 数据来自 `fs.*` RPC；只展示当前项目的相对路径。
 */
import {
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileTreeEntry, ProjectSummary } from '@cairn/protocol'
import { getMainApi } from './api.js'
import { projectDisplayName } from './project-name.js'
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
  Spinner,
} from './ui/index.js'

type Children = Readonly<Record<string, readonly FileTreeEntry[]>>
type Draft = { kind: 'file' | 'dir'; parent: string; value: string }

const join = (parent: string, name: string) => (parent === '' ? name : `${parent}/${name}`)

export function FileTreeDialog({
  project,
  open,
  onOpenChange,
}: {
  readonly project: ProjectSummary | undefined
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const [children, setChildren] = useState<Children>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']))
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [renameTarget, setRenameTarget] = useState<FileTreeEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<FileTreeEntry | null>(null)

  const load = useCallback(
    async (dir: string, force = false) => {
      if (!project) return
      if (!force && children[dir] !== undefined) return
      setLoading((current) => new Set(current).add(dir))
      setError(null)
      try {
        const result = await getMainApi()?.request('fs.list', {
          projectId: project.projectId,
          ...(dir === '' ? {} : { path: dir }),
          showHidden,
        })
        if (result) setChildren((current) => ({ ...current, [dir]: result.entries }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading((current) => {
          const next = new Set(current)
          next.delete(dir)
          return next
        })
      }
    },
    [children, project, showHidden],
  )

  useEffect(() => {
    if (!open || !project) return
    setChildren({})
    setExpanded(new Set(['']))
    setSelected('')
    setQuery('')
    setError(null)
    void load('', true)
    // 只在新项目或面板重新打开时重置，不跟随 children/load 的引用变化。
  }, [open, project?.projectId, showHidden])

  const toggle = (entry: FileTreeEntry) => {
    setSelected(entry.path)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (!expanded.has(entry.path)) void load(entry.path)
  }

  const refresh = () => {
    setChildren({})
    void load('', true)
    for (const dir of expanded) if (dir !== '') void load(dir, true)
  }

  const runAction = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const submitDraft = async () => {
    if (!project || !draft || draft.value.trim() === '') return
    const name = draft.value.trim()
    const path = join(draft.parent, name)
    await runAction(async () => {
      await getMainApi()?.request('fs.create', {
        projectId: project.projectId,
        path,
        kind: draft.kind,
      })
      setDraft(null)
      await load(draft.parent, true)
      if (draft.kind === 'dir') {
        setExpanded((current) => new Set(current).add(path))
      }
      setSelected(path)
    })
  }

  const submitRename = async () => {
    if (!project || !renameTarget || renameValue.trim() === '') return
    const to = join(renameTarget.path.split('/').slice(0, -1).join('/'), renameValue.trim())
    await runAction(async () => {
      await getMainApi()?.request('fs.rename', {
        projectId: project.projectId,
        from: renameTarget.path,
        to,
      })
      setRenameTarget(null)
      await refresh()
      setSelected(to)
    })
  }

  const submitDelete = async () => {
    if (!project || !deleteTarget) return
    await runAction(async () => {
      await getMainApi()?.request('fs.delete', {
        projectId: project.projectId,
        path: deleteTarget.path,
      })
      setDeleteTarget(null)
      await refresh()
    })
  }

  const copyPath = (path: string) => {
    const full = project ? `${project.path.replace(/[\\/]+$/, '')}/${path}` : path
    void navigator.clipboard?.writeText(full)
  }

  const reveal = (path?: string) => {
    if (!project) return
    void getMainApi()?.request('fs.reveal', {
      projectId: project.projectId,
      ...(path ? { path } : {}),
    })
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return children
    const filtered: Record<string, FileTreeEntry[]> = {}
    for (const [dir, entries] of Object.entries(children)) {
      filtered[dir] = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    }
    return filtered
  }, [children, query])

  const renderRows = (dir: string, depth: number): ReactNode => {
    const entries = visible[dir] ?? []
    return entries.map((entry) => {
      const isDir = entry.kind === 'dir'
      const isExpanded = expanded.has(entry.path)
      const isLoading = loading.has(entry.path)
      return (
        <li key={entry.path}>
          <div
            className={cn(
              'group flex h-[28px] cursor-default items-center gap-1 rounded-[6px] pr-1 text-note',
              selected === entry.path ? 'bg-accent-soft text-fg' : 'text-fg2 hover:bg-hover',
              entry.hidden && 'opacity-65',
            )}
            style={{ paddingLeft: 4 + depth * 14 }}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => (isDir ? toggle(entry) : copyPath(entry.path))}
          >
            <button
              type="button"
              aria-label={isExpanded ? t('fileTree.collapse') : t('fileTree.expand')}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded hover:bg-raise',
                !isDir && 'invisible',
              )}
              onClick={(event) => {
                event.stopPropagation()
                toggle(entry)
              }}
            >
              {isLoading ? (
                <Spinner className="size-3" />
              ) : (
                <ChevronRight
                  className={cn('size-3.5 transition-transform', isExpanded && 'rotate-90')}
                />
              )}
            </button>
            {isDir ? (
              isExpanded ? (
                <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted" />
              ) : (
                <Folder aria-hidden className="size-3.5 shrink-0 text-muted" />
              )
            ) : (
              <File aria-hidden className="size-3.5 shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('fileTree.actions')}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted opacity-60 transition-opacity group-hover:opacity-100 hover:bg-raise hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-3.5"
                >
                  <MoreHorizontal />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameTarget(entry)
                    setRenameValue(entry.name)
                  }}
                >
                  <Pencil />
                  {t('fileTree.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copyPath(entry.path)}>
                  <Copy />
                  {t('fileTree.copyPath')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => reveal(entry.path)}>
                  <FolderOpen />
                  {t('fileTree.reveal')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setDeleteTarget(entry)}>
                  <Trash2 />
                  {t('fileTree.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {isDir && isExpanded ? <ul>{renderRows(entry.path, depth + 1)}</ul> : null}
        </li>
      )
    })
  }

  const parentDir = selected === '' ? '' : selected.split('/').slice(0, -1).join('/')
  const selectedEntry =
    selected === '' ? undefined : children[parentDir]?.find((entry) => entry.path === selected)
  const draftParent = selectedEntry?.kind === 'dir' ? selectedEntry.path : parentDir

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(640px,calc(100vh-80px))] w-[min(760px,calc(100vw-48px))] flex-col p-0">
        <header className="flex shrink-0 items-center gap-3 border-b-[0.5px] border-hair px-4 py-3">
          <FolderOpen aria-hidden className="size-4 text-muted" />
          <DialogTitle className="min-w-0 flex-1 truncate text-ui">
            {projectDisplayName(project, tc('project.defaultName'), t('fileTree.title'))}
          </DialogTitle>
          <button
            type="button"
            aria-label={t('fileTree.close')}
            className="inline-flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-hover hover:text-fg"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b-[0.5px] border-hair px-3 py-2">
          <input
            aria-label={t('fileTree.search')}
            placeholder={t('fileTree.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded-[6px] bg-sunk px-2 text-note text-fg outline-none placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)]"
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('fileTree.newFile')}
            onClick={() => setDraft({ kind: 'file', parent: draftParent, value: '' })}
          >
            <Plus />
            {t('fileTree.newFile')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('fileTree.newFolder')}
            onClick={() => setDraft({ kind: 'dir', parent: draftParent, value: '' })}
          >
            <Plus />
            {t('fileTree.newFolder')}
          </Button>
          <button
            type="button"
            aria-label={t('fileTree.refresh')}
            className="inline-flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-hover hover:text-fg"
            onClick={refresh}
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t(showHidden ? 'fileTree.hideHidden' : 'fileTree.showHidden')}
            className="inline-flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-hover hover:text-fg"
            onClick={() => setShowHidden((current) => !current)}
          >
            {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="shrink-0 border-b-[0.5px] border-hair px-4 py-2 text-note text-danger"
          >
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading.has('') && children[''] === undefined ? (
            <p role="status" className="px-3 py-2 text-note text-muted">
              {t('fileTree.loading')}
            </p>
          ) : (visible[''] ?? []).length === 0 ? (
            <p className="px-3 py-2 text-note text-faint">{t('fileTree.empty')}</p>
          ) : (
            <ul>{renderRows('', 0)}</ul>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t-[0.5px] border-hair px-4 py-2 text-[11px] text-faint">
          <span className="truncate" title={project?.path}>
            {project?.path}
          </span>
          <span className="ml-auto">{t('fileTree.hint')}</span>
        </footer>
      </DialogContent>

      <Dialog open={draft !== null} onOpenChange={(next) => !next && setDraft(null)}>
        <DialogContent>
          <DialogTitle>
            {t(draft?.kind === 'dir' ? 'fileTree.newFolder' : 'fileTree.newFile')}
          </DialogTitle>
          <DialogDescription>
            {draft?.parent || projectDisplayName(project, tc('project.defaultName'))}
          </DialogDescription>
          <input
            autoFocus
            aria-label={t('fileTree.name')}
            className="mt-4 h-9 w-full rounded-item bg-sunk px-3 text-ui text-fg outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]"
            value={draft?.value ?? ''}
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, value: event.target.value } : current))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitDraft()
            }}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button size="lg" variant="primary" onClick={() => void submitDraft()}>
              {tc('action.ok')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(next) => !next && setRenameTarget(null)}>
        <DialogContent>
          <DialogTitle>{t('fileTree.rename')}</DialogTitle>
          <DialogDescription>{renameTarget?.path}</DialogDescription>
          <input
            autoFocus
            aria-label={t('fileTree.name')}
            className="mt-4 h-9 w-full rounded-item bg-sunk px-3 text-ui text-fg outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename()
            }}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button size="lg" variant="primary" onClick={() => void submitRename()}>
              {tc('action.ok')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <DialogContent tone="danger">
          <DialogTitle>{t('fileTree.deleteTitle', { name: deleteTarget?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('fileTree.deleteDescription')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button size="lg" variant="danger" onClick={() => void submitDelete()}>
              {t('fileTree.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
