/**
 * 当前会话（M0-15c）：标题、运行状态、消息流、撤销本轮（M1-16b）、未决审批（M1-11b）、输入框与停止按钮。
 * M2-02 起放在纸面上：顶栏是“项目 / 会话标题”（可拖动窗口，右侧给系统按钮让出位置），下面是可滚动的
 * 对话列（最大宽度 700px，内容变高时贴底滚动），输入框悬浮在底部（M2-04，运行状态条也在输入框上方）。
 * 内容都来自 store 中的事件投影，窗口刷新后经 `afterSeq` 补发恢复。订阅返回之前还没有投影，
 * 标题与状态先取会话列表中的值。已发送、等待这一轮开始时显示为运行中（可以停止）。
 */
import { useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { rootRun, sessionStatus } from '@cairn/core'
import type { SessionStatus } from '@cairn/protocol'
import { ApprovalList } from './ApprovalCard.js'
import { Composer } from './Composer.js'
import { MessageStream } from './MessageStream.js'
import { lastSegment } from './paths.js'
import { useStickToBottom } from './stick-to-bottom.js'
import { useSessionStore } from './store-context.js'
import { UndoTurn } from './UndoTurn.js'

/** 可以撤销本轮的会话状态：本轮已结束，会话没有在运行或等待审批。 */
const UNDO_STATUSES: ReadonlySet<SessionStatus> = new Set(['idle', 'failed', 'interrupted'])

/** 顶栏右侧给 Windows / Linux 叠在窗口右上角的系统按钮让出位置（Window Controls Overlay 的 CSS 变量）。 */
const TITLE_BAR_INSET = {
  paddingRight:
    'max(12px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) - 8px + 12px))',
} as const

/** 纸面顶栏（48px）：左侧可以放展开侧栏按钮与面包屑。 */
export function TopBar({ children }: { readonly children: ReactNode }) {
  return (
    <header
      className="drag flex h-12 shrink-0 items-center gap-1.5 border-b-[0.5px] border-hair pl-3"
      style={TITLE_BAR_INSET}
    >
      {children}
    </header>
  )
}

export function ChatPanel({ leading }: { readonly leading?: ReactNode }) {
  const { t } = useTranslation('session')
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const view = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.views[s.activeSessionId],
  )
  const summary = useSessionStore((s) => s.sessions.find((x) => x.sessionId === s.activeSessionId))
  const projects = useSessionStore((s) => s.projects)
  const awaiting = useSessionStore(
    (s) => s.activeSessionId !== undefined && s.awaitingTurn[s.activeSessionId] === true,
  )
  const defaultModel = useSessionStore((s) => s.settings?.defaultModel)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useStickToBottom(scroller, content, sessionId ?? '')

  if (sessionId === undefined) {
    return (
      <>
        <TopBar>{leading}</TopBar>
        <div className="flex flex-1 items-center justify-center text-ui text-muted">
          <p>{t('chat.empty')}</p>
        </div>
      </>
    )
  }

  const title = view?.info?.title ?? summary?.title ?? ''
  const status = awaiting ? 'running' : view ? sessionStatus(view) : (summary?.status ?? 'idle')
  const run = view && rootRun(view)
  const turn = run?.turn
  const canUndo = turn !== undefined && turn.status !== 'running' && UNDO_STATUSES.has(status)
  const path = view?.info?.projectPath ?? summary?.projectPath
  const project = path && (projects.find((p) => p.path === path)?.name ?? lastSegment(path))
  return (
    <section aria-labelledby="chat-title" className="flex min-h-0 flex-1 flex-col">
      <TopBar>
        {leading}
        {project && (
          <>
            <span title={path} className="truncate text-ui text-muted">
              {project}
            </span>
            <span aria-hidden className="text-faint">
              /
            </span>
          </>
        )}
        <h2 id="chat-title" className="truncate text-ui font-medium text-fg">
          {title === '' ? t('title.untitled') : title}
        </h2>
      </TopBar>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div
          ref={content}
          className="mx-auto flex max-w-[700px] flex-col gap-3.5 px-7 pt-6 pb-8 text-body"
        >
          <MessageStream view={view} />
          {canUndo && <UndoTurn key={turn.turnId} sessionId={sessionId} turnId={turn.turnId} />}
          <ApprovalList />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[720px] px-7 pb-3">
        <Composer
          key={sessionId}
          sessionId={sessionId}
          status={status}
          run={run}
          model={view?.info?.model ?? summary?.model ?? defaultModel}
          contextTokens={view?.contextTokens}
        />
      </div>
    </section>
  )
}
