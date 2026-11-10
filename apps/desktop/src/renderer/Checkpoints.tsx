/**
 * 检查点与撤销（M2-08，视觉规范 §6；替换 M1-16b 的 `UndoTurn`）：
 *
 * - **检查点分隔线**：每轮开始时宿主保存检查点（`turn_start`），这一轮的用户消息上方是一条细线
 *   “第 N 轮前已保存检查点 · 时间”。
 * - **撤销确认框**（危险操作确认框）：模糊遮罩、红色图标；标题写清动作（“撤销第 3 轮的改动？”，不是最后一轮时
 *   是“撤销第 3 轮及之后的改动？”），正文说明后果，列出受影响的文件和各自的结果（恢复 / 恢复原内容 / 删除）；
 *   两个等宽按钮，按钮写明数量（“撤销 2 个文件”）。打开时先预览（`checkpoint.preview`），确认后恢复
 *   （`checkpoint.restore`）。对话记录保留。
 * - **入口**：轮次操作中的“撤销本轮”（这一轮有检查点时）；左侧的对话导航条（`TurnRail`）每轮一条横线，
 *   悬停预览这一轮，可以“回到这一轮之前”。
 * - **恢复标记**：恢复之后，在当时最后一条消息下方显示“已撤销到第 N 轮开始之前 · 时间”；最近一次恢复旁边是
 *   “撤销这次恢复”（恢复到恢复前自动保存的检查点）。
 *
 * 会话正在运行或等待审批时不能恢复（按钮不可用）。预览或恢复失败时错误由错误横幅显示。
 */
import { RotateCcw, TriangleAlert, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus, type CheckpointView, type RestoreView, type SessionView } from '@cairn/core'
import type { CheckpointFileChange, ContentPart, SessionStatus } from '@cairn/protocol'
import { turnEntries } from './file-changes.js'
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
  IconButton,
  Spinner,
} from './ui/index.js'

/** 可以恢复检查点的会话状态：没有在运行或等待审批。 */
const RESTORE_STATUSES: ReadonlySet<SessionStatus> = new Set(['idle', 'failed', 'interrupted'])

/** 会话现在能否恢复检查点。 */
export function useCanRestore(view: SessionView | undefined): boolean {
  const awaiting = useSessionStore(
    (s) => view !== undefined && s.awaitingTurn[view.sessionId] === true,
  )
  return view !== undefined && !awaiting && RESTORE_STATUSES.has(sessionStatus(view))
}

/** 每一轮是第几轮（按用户消息的顺序，从 1 开始）。 */
export function turnNumbers(view: SessionView): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>()
  for (const message of view.messages) {
    if (message.turnId !== undefined && !numbers.has(message.turnId)) {
      numbers.set(message.turnId, numbers.size + 1)
    }
  }
  return numbers
}

/** 每一轮开始时的检查点（同一轮有多个时取第一个）。 */
export function turnCheckpoints(view: SessionView): ReadonlyMap<string, CheckpointView> {
  const map = new Map<string, CheckpointView>()
  for (const checkpoint of view.checkpoints) {
    if (checkpoint.reason === 'turn_start' && checkpoint.turnId && !map.has(checkpoint.turnId)) {
      map.set(checkpoint.turnId, checkpoint)
    }
  }
  return map
}

/** 时间（时:分；不是今天时加上日期）。 */
export function formatTime(ts: number, language: string, now = Date.now()): string {
  const date = new Date(ts)
  const today = new Date(now).toDateString() === date.toDateString()
  return date.toLocaleString(language, {
    ...(today ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 一个可以恢复到的检查点，以及确认框的说法。 */
export interface RestoreTarget {
  readonly checkpointId: string
  /** 回到第几轮开始之前；undefined 表示撤销一次恢复（回到恢复之前）。 */
  readonly turn: number | undefined
  /** 这一轮之后还有别的轮次（标题写“及之后”）。 */
  readonly later: boolean
}

/** 用户消息上方的检查点分隔线。 */
export function CheckpointDivider({
  turn,
  checkpoint,
}: {
  readonly turn: number
  readonly checkpoint: CheckpointView
}) {
  const { t, i18n } = useTranslation('session')
  return (
    <div
      role="separator"
      aria-label={t('checkpoint.divider', {
        turn,
        time: formatTime(checkpoint.createdAt, i18n.language),
      })}
      className="mb-3.5 flex items-center gap-3 self-stretch text-note text-faint"
    >
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span aria-hidden className="shrink-0">
        {t('checkpoint.divider', { turn, time: formatTime(checkpoint.createdAt, i18n.language) })}
      </span>
      <span aria-hidden className="h-px flex-1 bg-hair" />
    </div>
  )
}

/** 恢复的说明：回到第几轮之前，或撤销了上一次恢复。 */
function restoreLabel(view: SessionView, restore: RestoreView, turns: ReadonlyMap<string, number>) {
  const target = view.checkpoints.findLast(
    (c) => c.checkpointId === restore.checkpointId && c.seq < restore.seq,
  )
  if (target?.reason === 'before_restore') return { key: 'checkpoint.restored.undo' } as const
  const turn = target?.turnId === undefined ? undefined : turns.get(target.turnId)
  return turn === undefined
    ? ({ key: 'checkpoint.restored.other' } as const)
    : ({ key: 'checkpoint.restored.turn', turn } as const)
}

/** 每条消息下方要显示的恢复（按 messageId）：恢复发生时的最后一条消息。 */
export function restoresByMessage(view: SessionView): ReadonlyMap<string, readonly RestoreView[]> {
  const map = new Map<string, RestoreView[]>()
  for (const restore of view.restores) {
    const message = view.messages.findLast((m) => m.seq < restore.seq)
    if (!message) continue
    const list = map.get(message.messageId)
    if (list) list.push(restore)
    else map.set(message.messageId, [restore])
  }
  return map
}

/** 消息下方的恢复标记；最近一次恢复可以撤销。 */
export function RestoreMarks({
  view,
  restores,
}: {
  readonly view: SessionView
  readonly restores: readonly RestoreView[]
}) {
  const { t, i18n } = useTranslation('session')
  const canRestore = useCanRestore(view)
  const [target, setTarget] = useState<RestoreTarget>()
  const turns = turnNumbers(view)
  const latest = view.restores.at(-1)
  // 恢复前自动保存的检查点紧挨在恢复之前
  const before = latest && view.checkpoints.findLast((c) => c.seq < latest.seq)
  return (
    <>
      {restores.map((restore) => {
        const label = restoreLabel(view, restore, turns)
        const undoable = restore === latest && before?.reason === 'before_restore'
        return (
          <div
            key={restore.seq}
            className="mt-3 flex items-center gap-2 rounded-card bg-sunk px-3.5 py-2 text-ui text-fg2"
          >
            <RotateCcw aria-hidden className="size-3.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              {t(label.key, {
                turn: 'turn' in label ? label.turn : undefined,
                time: formatTime(restore.ts, i18n.language),
              })}
            </span>
            {undoable && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canRestore}
                onClick={() =>
                  setTarget({ checkpointId: before.checkpointId, turn: undefined, later: false })
                }
              >
                {t('checkpoint.undoRestore')}
              </Button>
            )}
          </div>
        )
      })}
      <RestoreDialog
        sessionId={view.sessionId}
        target={target}
        onClose={() => setTarget(undefined)}
      />
    </>
  )
}

/** 轮次操作中的“撤销本轮”。 */
export function UndoTurnButton({
  view,
  turnId,
}: {
  readonly view: SessionView
  readonly turnId: string
}) {
  const { t } = useTranslation('session')
  const canRestore = useCanRestore(view)
  const [target, setTarget] = useState<RestoreTarget>()
  const checkpoint = turnCheckpoints(view).get(turnId)
  const turns = turnNumbers(view)
  const turn = turns.get(turnId)
  if (!checkpoint || turn === undefined) return null
  return (
    <>
      <IconButton
        label={t('undo.button')}
        size="icon-sm"
        disabled={!canRestore}
        onClick={() =>
          setTarget({ checkpointId: checkpoint.checkpointId, turn, later: turn < turns.size })
        }
      >
        <Undo2 />
      </IconButton>
      <RestoreDialog
        sessionId={view.sessionId}
        target={target}
        onClose={() => setTarget(undefined)}
      />
    </>
  )
}

const FILE_ORDER: Record<CheckpointFileChange['status'], number> = {
  modified: 0,
  added: 1,
  deleted: 2,
}

/** 撤销确认框：打开时预览受影响的文件，确认后恢复。 */
export function RestoreDialog({
  sessionId,
  target,
  onClose,
}: {
  readonly sessionId: string
  readonly target: RestoreTarget | undefined
  readonly onClose: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const previewRestore = useSessionStore((s) => s.previewRestore)
  const restoreCheckpoint = useSessionStore((s) => s.restoreCheckpoint)
  const [files, setFiles] = useState<readonly CheckpointFileChange[]>()
  const [busy, setBusy] = useState(false)
  const checkpointId = target?.checkpointId

  useEffect(() => {
    if (checkpointId === undefined) return
    let cancelled = false
    setFiles(undefined)
    void previewRestore(sessionId, checkpointId).then((plan) => {
      if (cancelled) return
      if (plan) setFiles(plan.files)
      else onClose()
    })
    return () => {
      cancelled = true
    }
    // onClose 每次渲染都是新的函数，只按检查点重新预览
  }, [previewRestore, sessionId, checkpointId])

  const sorted = useMemo(
    () =>
      files &&
      [...files].sort(
        (a, b) => FILE_ORDER[a.status] - FILE_ORDER[b.status] || a.path.localeCompare(b.path),
      ),
    [files],
  )

  const confirm = async () => {
    if (checkpointId === undefined) return
    setBusy(true)
    await restoreCheckpoint(sessionId, checkpointId)
    setBusy(false)
    onClose()
  }

  const title =
    target?.turn === undefined
      ? t('undo.title.restore')
      : t(target.later ? 'undo.title.since' : 'undo.title.last', { turn: target.turn })
  const description =
    target?.turn === undefined
      ? t('undo.description.restore')
      : t('undo.description.turn', { turn: target.turn })

  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        tone="danger"
        icon={<TriangleAlert />}
        className="flex max-h-[calc(100vh-64px)] flex-col"
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {sorted === undefined ? (
          <div className="mt-4 flex items-center gap-2 text-ui text-muted">
            <Spinner />
            {t('undo.loading')}
          </div>
        ) : sorted.length === 0 ? (
          <div className="mt-4 rounded-item bg-sunk px-3 py-2 text-ui text-fg2">
            {t('undo.noFiles')}
          </div>
        ) : (
          <ul
            aria-label={t('undo.files')}
            className="mt-4 flex min-h-0 flex-col overflow-y-auto rounded-item bg-sunk py-1"
          >
            {sorted.map((file) => (
              <li key={file.path} className="flex items-center gap-3 px-3 py-1 text-ui">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">
                  {file.path}
                </code>
                <span
                  className={
                    file.status === 'deleted'
                      ? 'shrink-0 text-note text-danger'
                      : 'shrink-0 text-note text-muted'
                  }
                >
                  {t(`undo.file.${file.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button>{tc('action.cancel')}</Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={busy || sorted === undefined || sorted.length === 0}
            onClick={() => void confirm()}
          >
            {t('undo.confirm', { count: sorted?.length ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const textOf = (parts: readonly ContentPart[]) =>
  parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

export interface RailTurn {
  readonly turnId: string
  readonly turn: number
  readonly user: string
  readonly reply: string
  readonly checkpoint: CheckpointView | undefined
}

/** 导航条的每一轮：用户消息、回复的开头与这一轮开始时的检查点。 */
export function railTurns(view: SessionView): RailTurn[] {
  const turns = turnNumbers(view)
  const checkpoints = turnCheckpoints(view)
  return [...turns].map(([turnId, turn]) => {
    const messages = view.messages.filter((m) => m.turnId === turnId)
    const user = messages.find((m) => m.role === 'user')
    const reply = messages.find((m) => m.role === 'assistant' && textOf(m.content) !== '')
    return {
      turnId,
      turn,
      user: user ? textOf(user.content) : '',
      reply: reply ? textOf(reply.content) : '',
      checkpoint: checkpoints.get(turnId),
    }
  })
}

/** 跳到某一轮的用户消息（消息流中带 `data-turn` 的列表项）。 */
function scrollToTurn(turnId: string) {
  const target = [...document.querySelectorAll<HTMLElement>('[data-turn]')].find(
    (el) => el.dataset['turn'] === turnId,
  )
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

/**
 * 左侧的对话导航条（M2-08）：每一轮一条短横线，点击跳到这一轮；悬停或聚焦时显示这一轮的预览（用户消息、
 * 回复的开头、改动的文件数与检查点），可以从这里“回到这一轮之前”（打开撤销确认框）。改动过文件的轮次横线
 * 颜色更深。少于两轮时不显示。
 */
export function TurnRail({ view }: { readonly view: SessionView | undefined }) {
  const { t, i18n } = useTranslation('session')
  const canRestore = useCanRestore(view)
  const changes = useSessionStore((s) => (view ? s.changes[view.sessionId] : undefined))
  const [open, setOpen] = useState<string>()
  const [target, setTarget] = useState<RestoreTarget>()
  const turns = useMemo(() => (view ? railTurns(view) : []), [view])
  if (!view || turns.length < 2) return null
  const changed = (turnId: string) => (changes ? turnEntries(changes, turnId).length : 0)
  return (
    <nav aria-label={t('rail.label')} className="absolute top-1/2 left-2 z-10 -translate-y-1/2">
      <ol className="flex max-h-[60vh] flex-col py-1">
        {turns.map((item) => {
          const files = changed(item.turnId)
          const shown = open === item.turnId
          return (
            <li
              key={item.turnId}
              className="relative"
              onMouseEnter={() => setOpen(item.turnId)}
              onMouseLeave={() => setOpen(undefined)}
              onFocus={() => setOpen(item.turnId)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(undefined)
              }}
            >
              <button
                type="button"
                aria-label={t('rail.jump', { turn: item.turn, text: item.user })}
                onClick={() => scrollToTurn(item.turnId)}
                className="group/rail flex h-[9px] w-7 items-center rounded-[3px] px-1.5 outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-[2px] rounded-full transition-all',
                    shown ? 'w-4 bg-fg2' : files > 0 ? 'w-3 bg-muted' : 'w-3 bg-hair2',
                  )}
                />
              </button>
              {shown && (
                <div
                  role="group"
                  aria-label={t('rail.turn', { turn: item.turn })}
                  className="absolute top-1/2 left-full z-20 ml-1 w-72 -translate-y-1/2 rounded-card bg-raise p-3 text-ui shadow-2"
                >
                  <div className="mb-1 text-note text-muted">
                    {t('rail.turn', { turn: item.turn })}
                    {files > 0 && ` · ${t('rail.changed', { count: files })}`}
                  </div>
                  <div className="line-clamp-2 text-fg">{item.user}</div>
                  {item.reply !== '' && (
                    <div className="mt-1 line-clamp-2 text-note text-muted">{item.reply}</div>
                  )}
                  {item.checkpoint && (
                    <div className="mt-2.5 flex items-center gap-2 border-t-[0.5px] border-hair pt-2.5">
                      <span className="min-w-0 flex-1 truncate text-note text-faint">
                        {t('rail.checkpoint', {
                          time: formatTime(item.checkpoint.createdAt, i18n.language),
                        })}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canRestore}
                        onClick={() => {
                          const checkpointId = item.checkpoint!.checkpointId
                          setOpen(undefined)
                          setTarget({
                            checkpointId,
                            turn: item.turn,
                            later: item.turn < turns.length,
                          })
                        }}
                      >
                        <Undo2 className="size-3.5" />
                        {t('rail.restore')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <RestoreDialog
        sessionId={view.sessionId}
        target={target}
        onClose={() => setTarget(undefined)}
      />
    </nav>
  )
}
