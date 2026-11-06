/**
 * 侧栏的会话列表（M0-15b；M2-02 按视觉规范重做）：按项目分组，项目按最近更新的会话排在前面。
 * 每一项显示运行状态（运行中转圈、等待审批与失败用彩色圆点，并有读屏文字），悬停时出现“会话操作”菜单：
 * 重命名（就地编辑，Enter 保存、Esc 取消）与删除（确认后归档）。
 */
import { MoreHorizontal, Pencil, Trash2, TriangleAlert } from 'lucide-react'
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
          'flex h-8 w-full items-center gap-2 rounded-item pr-8 pl-2.5 text-left text-ui text-fg2 transition-colors hover:bg-hover',
          active && 'bg-raise font-medium text-fg shadow-1 hover:bg-raise',
        )}
      >
        <StatusMark status={session.status} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {session.status !== 'idle' && (
          <span className="sr-only">{t(`status.${session.status}`)}</span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('item.actions')}
            className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-[6px] text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-4"
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
          <h3 title={group.projectPath} className="truncate px-2.5 pb-1 text-note text-muted">
            {group.name}
          </h3>
          <ul className="flex flex-col gap-px">
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
        </section>
      ))}
    </div>
  )
}
