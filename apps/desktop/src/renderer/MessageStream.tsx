/**
 * 消息流（M0-15c）：已完成的消息（`messages`）之后是进行中的消息（`live`，由增量事件合并），
 * 助手消息中的工具调用显示为时间线（M2-05，`ToolTimeline`），紧跟在这条消息的正文之后（模型先写正文再调用工具）。
 * 最后是上一轮的结果（停止、失败、达到限额、宿主崩溃）。被停止或出错打断的部分回复保留并注明未完成。
 * 消息完成时投影移除对应的进行中消息，因此同一条消息不会出现两次。
 *
 * M2-03：用户消息是右对齐的气泡；助手正文按 Markdown 渲染；思考过程可展开；每轮结束后最后一条助手消息下面
 * 是轮次操作（复制，模型名与 token 数）。作者名只给读屏（sr-only）。
 * M2-07：这一轮有文件改动时，轮次操作上面是“本轮变更”（`FileChanges.tsx`）。
 * M2-08：每轮的用户消息上方是检查点分隔线，轮次操作中有“撤销本轮”，恢复之后显示恢复标记
 * （`Checkpoints.tsx`）。
 */
import { Check, ChevronRight, Copy } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  rootRun,
  type CheckpointView,
  type LiveMessageView,
  type MessageView,
  type PlanView,
  type RestoreView,
  type SessionView,
} from '@cairn/core'
import { translateError, type I18nInstance, type TFunction } from '@cairn/i18n'
import type { ContentPart, ModelRef } from '@cairn/protocol'
import {
  CheckpointDivider,
  RestoreMarks,
  restoresByMessage,
  turnCheckpoints,
  turnNumbers,
  UndoTurnButton,
} from './Checkpoints.js'
import { TurnChanges } from './FileChanges.js'
import { Markdown } from './Markdown.js'
import { SessionPlanCard } from './PlanCard.js'
import { useSessionStore } from './store-context.js'
import { ToolStep, ToolTimeline } from './ToolTimeline.js'
import { IconButton, Shimmer } from './ui/index.js'

/** 本轮结束后，最后一条助手消息下面的操作：复制本轮回复；右侧灰字是模型名与本轮 token 数（不显示金额）。 */
function TurnActions({
  text,
  model,
  tokens,
  children,
}: {
  readonly text: string
  readonly model: string
  readonly tokens: number | undefined
  /** 复制之后的其他操作（撤销本轮）。 */
  readonly children?: ReactNode
}) {
  const { t, i18n } = useTranslation('session')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // 剪贴板不可用时不提示
    }
  }
  return (
    <div className="mt-2 flex items-center gap-1 text-note text-muted">
      <IconButton
        label={copied ? t('message.copied') : t('message.copy')}
        size="icon-sm"
        disabled={text === ''}
        onClick={() => void copy()}
      >
        {copied ? <Check className="text-ok" /> : <Copy />}
      </IconButton>
      {children}
      <span className="ml-auto truncate">{model}</span>
      {tokens !== undefined && (
        <span className="tabular shrink-0">
          ·{' '}
          {t('message.tokens', { count: tokens, formatted: tokens.toLocaleString(i18n.language) })}
        </span>
      )}
    </div>
  )
}

const COPIED_MS = 1600

function Reasoning({ text, live = false }: { readonly text: string; readonly live?: boolean }) {
  const { t } = useTranslation('session')
  return (
    <details className="group/reasoning mb-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-ui text-muted select-none hover:text-fg2 [&::-webkit-details-marker]:hidden">
        {live ? <Shimmer>{t('message.reasoning')}</Shimmer> : t('message.reasoning')}
        <ChevronRight className="size-3.5 transition-transform group-open/reasoning:rotate-90" />
      </summary>
      <p className="mt-2 border-l-2 border-hair2 pl-3.5 text-[14px] leading-relaxed whitespace-pre-wrap text-muted">
        {text}
      </p>
    </details>
  )
}

/** 助手正文：文本按 Markdown 渲染。 */
function AssistantContent({ parts }: { readonly parts: readonly ContentPart[] }) {
  const { t } = useTranslation('session')
  return parts.map((part, index) =>
    part.type === 'text' ? (
      <Markdown key={index} text={part.text} />
    ) : (
      <p key={index}>{t('message.image')}</p>
    ),
  )
}

/** 用户消息：原样显示（不按 Markdown 解释），保留换行。 */
function UserContent({ parts }: { readonly parts: readonly ContentPart[] }) {
  const { t } = useTranslation('session')
  return parts.map((part, index) => (
    <p key={index} className="whitespace-pre-wrap">
      {part.type === 'text' ? part.text : t('message.image')}
    </p>
  ))
}

const textOf = (parts: readonly ContentPart[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n')

export interface TurnFooter {
  readonly text: string
  readonly model: ModelRef
  readonly tokens: number | undefined
}

/**
 * 每轮最后一条助手消息的轮次操作：本轮已结束（不是进行中的那一轮）时才有。
 * 返回 messageId → 本轮所有助手回复的文本、最后的模型与本轮 token 数（输入 + 输出）。
 */
export function turnFooters(view: SessionView): ReadonlyMap<string, TurnFooter> {
  const running = rootRun(view)?.turn
  const runningTurn = running?.status === 'running' ? running.turnId : undefined
  const footers = new Map<string, TurnFooter>()
  const texts: string[] = []
  view.messages.forEach((message, index) => {
    if (message.role === 'user') {
      texts.length = 0
      return
    }
    const text = textOf(message.content)
    if (text !== '') texts.push(text)
    const next = view.messages[index + 1]
    const lastOfTurn = next === undefined || next.role === 'user' || next.turnId !== message.turnId
    if (!lastOfTurn || (message.turnId !== undefined && message.turnId === runningTurn)) return
    if (next === undefined && Object.keys(view.live).length > 0) return
    const usage = message.turnId === undefined ? undefined : view.usageByTurn[message.turnId]
    footers.set(message.messageId, {
      text: texts.join('\n\n'),
      model: message.model,
      tokens: usage && usage.inputTokens + usage.outputTokens,
    })
    texts.length = 0
  })
  return footers
}

function markBetween(
  previous: number,
  seq: number,
  mark: { readonly seq: number } | undefined,
): boolean {
  return mark !== undefined && previous < mark.seq && seq >= mark.seq
}

function afterLast(last: number, mark: { readonly seq: number } | undefined): boolean {
  return mark !== undefined && mark.seq > last
}

function CompactionMark({ summary }: { readonly summary: string }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-note text-faint">
        <span aria-hidden className="h-px flex-1 bg-hair" />
        <button
          type="button"
          className="shrink-0 hover:text-muted"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t('chat.compacted')}
          <span className="sr-only">
            {open ? t('chat.compacted.hide') : t('chat.compacted.show')}
          </span>
        </button>
        <span aria-hidden className="h-px flex-1 bg-hair" />
      </div>
      {open && (
        <p className="whitespace-pre-wrap rounded-card bg-sunk px-3.5 py-2.5 text-note text-muted">
          {summary}
        </p>
      )}
    </div>
  )
}

function OmissionNote() {
  const { t } = useTranslation('session')
  return <p className="text-note text-faint">{t('chat.toolOutputOmitted')}</p>
}

function Message({
  message,
  view,
  footer,
  plans,
  modelName,
  continued,
  divider,
  restores,
  compacted,
  omitted,
}: {
  readonly message: MessageView
  readonly view: SessionView
  readonly footer: TurnFooter | undefined
  readonly plans: readonly PlanView[]
  readonly modelName: (model: ModelRef) => string
  /** 用户消息上方的检查点分隔线。 */
  readonly divider: { readonly turn: number; readonly checkpoint: CheckpointView } | undefined
  /** 这条消息之后发生的恢复。 */
  readonly restores: readonly RestoreView[] | undefined
  /** 紧跟在同一轮的上一条助手消息之后：间距收紧为块间距（14px）。 */
  readonly continued: boolean
  /** 这条消息之前是压缩分隔线。 */
  readonly compacted: boolean
  /** 这条消息之前是“工具输出已省略”的提示。 */
  readonly omitted: boolean
}) {
  const { t } = useTranslation('session')
  const approvals = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.approvals[s.activeSessionId],
  )
  const awaiting = new Set(approvals?.map((a) => a.toolCallId))
  const cards = plans.map((plan) => <SessionPlanCard key={plan.planId} plan={plan} />)
  const marks = (compacted || omitted) && (
    <div className="mb-3.5 flex w-full flex-col gap-2 self-stretch">
      {compacted && view.compaction && <CompactionMark summary={view.compaction.summary} />}
      {omitted && <OmissionNote />}
    </div>
  )
  if (message.role === 'user') {
    return (
      <li className="flex scroll-mt-4 flex-col items-end" data-turn={message.turnId}>
        {marks}
        {divider && <CheckpointDivider turn={divider.turn} checkpoint={divider.checkpoint} />}
        <strong className="sr-only">{t('message.user')}</strong>
        <div className="max-w-[78%] rounded-input bg-sunk2 px-4 py-2.5 text-fg">
          <UserContent parts={message.content} />
        </div>
        {restores && (
          <div className="self-stretch">
            <RestoreMarks view={view} restores={restores} />
          </div>
        )}
        {cards}
      </li>
    )
  }
  return (
    <li className={continued ? '-mt-3.5 text-fg' : 'text-fg'}>
      {marks}
      <strong className="sr-only">{t('message.assistant')}</strong>
      {message.reasoning && message.reasoning.text !== '' && (
        <Reasoning text={message.reasoning.text} />
      )}
      <AssistantContent parts={message.content} />
      {message.toolCalls.length > 0 && (
        <ToolTimeline>
          {message.toolCalls.map((call) => (
            <ToolStep
              key={call.id}
              name={call.name}
              input={call.input}
              tool={view.tools[call.id]}
              live={view.liveToolOutput[call.id]}
              awaitingApproval={awaiting.has(call.id)}
            />
          ))}
        </ToolTimeline>
      )}
      {message.incomplete && (
        <em className="mt-1.5 block text-note text-muted not-italic">{t('message.incomplete')}</em>
      )}
      {footer && message.turnId !== undefined && (
        <TurnChanges sessionId={view.sessionId} turnId={message.turnId} />
      )}
      {footer && (
        <TurnActions text={footer.text} model={modelName(footer.model)} tokens={footer.tokens}>
          {message.turnId !== undefined && <UndoTurnButton view={view} turnId={message.turnId} />}
        </TurnActions>
      )}
      {cards}
      {restores && <RestoreMarks view={view} restores={restores} />}
    </li>
  )
}

/** 同一轮中紧跟在助手消息之后的助手消息。 */
const continues = (
  previous: MessageView | undefined,
  next: { readonly role?: string; readonly turnId: string | undefined },
) =>
  previous?.role === 'assistant' &&
  next.role !== 'user' &&
  previous.turnId !== undefined &&
  previous.turnId === next.turnId

function LiveMessage({
  live,
  continued,
}: {
  readonly live: LiveMessageView
  readonly continued: boolean
}) {
  const { t } = useTranslation('session')
  return (
    <li aria-busy="true" className={continued ? '-mt-3.5 text-fg' : 'text-fg'}>
      <strong className="sr-only">{t('message.assistant')}</strong>
      {live.reasoning !== '' && <Reasoning text={live.reasoning} live={live.text === ''} />}
      {live.text !== '' && <Markdown text={live.text} />}
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
  const limit = turn.limitReached
  if (limit?.limit === 'maxStepsPerTurn') return t('turn.limit_reached', { maxSteps: limit.value })
  if (limit?.limit === 'maxTurnDurationMs') {
    return t('turn.limit.maxTurnDurationMs', { minutes: Math.round(limit.value / 60_000) })
  }
  if (limit) return t(`turn.limit.${limit.limit}`, { value: limit.value })
  return t('turn.failed', { reason: translateError(i18n, turn.error ?? { code: 'unknown' }) })
}

export function MessageStream({ view }: { readonly view: SessionView | undefined }) {
  const { t, i18n } = useTranslation('session')
  const providers = useSessionStore((s) => s.settings?.providers)
  const live = Object.values(view?.live ?? {}).sort((a, b) => a.startedAt - b.startedAt)
  const outcome = view && turnOutcome(view, t, i18n)
  const footers = view ? turnFooters(view) : new Map<string, TurnFooter>()
  const anchored = new Set(
    (view?.plans ?? []).flatMap((plan) =>
      plan.turnId !== undefined && view?.messages.some((message) => message.turnId === plan.turnId)
        ? [plan.planId]
        : [],
    ),
  )
  const turns = view ? turnNumbers(view) : new Map<string, number>()
  const checkpoints = view ? turnCheckpoints(view) : new Map<string, CheckpointView>()
  const restores = view ? restoresByMessage(view) : new Map<string, readonly RestoreView[]>()
  /** 每轮第一条用户消息上方的检查点分隔线。 */
  const dividerFor = (message: MessageView, index: number) => {
    if (message.role !== 'user' || message.turnId === undefined) return undefined
    if (view?.messages[index - 1]?.turnId === message.turnId) return undefined
    const checkpoint = checkpoints.get(message.turnId)
    const turn = turns.get(message.turnId)
    return checkpoint && turn !== undefined ? { turn, checkpoint } : undefined
  }
  /** 模型显示名：已配置的“供应商 · 模型”，否则为模型 id。 */
  const modelName = (model: ModelRef) => {
    const provider = providers?.find((p) => p.id === model.providerId)
    const configured = provider?.models.find((m) => m.id === model.modelId)
    return provider && configured
      ? `${provider.displayName} · ${configured.displayName ?? configured.id}`
      : model.modelId
  }
  return (
    <>
      <ol aria-label={t('chat.messages')} className="flex flex-col gap-7">
        {view?.messages.map((message, index) => {
          const previous = view.messages[index - 1]?.seq ?? 0
          const next = view.messages[index + 1]
          const lastOfTurn = next === undefined || next.turnId !== message.turnId
          return (
            <Message
              key={message.messageId}
              message={message}
              view={view}
              footer={footers.get(message.messageId)}
              plans={
                lastOfTurn && message.turnId !== undefined
                  ? view.plans.filter((plan) => plan.turnId === message.turnId)
                  : []
              }
              modelName={modelName}
              continued={continues(view.messages[index - 1], message)}
              divider={dividerFor(message, index)}
              restores={restores.get(message.messageId)}
              compacted={markBetween(previous, message.seq, view.compaction)}
              omitted={markBetween(previous, message.seq, view.toolOutputOmitted)}
            />
          )
        })}
        {view?.plans
          .filter((plan) => !anchored.has(plan.planId))
          .map((plan) => (
            <li key={plan.planId} className="list-none">
              <SessionPlanCard plan={plan} />
            </li>
          ))}
        {view?.compaction && afterLast(view.messages.at(-1)?.seq ?? 0, view.compaction) && (
          <li className="list-none">
            <CompactionMark summary={view.compaction.summary} />
          </li>
        )}
        {view?.toolOutputOmitted &&
          afterLast(view.messages.at(-1)?.seq ?? 0, view.toolOutputOmitted) && (
            <li className="list-none">
              <OmissionNote />
            </li>
          )}
        {live.map((message, index) => (
          <LiveMessage
            key={message.messageId}
            live={message}
            continued={index === 0 && continues(view?.messages.at(-1), message)}
          />
        ))}
      </ol>
      {outcome && <p className="rounded-card bg-sunk px-3.5 py-2.5 text-ui text-fg2">{outcome}</p>}
    </>
  )
}
