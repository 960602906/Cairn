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
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  rootRun,
  type CheckpointView,
  type DelegationView,
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
import { DelegationCard } from './DelegationCard.js'
import { Markdown } from './Markdown.js'
import { PlanSummaryCard } from './PlanCard.js'
import { useSessionStore } from './store-context.js'
import { ToolStep, ToolTimeline } from './ToolTimeline.js'
import { Button, cn, IconButton, Shimmer } from './ui/index.js'
import { AgentAvatar } from './agents/AgentAvatar.js'
import { agentName } from './agents/AgentsPage.js'

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
  const messages = view.messages.filter((message) => {
    const run = view.runs[message.runId]
    return run === undefined || run.parentRunId === undefined
  })
  const texts: string[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      texts.length = 0
      return
    }
    const text = textOf(message.content)
    if (text !== '') texts.push(text)
    const next = messages[index + 1]
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

function AgentSwitchDivider({
  name,
  version,
}: {
  readonly name: string
  readonly version: number
}) {
  const { t } = useTranslation('session')
  return (
    <div className="flex items-center gap-3 text-note text-faint">
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span className="shrink-0">{t('chat.agentSwitched', { name, version })}</span>
      <span aria-hidden className="h-px flex-1 bg-hair" />
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
  onOpenPlan,
  locatedTurnId,
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
  readonly onOpenPlan: (planId: string) => void
  readonly locatedTurnId?: string | undefined
}) {
  const { t } = useTranslation('session')
  const approvals = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.approvals[s.activeSessionId],
  )
  const agents = useSessionStore((s) => s.agents) ?? []
  const { i18n } = useTranslation('session')
  const awaiting = new Set(approvals?.map((a) => a.toolCallId))
  const cards = plans.map((plan) => (
    <PlanSummaryCard key={plan.planId} plan={plan} onOpen={onOpenPlan} />
  ))
  const marks = (compacted || omitted) && (
    <div className="mb-3.5 flex w-full flex-col gap-2 self-stretch">
      {compacted && view.compaction && <CompactionMark summary={view.compaction.summary} />}
      {omitted && <OmissionNote />}
    </div>
  )
  if (message.role === 'user') {
    return (
      <li
        tabIndex={-1}
        className={cn(
          'flex scroll-mt-4 flex-col items-end rounded-item outline-none',
          locatedTurnId === message.turnId && 'ring-1 ring-accent/40',
        )}
        data-turn={message.turnId}
      >
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
      {(() => {
        const run = view.runs[message.runId]
        const showAgentBadge =
          view.runOrder.filter((runId) => view.runs[runId]?.parentRunId === undefined).length > 1 &&
          !continued
        const agent = run?.agent
        const agentSummary = agent ? agents.find((a) => a.agentId === agent.id) : undefined
        const agentDisplayName = agentSummary
          ? agentName(agentSummary, i18n.language)
          : agent?.id === 'builtin.coder'
            ? t('composer.agent.default')
            : agent?.id
        if (!showAgentBadge || !agentDisplayName) return null
        return (
          <div className="mb-1.5 flex items-center gap-1.5 text-note font-medium text-fg2">
            <AgentAvatar icon={agentSummary?.icon} color={agentSummary?.color} size={16} />
            <span>{agentDisplayName}</span>
          </div>
        )
      })()}
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
  view,
  continued,
}: {
  readonly live: LiveMessageView
  readonly view: SessionView | undefined
  readonly continued: boolean
}) {
  const { t, i18n } = useTranslation('session')
  const agents = useSessionStore((s) => s.agents) ?? []
  const run = view?.runs[live.runId]
  const showAgentBadge =
    view !== undefined &&
    view.runOrder.filter((runId) => view.runs[runId]?.parentRunId === undefined).length > 1 &&
    !continued
  const agent = run?.agent
  const agentSummary = agent ? agents.find((a) => a.agentId === agent.id) : undefined
  const agentDisplayName = agentSummary
    ? agentName(agentSummary, i18n.language)
    : agent?.id === 'builtin.coder'
      ? t('composer.agent.default')
      : agent?.id
  return (
    <li aria-busy="true" className={continued ? '-mt-3.5 text-fg' : 'text-fg'}>
      <strong className="sr-only">{t('message.assistant')}</strong>
      {showAgentBadge && agentDisplayName && (
        <div className="mb-1.5 flex items-center gap-1.5 text-note font-medium text-fg2">
          <AgentAvatar icon={agentSummary?.icon} color={agentSummary?.color} size={16} />
          <span>{agentDisplayName}</span>
        </div>
      )}
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

export function MessageStream({
  view,
  onOpenPlan,
  onOpenChanges,
  locatedTurnId,
}: {
  readonly view: SessionView | undefined
  readonly onOpenPlan: (planId: string) => void
  readonly onOpenChanges?: ((changeSetId?: string) => void) | undefined
  readonly locatedTurnId?: string | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const providers = useSessionStore((s) => s.settings?.providers)
  const messages = view
    ? view.messages.filter((message) => {
        const run = view.runs[message.runId]
        return run === undefined || run.parentRunId === undefined
      })
    : []
  const live = Object.values(view?.live ?? {})
    .filter((message) => {
      const run = view?.runs[message.runId]
      return run === undefined || run.parentRunId === undefined
    })
    .sort((a, b) => a.startedAt - b.startedAt)
  const outcome = view && turnOutcome(view, t, i18n)
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const agents = useSessionStore((s) => s.agents) ?? []
  /** 上一轮因限额停下时，可以一键接着做（Runtime §10.3：开始新的一轮，计数重新开始）。 */
  const canContinue = view !== undefined && rootRun(view)?.turn?.limitReached !== undefined
  const footers = view ? turnFooters(view) : new Map<string, TurnFooter>()
  const switchedRuns = useMemo(() => {
    if (!view || view.runOrder.length <= 1)
      return new Map<string, { name: string; version: number }>()
    const map = new Map<string, { name: string; version: number }>()
    for (let i = 1; i < view.runOrder.length; i++) {
      const runId = view.runOrder[i]
      if (runId === undefined) continue
      const run = view.runs[runId]
      if (!run || run.parentRunId !== undefined) continue
      const firstMsg = view.messages.find((m) => m.runId === runId)
      if (firstMsg) {
        const summary = agents.find((a) => a.agentId === run.agent.id)
        const name = summary
          ? agentName(summary, i18n.language)
          : run.agent.id === 'builtin.coder'
            ? t('composer.agent.default')
            : run.agent.id
        map.set(firstMsg.messageId, { name, version: run.agent.version })
      }
    }
    return map
  }, [view, agents, i18n.language, t])
  const liveSwitch = useMemo(() => {
    if (!view || view.runOrder.length <= 1 || live.length === 0) return undefined
    const firstLive = live[0]
    if (!firstLive) return undefined
    const runIdx = view.runOrder.indexOf(firstLive.runId)
    if (runIdx > 0 && !messages.some((m) => m.runId === firstLive.runId)) {
      const run = view.runs[firstLive.runId]
      if (run) {
        const summary = agents.find((a) => a.agentId === run.agent.id)
        const name = summary
          ? agentName(summary, i18n.language)
          : run.agent.id === 'builtin.coder'
            ? t('composer.agent.default')
            : run.agent.id
        return { name, version: run.agent.version }
      }
    }
    return undefined
  }, [view, live, messages, agents, i18n.language, t])
  const anchored = new Set(
    (view?.plans ?? []).flatMap((plan) =>
      plan.turnId !== undefined && messages.some((message) => message.turnId === plan.turnId)
        ? [plan.planId]
        : [],
    ),
  )
  const turns = view ? turnNumbers(view) : new Map<string, number>()
  const checkpoints = view ? turnCheckpoints(view) : new Map<string, CheckpointView>()
  const restores = view ? restoresByMessage(view) : new Map<string, readonly RestoreView[]>()
  const delegationsByTurn = useMemo(() => {
    const map = new Map<string, DelegationView[]>()
    for (const delegation of view?.delegations ?? []) {
      if (delegation.turnId === undefined) continue
      const list = map.get(delegation.turnId) ?? []
      list.push(delegation)
      map.set(delegation.turnId, list)
    }
    return map
  }, [view])
  const looseDelegations = (view?.delegations ?? []).filter((item) => item.turnId === undefined)
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
  if (!view) {
    return <ol aria-label={t('chat.messages')} className="flex flex-col gap-7" />
  }
  return (
    <>
      <ol aria-label={t('chat.messages')} className="flex flex-col gap-7">
        {messages.map((message, index) => {
          const previous = messages[index - 1]?.seq ?? 0
          const next = messages[index + 1]
          const lastOfTurn = next === undefined || next.turnId !== message.turnId
          const switchInfo = switchedRuns.get(message.messageId)
          return (
            <Fragment key={message.messageId}>
              {switchInfo && (
                <li className="list-none">
                  <AgentSwitchDivider name={switchInfo.name} version={switchInfo.version} />
                </li>
              )}
              <Message
                message={message}
                view={view}
                footer={footers.get(message.messageId)}
                plans={
                  lastOfTurn && message.turnId !== undefined
                    ? view.plans.filter((plan) => plan.turnId === message.turnId)
                    : []
                }
                modelName={modelName}
                continued={continues(messages[index - 1], message)}
                divider={dividerFor(message, index)}
                restores={restores.get(message.messageId)}
                compacted={markBetween(previous, message.seq, view.compaction)}
                omitted={markBetween(previous, message.seq, view.toolOutputOmitted)}
                onOpenPlan={onOpenPlan}
                locatedTurnId={locatedTurnId}
              />
              {lastOfTurn &&
                message.turnId !== undefined &&
                (delegationsByTurn.get(message.turnId) ?? []).map((delegation) => (
                  <li key={delegation.childRunId} className="list-none">
                    <DelegationCard
                      sessionId={view.sessionId}
                      view={view}
                      delegation={delegation}
                      onOpenChanges={onOpenChanges}
                    />
                  </li>
                ))}
            </Fragment>
          )
        })}
        {looseDelegations.map((delegation) => (
          <li key={delegation.childRunId} className="list-none">
            <DelegationCard
              sessionId={view!.sessionId}
              view={view!}
              delegation={delegation}
              onOpenChanges={onOpenChanges}
            />
          </li>
        ))}
        {view?.plans
          .filter((plan) => !anchored.has(plan.planId))
          .map((plan) => (
            <li key={plan.planId} className="list-none">
              <PlanSummaryCard plan={plan} onOpen={onOpenPlan} />
            </li>
          ))}
        {view?.compaction && afterLast(messages.at(-1)?.seq ?? 0, view.compaction) && (
          <li className="list-none">
            <CompactionMark summary={view.compaction.summary} />
          </li>
        )}
        {view?.toolOutputOmitted &&
          afterLast(messages.at(-1)?.seq ?? 0, view.toolOutputOmitted) && (
            <li className="list-none">
              <OmissionNote />
            </li>
          )}
        {liveSwitch && (
          <li className="list-none">
            <AgentSwitchDivider name={liveSwitch.name} version={liveSwitch.version} />
          </li>
        )}
        {live.map((message, index) => (
          <LiveMessage
            key={message.messageId}
            live={message}
            view={view}
            continued={index === 0 && continues(messages.at(-1), message)}
          />
        ))}
      </ol>
      {outcome && (
        <div className="flex items-center gap-3 rounded-card bg-sunk px-3.5 py-2.5 text-ui text-fg2">
          <p className="min-w-0 flex-1">{outcome}</p>
          {canContinue && (
            <Button size="sm" onClick={() => void sendPrompt(t('turn.continue.prompt'))}>
              {t('turn.continue')}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
