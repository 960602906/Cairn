/**
 * 当前会话（M0-15c）：标题、运行状态、消息流、输入框与停止按钮。
 * 内容都来自 store 中的事件投影，窗口刷新后经 `afterSeq` 补发恢复。订阅返回之前还没有投影，
 * 标题与状态先取会话列表中的值。
 */
import { useTranslation } from 'react-i18next'
import { rootRun, sessionStatus, type RunView } from '@nexus/core'
import type { RunState, SessionStatus } from '@nexus/protocol'
import { MessageStream } from './MessageStream.js'
import { PromptInput } from './PromptInput.js'
import { useSessionStore } from './store-context.js'

/** 运行中时进一步说明的运行状态。 */
const RUN_DETAILS: ReadonlySet<RunState> = new Set(['thinking', 'tooling', 'aborting'])

function RunStatus({
  status,
  run,
}: {
  readonly status: SessionStatus
  readonly run: RunView | undefined
}) {
  const { t } = useTranslation('session')
  const detail = status === 'running' && run && RUN_DETAILS.has(run.state) ? run.state : undefined
  return (
    <p role="status">
      {t(`status.${status}`)}
      {detail && ` · ${t(`run.${detail}`)}`}
    </p>
  )
}

export function ChatPanel() {
  const { t } = useTranslation('session')
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const view = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.views[s.activeSessionId],
  )
  const summary = useSessionStore((s) => s.sessions.find((x) => x.sessionId === s.activeSessionId))

  if (sessionId === undefined) return <p>{t('chat.empty')}</p>

  const title = view?.info?.title ?? summary?.title ?? ''
  const status = view ? sessionStatus(view) : (summary?.status ?? 'idle')
  const run = view && rootRun(view)
  return (
    <section aria-labelledby="chat-title">
      <h2 id="chat-title">{title === '' ? t('title.untitled') : title}</h2>
      <RunStatus status={status} run={run} />
      <MessageStream view={view} />
      <PromptInput
        key={sessionId}
        active={status === 'running' || status === 'waiting_approval'}
        stopping={run?.state === 'aborting'}
      />
    </section>
  )
}
