/**
 * 消息流（M0-15c）：已完成的消息（`messages`）之后是进行中的消息（`live`，由增量事件合并），
 * 最后是上一轮的结果（停止、失败、达到限额、宿主崩溃）。被停止或出错打断的部分回复保留并注明未完成。消息完成时投影移除对应的进行中消息，
 * 因此同一条消息不会出现两次。
 */
import { useTranslation } from 'react-i18next'
import { rootRun, type LiveMessageView, type MessageView, type SessionView } from '@nexus/core'
import { translateError, type I18nInstance, type TFunction } from '@nexus/i18n'
import type { ContentPart } from '@nexus/protocol'

const PRESERVE_LINES = { whiteSpace: 'pre-wrap' } as const

function Reasoning({ text }: { readonly text: string }) {
  const { t } = useTranslation('session')
  return (
    <details>
      <summary>{t('message.reasoning')}</summary>
      <p style={PRESERVE_LINES}>{text}</p>
    </details>
  )
}

function Content({ parts }: { readonly parts: readonly ContentPart[] }) {
  const { t } = useTranslation('session')
  return parts.map((part, index) =>
    part.type === 'text' ? (
      <p key={index} style={PRESERVE_LINES}>
        {part.text}
      </p>
    ) : (
      <p key={index}>{t('message.image')}</p>
    ),
  )
}

function Message({ message }: { readonly message: MessageView }) {
  const { t } = useTranslation('session')
  const assistant = message.role === 'assistant' ? message : undefined
  return (
    <li>
      <strong>{t(`message.${message.role}`)}</strong>
      {assistant?.reasoning && assistant.reasoning.text !== '' && (
        <Reasoning text={assistant.reasoning.text} />
      )}
      <Content parts={message.content} />
      {assistant?.toolCalls.map((call) => (
        <p key={call.id}>{t('message.toolCall', { name: call.name })}</p>
      ))}
      {assistant?.incomplete && <em>{t('message.incomplete')}</em>}
    </li>
  )
}

function LiveMessage({ live }: { readonly live: LiveMessageView }) {
  const { t } = useTranslation('session')
  return (
    <li aria-busy="true">
      <strong>{t('message.assistant')}</strong>
      {live.reasoning !== '' && <Reasoning text={live.reasoning} />}
      {live.text !== '' && <p style={PRESERVE_LINES}>{live.text}</p>}
    </li>
  )
}

/** 上一轮没有正常完成、或正在等待重试时的说明；正常完成或仍在进行时为 undefined。 */
function turnOutcome(view: SessionView, t: TFunction, i18n: I18nInstance): string | undefined {
  if (view.crash) return t('crashed.message')
  const turn = rootRun(view)?.turn
  if (turn?.status === 'aborted') {
    return t(turn.abortReason === 'shutdown' ? 'turn.interrupted' : 'turn.aborted')
  }
  if (turn?.status === 'running' && turn.retry) {
    const { retry } = turn
    return t('turn.retrying', {
      reason: translateError(i18n, retry.error),
      seconds: Math.ceil(retry.delayMs / 1000),
      attempt: retry.attempt,
      maxRetries: retry.maxRetries,
    })
  }
  if (turn?.status !== 'failed') return undefined
  if (turn.limitReached?.limit === 'maxStepsPerTurn') {
    return t('turn.limit_reached', { maxSteps: turn.limitReached.value })
  }
  return t('turn.failed', { reason: translateError(i18n, turn.error ?? { code: 'unknown' }) })
}

export function MessageStream({ view }: { readonly view: SessionView | undefined }) {
  const { t, i18n } = useTranslation('session')
  const live = Object.values(view?.live ?? {}).sort((a, b) => a.startedAt - b.startedAt)
  const outcome = view && turnOutcome(view, t, i18n)
  return (
    <>
      <ol aria-label={t('chat.messages')}>
        {view?.messages.map((message) => (
          <Message key={message.messageId} message={message} />
        ))}
        {live.map((message) => (
          <LiveMessage key={message.messageId} live={message} />
        ))}
      </ol>
      {outcome && <p>{outcome}</p>}
    </>
  )
}
