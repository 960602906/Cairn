/**
 * 侧栏的会话列表（M0-15b；M2-02 按视觉规范重做）：按项目分组，项目按最近更新的会话排在前面。
 * 每一项显示运行状态（运行中转圈、等待审批与失败用彩色圆点，并有读屏文字），悬停时出现“会话操作”菜单：
 * 重命名（就地编辑，Enter 保存、Esc 取消）与删除（确认后归档）。
 */
import { Folder, FolderOpen, MoreHorizontal, Pencil, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary, SessionStatus, SessionSummary } from '@cairn/protocol'
import { lastSegment } from './paths.js'
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
  const tone =
    status === 'waiting_approval'
      ? 'bg-warn'
      : status === 'failed' || status === 'crashed'
        ? 'bg-danger'
        : undefined
  return (
    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', tone ?? 'bg-transparent')} />
  )
}

function RenameInput({
  initial,
  onSave,
  onCancel,
}: {
  readonly initial: string
  readonly onSave: (title: string) => void
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
    if (event.key === 'Enter') {
      event.preventDefault()
      onSave(value)
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
      onBlur={() => onSave(value)}
    />
  )
}

function SessionItem({
  session,
  active,
  onSelect,
}: {
  readonly session: SessionSummary
  readonly active: boolean
  readonly onSelect: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const renameSession = useSessionStore((s) => s.renameSession)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const title = session.title === '' ? t('title.untitled') : session.title
  const time = formatSessionTime(session.updatedAt, t('list.yesterday'))

  if (renaming) {
    return (
      <li className="px-0.5 py-px">
        <RenameInput
          initial={session.title}
          onCancel={() => setRenaming(false)}
          onSave={(next) => {
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
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'relative flex h-[33px] w-full items-center gap-2 rounded-[7px] pr-7 pl-2.5 text-left text-note text-fg2 transition-colors hover:bg-hover',
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
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {time !== '' && (
          <span className="shrink-0 text-[10px] text-faint transition-opacity group-hover:opacity-0">
            {time}
          </span>
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
            className="absolute top-[5px] right-1 inline-flex size-6 items-center justify-center rounded-[6px] text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-3.5"
          >
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        {/* 关闭菜单时不把焦点还给按钮，否则重命名输入框一出现就失去焦点 */}
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            {t('item.rename')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onSelect={() => setConfirming(true)}>
            <Trash2 />
            {t('item.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>{t('delete.title', { title })}</DialogTitle>
          <DialogDescription>{t('delete.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg">{tc('action.cancel')}</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="danger"
              onClick={() => {
                setConfirming(false)
                void archiveSession(session.sessionId)
              }}
            >
              {t('delete.confirm')}
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

  // 项目名默认就是目录名（project-service），项目列表还没读取时用路径最后一段
  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  if (sessions.length === 0) {
    return <p className="px-2.5 py-2 text-note text-faint">{t('list.empty')}</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {groupSessions(sessions, projects).map((group) => (
        <section key={group.projectPath} aria-label={t('list.group', { name: group.name })}>
          <h3>
            <button
              type="button"
              title={group.projectPath}
              aria-expanded={!collapsed.has(group.projectPath)}
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
              {collapsed.has(group.projectPath) ? (
                <Folder aria-hidden className="size-3.5 shrink-0 text-faint" />
              ) : (
                <FolderOpen aria-hidden className="size-3.5 shrink-0 text-faint" />
              )}
              <span className="truncate">{group.name}</span>
              <span className="tabular ml-auto text-[9.5px] font-normal text-faint">
                {group.sessions.length}
              </span>
            </button>
          </h3>
          {!collapsed.has(group.projectPath) && (
            <ul className="mt-0.5 flex flex-col gap-px">
              {group.sessions.map((s) => (
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
          )}
        </section>
      ))}
    </div>
  )
}
