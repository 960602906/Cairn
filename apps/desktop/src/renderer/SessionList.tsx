/**
 * 侧栏里不属于任何已打开工作空间的会话（工作空间行已经列出各自的会话，这里只做兜底）。
 * 按项目分组，项目按最近更新的会话排在前面。
 * 每一项显示运行状态（运行中转圈、等待审批与失败用彩色圆点，并有读屏文字），悬停时出现“会话操作”菜单：
 * 置顶、重命名（就地编辑，Enter 保存、Esc 取消）与删除（确认后归档）。
 */
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Download,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  TriangleAlert,
  UsersRound,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary, SessionStatus, SessionSummary } from '@cairn/protocol'
import { localized } from './agents/model.js'
import { FolderTypeIcon } from './file-icons.js'
import { lastSegment } from './paths.js'
import { statusPresentation, TONE_DOT } from './status-presentation.js'
import { useSessionStore } from './store-context.js'
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

export interface SessionGroup {
  readonly projectPath: string
  readonly name: string
  readonly sessions: readonly SessionSummary[]
}

/** 每个项目默认只展示最近这么多条，避免会话太多把侧栏撑满。 */
const SESSION_GROUP_PREVIEW = 8

/** 按项目分组，保持会话的原有顺序（最近更新在前），组的顺序取组内第一个会话的位置。 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
): SessionGroup[] {
  const groups = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const list = groups.get(session.projectPath)
    if (list) list.push(session)
    else groups.set(session.projectPath, [session])
  }
  return [...groups].map(([projectPath, list]) => ({
    projectPath,
    name: projects.find((p) => p.path === projectPath)?.name ?? lastSegment(projectPath),
    sessions: list,
  }))
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 会话列表右侧的时间：今天显示时:分，昨天显示“昨天”，更早显示月-日。 */
export function formatSessionTime(updatedAt: number, yesterday: string, now = Date.now()): string {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date(now)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(date, today)) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const before = new Date(now)
  before.setDate(before.getDate() - 1)
  if (sameDay(date, before)) return yesterday
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function StatusMark({ status }: { readonly status: SessionStatus }) {
  if (status === 'running') return <Spinner className="size-3" />
  const tone = TONE_DOT[statusPresentation(status).tone]
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', tone)} />
}

function RenameInput({
  initial,
  onSave,
  onCancel,
}: {
  readonly initial: string
  /** 保存；`returnFocus` 表示按了 Enter，结束后焦点回到会话行。 */
  readonly onSave: (title: string, returnFocus: boolean) => void
  /** 按 Esc 取消，焦点回到会话行。 */
  readonly onCancel: () => void
}) {
  const { t } = useTranslation('session')
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const keyDown = (event: KeyboardEvent) => {
    // 输入法组字时的 Enter 属于候选词确认，不保存。
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onSave(value, true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }
  return (
    <input
      ref={ref}
      aria-label={t('item.renameLabel')}
      className="h-8 w-full rounded-item bg-raise px-2.5 text-ui text-fg shadow-[0_0_0_1.5px_var(--accent)] outline-none"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={keyDown}
      // 点到别处时保存，但焦点跟着用户点击的位置走，不抢回来。
      onBlur={() => onSave(value, false)}
    />
  )
}

export function SessionItem({
  session,
  active,
  onSelect,
}: {
  readonly session: SessionSummary
  readonly active: boolean
  readonly onSelect: () => void
}) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const renameSession = useSessionStore((s) => s.renameSession)
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned)
  const copyTranscript = useSessionStore((s) => s.copyTranscript)
  const exportTranscript = useSessionStore((s) => s.exportTranscript)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const unarchiveSession = useSessionStore((s) => s.unarchiveSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const teams = useSessionStore((s) => s.teams)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  // 选中可能来自搜索或快捷键，把会话行带进侧栏可见区域。
  useEffect(() => {
    if (!active) return
    const node = rowRef.current
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [active])
  const restoreRowFocus = useRef(false)
  const renamingFromMenu = useRef(false)
  // 重命名按 Enter / Esc 结束后，焦点回到会话行；点到别处保存时不抢焦点。
  useEffect(() => {
    if (renaming || !restoreRowFocus.current) return
    restoreRowFocus.current = false
    rowRef.current?.focus()
  }, [renaming])
  /** 复制 / 导出成功后的短暂提示，占用时间的位置。 */
  const [notice, setNotice] = useState<'copied' | 'exported' | undefined>()
  const noticeTimer = useRef<number | undefined>(undefined)
  const announce = (kind: 'copied' | 'exported') => {
    setNotice(kind)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), 1600)
  }
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])
  const archived = session.status === 'archived'
  const pinned = session.pinned === true
  const title = session.title === '' ? t('title.untitled') : session.title
  const time = formatSessionTime(session.updatedAt, t('list.yesterday'))
  const boundTeam = session.team
  // 模板改名后按列表里的最新名称显示；列表还没读回或已不可用时用绑定时的名称。
  const latestTeam =
    boundTeam === undefined ? undefined : teams?.find((item) => item.teamId === boundTeam.teamId)
  const teamName =
    boundTeam === undefined
      ? undefined
      : localized(latestTeam?.name ?? boundTeam.name, i18n.language, boundTeam.teamId)

  if (renaming) {
    return (
      <li className="px-0.5 py-px">
        <RenameInput
          initial={session.title}
          onCancel={() => {
            restoreRowFocus.current = true
            setRenaming(false)
          }}
          onSave={(next, returnFocus) => {
            restoreRowFocus.current = returnFocus
            setRenaming(false)
            if (next.trim() !== session.title) void renameSession(session.sessionId, next)
          }}
        />
      </li>
    )
  }

  return (
    <li className="group relative">
      <button
        ref={rowRef}
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'relative flex h-[33px] w-full items-center gap-2 rounded-[7px] pr-7 pl-2.5 text-left text-note text-fg2 outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent',
          archived && 'opacity-65',
          active && 'bg-accent-soft font-medium text-fg hover:bg-accent-soft',
        )}
      >
        {active && (
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-accent"
          />
        )}
        <StatusMark status={session.status} />
        <span title={title} className="min-w-0 flex-1 truncate">
          {title}
        </span>
        {teamName !== undefined && (
          <span className="shrink-0 text-accent" title={t('item.team', { name: teamName })}>
            <UsersRound aria-hidden className="size-3" />
            <span className="sr-only">{t('item.team', { name: teamName })}</span>
          </span>
        )}
        {pinned && (
          <span className="shrink-0 text-accent" title={t('item.pinned')}>
            <Pin aria-hidden className="size-3" />
            <span className="sr-only">{t('item.pinned')}</span>
          </span>
        )}
        {notice !== undefined ? (
          <span aria-live="polite" className="shrink-0 text-[11px] text-ok">
            {t(notice === 'copied' ? 'item.copied' : 'item.exported')}
          </span>
        ) : (
          time !== '' && (
            <span className="shrink-0 text-[11px] text-faint transition-opacity group-hover:opacity-0">
              {time}
            </span>
          )
        )}
        {session.status !== 'idle' && (
          <span className="sr-only">{t(`status.${session.status}`)}</span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('item.actions')}
            className="absolute top-[5px] right-1 inline-flex size-6 items-center justify-center rounded-[6px] text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent data-[state=open]:opacity-100 [&_svg]:size-3.5"
          >
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        {/* 选择重命名时输入框会自己聚焦，不能让菜单把焦点抢回按钮；其余操作正常归还。 */}
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            if (!renamingFromMenu.current) return
            renamingFromMenu.current = false
            event.preventDefault()
          }}
        >
          {!archived && (
            <DropdownMenuItem onSelect={() => void setSessionPinned(session.sessionId, !pinned)}>
              {pinned ? <PinOff /> : <Pin />}
              {t(pinned ? 'item.unpin' : 'item.pin')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() =>
              void copyTranscript(session.sessionId).then((done) => {
                if (done) announce('copied')
              })
            }
          >
            <Copy />
            {t('item.copyTranscript')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void exportTranscript(session.sessionId).then((done) => {
                if (done) announce('exported')
              })
            }
          >
            <Download />
            {t('item.exportTranscript')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              renamingFromMenu.current = true
              setRenaming(true)
            }}
          >
            <Pencil />
            {t('item.rename')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {archived ? (
            <>
              <DropdownMenuItem onSelect={() => void unarchiveSession(session.sessionId)}>
                <ArchiveRestore />
                {t('item.restore')}
              </DropdownMenuItem>
              <DropdownMenuItem tone="danger" onSelect={() => setConfirmingDelete(true)}>
                <Trash2 />
                {t('item.deleteForever')}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => setConfirming(true)}>
              <Archive />
              {t('item.archive')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent icon={<Archive />}>
          <DialogTitle>{t('archive.title', { title })}</DialogTitle>
          <DialogDescription>{t('archive.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="primary"
              onClick={() => {
                setConfirming(false)
                void archiveSession(session.sessionId)
              }}
            >
              {t('archive.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>{t('deleteForever.title', { title })}</DialogTitle>
          <DialogDescription>{t('deleteForever.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="danger"
              onClick={() => {
                setConfirmingDelete(false)
                void deleteSession(session.sessionId)
              }}
            >
              {t('deleteForever.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

export function SessionList({ onSelect }: { readonly onSelect?: () => void }) {
  const { t } = useTranslation('session')
  const sessions = useSessionStore((s) => s.sessions)
  const projects = useSessionStore((s) => s.projects)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const refreshSessions = useSessionStore((s) => s.refreshSessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set())
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>())
  const pendingToggle = useRef<string | null>(null)
  // 展开 / 收起后原按钮消失，把焦点交给新出现的那个按钮。
  useEffect(() => {
    const path = pendingToggle.current
    if (path === null) return
    pendingToggle.current = null
    toggleRefs.current.get(path)?.focus()
  }, [showAll])
  const toggleShowAll = (path: string, show: boolean) => {
    pendingToggle.current = path
    setShowAll((current) => {
      const next = new Set(current)
      if (show) next.add(path)
      else next.delete(path)
      return next
    })
  }

  // 项目名默认就是目录名（project-service），项目列表还没读取时用路径最后一段
  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  if (sessions.length === 0) {
    return null
  }
  // 工作空间行下面已经列出各自工作空间的会话，这里只补上不属于任何已打开工作空间的会话。
  const projectPaths = new Set(projects.map((project) => project.path))
  const orphans = sessions.filter((session) => !projectPaths.has(session.projectPath))
  if (orphans.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {groupSessions(orphans, projects).map((group) => {
        const isCollapsed = collapsed.has(group.projectPath)
        const activeIndex = group.sessions.findIndex((s) => s.sessionId === activeSessionId)
        const expanded =
          showAll.has(group.projectPath) ||
          (activeIndex >= 0 && activeIndex >= SESSION_GROUP_PREVIEW)
        const visible = expanded ? group.sessions : group.sessions.slice(0, SESSION_GROUP_PREVIEW)
        const remaining = group.sessions.length - visible.length
        return (
          <section key={group.projectPath} aria-label={t('list.group', { name: group.name })}>
            <h3>
              <button
                type="button"
                title={group.projectPath}
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(group.projectPath)) next.delete(group.projectPath)
                    else next.add(group.projectPath)
                    return next
                  })
                }
                className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[10.5px] font-medium tracking-[0.03em] text-muted transition-colors hover:bg-hover hover:text-fg2"
              >
                <FolderTypeIcon name={lastSegment(group.projectPath)} expanded={!isCollapsed} />
                <span className="truncate">{group.name}</span>
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'ml-auto size-3 shrink-0 text-faint transition-transform duration-200',
                    !isCollapsed && 'rotate-90',
                  )}
                />
              </button>
            </h3>
            {!isCollapsed && (
              <>
                <ul className="mt-0.5 flex flex-col gap-px">
                  {visible.map((s) => (
                    <SessionItem
                      key={s.sessionId}
                      session={s}
                      active={s.sessionId === activeSessionId}
                      onSelect={() => {
                        void selectSession(s.sessionId)
                        onSelect?.()
                      }}
                    />
                  ))}
                </ul>
                {remaining > 0 && (
                  <button
                    ref={(node) => {
                      if (node) toggleRefs.current.set(group.projectPath, node)
                      else toggleRefs.current.delete(group.projectPath)
                    }}
                    type="button"
                    onClick={() => toggleShowAll(group.projectPath, true)}
                    className="mt-0.5 flex h-6 w-full items-center rounded-[6px] px-2 text-left text-[10.5px] text-faint transition-colors hover:bg-hover hover:text-fg2"
                  >
                    {t('list.showMore', { count: remaining })}
                  </button>
                )}
                {remaining === 0 &&
                  showAll.has(group.projectPath) &&
                  group.sessions.length > SESSION_GROUP_PREVIEW && (
                    <button
                      ref={(node) => {
                        if (node) toggleRefs.current.set(group.projectPath, node)
                        else toggleRefs.current.delete(group.projectPath)
                      }}
                      type="button"
                      onClick={() => toggleShowAll(group.projectPath, false)}
                      className="mt-0.5 flex h-6 w-full items-center rounded-[6px] px-2 text-left text-[10.5px] text-faint transition-colors hover:bg-hover hover:text-fg2"
                    >
                      {t('list.showLess')}
                    </button>
                  )}
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}
