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
import { Bot, Brain, Check, ChevronRight, Copy } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  rootRun,
  type DelegationView,
  type LiveMessageView,
  type MessageView,
  type PlanView,
  type RestoreView,
  type SessionView,
} from '@cairn/core'
import { translateError, type I18nInstance, type TFunction } from '@cairn/i18n'
import {
  isAgentDraftRef,
  type ContentPart,
  type MentionLines,
  type PromptAgent,
  type PromptSkill,
  type ResolvedMention,
} from '@cairn/protocol'
import { RestoreMarks, restoresByMessage, UndoTurnButton } from './Checkpoints.js'
import { COMPOSER_COMMANDS } from './composer-commands.js'
import { parseMention, tokenize } from './composer-tokens.js'
import { FileTypeIcon } from './file-icons.js'
import { TurnChanges } from './FileChanges.js'
import { DelegationCard } from './DelegationCard.js'
import { Markdown } from './Markdown.js'
import { PlanSummaryCard } from './PlanCard.js'
import { RunningIndicator } from './RunningIndicator.js'
import { outcomePresentation, runningActivityKey, TONE_SOFT } from './status-presentation.js'
import { useSessionStore } from './store-context.js'
import { ToolStep, ToolTimeline } from './ToolTimeline.js'
import {
  Button,
  CairnMark,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
  Shimmer,
} from './ui/index.js'
import { AgentAvatar } from './agents/AgentAvatar.js'
import { agentName } from './agents/model.js'

/** 本轮结束后，最后一条助手消息下面的操作：复制本轮回复、撤销本轮。 */
function TurnActions({
  text,
  children,
}: {
  readonly text: string
  /** 复制之后的其他操作（撤销本轮）。 */
  readonly children?: ReactNode
}) {
  const { t } = useTranslation('session')
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
    </div>
  )
}

const COPIED_MS = 1600

const noopPlan = () => undefined

/** 本次会话挂载时不播动画；之后新出现的消息才淡入。 */
function useEnteringIds(ids: readonly string[]): ReadonlySet<string> {
  const initial = useRef<ReadonlySet<string> | null>(null)
  if (initial.current === null) initial.current = new Set(ids)
  return new Set(ids.filter((id) => !initial.current!.has(id)))
}

/**
 * 思考过程：卡片化的折叠容器（视觉规范 §6）。收起时只有一行“大脑图标 + 思考过程 + 展开箭头”，
 * 展开后正文在卡片里，和助手正文用发丝线隔开。流式输出时标签用流光文字。
 *
 * 正文用 `forceMount` 常驻 DOM、收起时靠高度归零（而不是卸载），这样流式内容和按文本查找都不受影响；
 * 收起状态下加 `aria-hidden`，与原生 `<details>` 一样不让读屏读到未展开的正文。
 */
function Reasoning({ text, live = false }: { readonly text: string; readonly live?: boolean }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mb-2.5 overflow-hidden rounded-card bg-sunk shadow-hair"
    >
      <CollapsibleTrigger className="group/reasoning flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-muted outline-none transition-colors hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent">
        <Brain aria-hidden className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">
          {live ? <Shimmer>{t('message.reasoning')}</Shimmer> : t('message.reasoning')}
        </span>
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-faint transition-transform group-data-[state=open]/reasoning:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount aria-hidden={!open}>
        <span aria-hidden className="block h-[0.5px] bg-hair" />
        <p className="px-3.5 pt-2 pb-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 助手正文：文本按 Markdown 渲染；行内代码里的项目路径可以点开。 */
function AssistantContent({
  parts,
  resolvePaths,
  onOpenFile,
}: {
  readonly parts: readonly ContentPart[]
  readonly resolvePaths: ((paths: readonly string[]) => Promise<ReadonlySet<string>>) | undefined
  readonly onOpenFile: ((path: string, line?: number) => void) | undefined
}) {
  const { t } = useTranslation('session')
  return parts.map((part, index) =>
    part.type === 'text' ? (
      <Markdown key={index} text={part.text} resolvePaths={resolvePaths} onOpenFile={onOpenFile} />
    ) : (
      <p key={index}>{t('message.image')}</p>
    ),
  )
}

const COMMAND_NAMES = COMPOSER_COMMANDS.map((command) => command.name)

const mentionKey = (path: string, lines?: MentionLines) =>
  `${path}:${lines === undefined ? '' : `${lines.start}-${lines.end}`}`

const baseName = (path: string) => path.split('/').at(-1) ?? path

/** 用户消息里确认存在的 `@` 文件引用：点击在右侧打开。 */
function FileMention({
  text,
  path,
  line,
  onOpenFile,
}: {
  readonly text: string
  readonly path: string
  readonly line: number | undefined
  readonly onOpenFile: ((path: string, line?: number) => void) | undefined
}) {
  const content = (
    <>
      <FileTypeIcon name={baseName(path)} />
      {text}
    </>
  )
  const className =
    'inline-flex max-w-full items-center gap-1 rounded-[4px] bg-accent-soft px-1 text-accent align-baseline'
  return onOpenFile === undefined ? (
    <span data-token="mention" className={className}>
      {content}
    </span>
  ) : (
    <button
      type="button"
      data-token="mention"
      title={path}
      onClick={() => onOpenFile(path, line)}
      className={`${className} cursor-pointer outline-none hover:bg-press focus-visible:ring-1 focus-visible:ring-accent`}
    >
      {content}
    </button>
  )
}

/**
 * 用户消息：原样显示（不按 Markdown 解释），保留换行。指令、确认过的 `@` 引用与网址
 * 用和输入框一致的分词高亮；引用和网址可以点。
 */
function UserContent({
  parts,
  mentions,
  skills,
  agents,
  onOpenFile,
}: {
  readonly parts: readonly ContentPart[]
  readonly mentions: readonly ResolvedMention[]
  readonly skills: readonly PromptSkill[]
  readonly agents: readonly PromptAgent[]
  readonly onOpenFile: ((path: string, line?: number) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const resolved = useMemo(
    () => new Set(mentions.map((mention) => mentionKey(mention.path, mention.lines))),
    [mentions],
  )
  const agentNames = useMemo(() => new Set(agents.map((agent) => agent.name)), [agents])
  const renderText = (text: string) =>
    tokenize(text, { commands: COMMAND_NAMES }).map((token) => {
      if (token.type === 'text') return token.text
      if (token.type === 'command') {
        return (
          <span
            key={token.start}
            data-token="command"
            className="rounded-[4px] bg-accent-soft px-0.5 font-mono"
          >
            {token.text}
          </span>
        )
      }
      if (token.type === 'code') {
        return (
          <code key={token.start} className="rounded-[4px] bg-sunk px-0.5 font-mono">
            {token.text}
          </code>
        )
      }
      if (token.type === 'url') {
        return (
          <a
            key={token.start}
            href={token.text}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
          >
            {token.text}
          </a>
        )
      }
      const parsed = parseMention(token.text.slice(1))
      if (parsed === undefined) return token.text
      if (agentNames.has(parsed.path)) {
        return (
          <span
            key={token.start}
            data-token="agent"
            className="inline-flex max-w-full items-center gap-1 rounded-[4px] bg-accent-soft px-1 text-accent align-baseline"
          >
            <Bot aria-hidden className="size-3.5" />
            {token.text}
          </span>
        )
      }
      if (!resolved.has(mentionKey(parsed.path, parsed.lines))) return token.text
      return (
        <FileMention
          key={token.start}
          text={token.text}
          path={parsed.path}
          line={parsed.lines?.start}
          onOpenFile={onOpenFile}
        />
      )
    })

  return parts.map((part, index) => (
    <p key={index} className="whitespace-pre-wrap">
      {part.type === 'text' ? (
        <>
          {index === 0 &&
            skills.map((skill) => (
              <span
                key={skill.name}
                data-token="skill"
                className="mr-1 inline-flex items-center rounded-[4px] bg-accent-soft px-1 font-mono text-note text-accent"
              >
                /{skill.name}
              </span>
            ))}
          {renderText(part.text)}
        </>
      ) : (
        t('message.image')
      )}
    </p>
  ))
}

const textOf = (parts: readonly ContentPart[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n')

export interface TurnFooter {
  readonly text: string
}

/**
 * 每轮最后一条助手消息的轮次操作：本轮已结束（不是进行中的那一轮）时才有。
 * 返回 messageId → 本轮所有助手回复的文本。
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
    footers.set(message.messageId, { text: texts.join('\n\n') })
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
  readonly version: number | undefined
}) {
  const { t } = useTranslation('session')
  return (
    <div className="flex items-center gap-3 text-note text-faint">
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span className="shrink-0">
        {version === undefined
          ? t('chat.agentSwitchedDraft', { name })
          : t('chat.agentSwitched', { name, version })}
      </span>
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
  sessionId,
  continued,
  restores,
  compacted,
  omitted,
  entering,
  onOpenPlan,
  onOpenChanges,
  resolvePaths,
  onOpenFile,
}: {
  readonly message: MessageView
  readonly view: SessionView
  readonly footer: TurnFooter | undefined
  readonly plans: readonly PlanView[]
  /** 审批状态所属的会话；省略时使用当前选中的会话。 */
  readonly sessionId: string | undefined
  /** 这条消息之后发生的恢复。 */
  readonly restores: readonly RestoreView[] | undefined
  /** 紧跟在同一轮的上一条助手消息之后：间距收紧为块间距（14px）。 */
  readonly continued: boolean
  /** 这条消息之前是压缩分隔线。 */
  readonly compacted: boolean
  /** 这条消息之前是“工具输出已省略”的提示。 */
  readonly omitted: boolean
  /** 本次会话中新出现的消息才播入场动画。 */
  readonly entering: boolean
  readonly onOpenPlan: (planId: string) => void
  readonly onOpenChanges?: ((changeSetId?: string) => void) | undefined
  /** 行内代码里的项目路径是否存在；助手正文据此变成可点的路径。 */
  readonly resolvePaths?: ((paths: readonly string[]) => Promise<ReadonlySet<string>>) | undefined
  /** 点击消息里的文件：在右侧打开并定位到行。 */
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const approvals = useSessionStore((s) => {
    const id = sessionId ?? s.activeSessionId
    return id === undefined ? undefined : s.approvals[id]
  })
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
          'flex scroll-mt-4 flex-col items-end rounded-item outline-none focus:outline-none focus-visible:outline-none',
          entering && 'animate-message-in',
        )}
        data-turn={message.turnId}
      >
        {marks}
        <strong className="sr-only">{t('message.user')}</strong>
        <div className="max-w-[78%] rounded-[10px] bg-sunk2 px-3.5 py-2.5 text-fg shadow-1">
          <UserContent
            parts={message.content}
            mentions={message.mentions ?? []}
            skills={message.skills ?? []}
            agents={message.agents ?? []}
            onOpenFile={onOpenFile}
          />
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
    <li className={cn(continued ? '-mt-3.5 text-fg' : 'text-fg', entering && 'animate-message-in')}>
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
      <AssistantContent
        parts={message.content}
        resolvePaths={resolvePaths}
        onOpenFile={onOpenFile}
      />
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
        <TurnChanges
          sessionId={view.sessionId}
          turnId={message.turnId}
          {...(onOpenChanges === undefined ? {} : { onOpen: () => onOpenChanges() })}
        />
      )}
      {footer && (
        <TurnActions text={footer.text}>
          {message.turnId !== undefined && <UndoTurnButton view={view} turnId={message.turnId} />}
        </TurnActions>
      )}
      {cards}
      {restores && <RestoreMarks view={view} restores={restores} />}
    </li>
  )
}

/**
 * 空会话：品牌图形加一句引导，避免消息区只剩一条空白。
 *
 * 不放进消息列表：它是引导，不是消息，列表里只保留真正的消息条目。
 */
function EmptyStream() {
  const { t } = useTranslation('session')
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 pt-16 pb-8 text-center">
      <CairnMark size={44} className="text-faint" />
      <p className="text-ui font-medium text-fg2">{t('chat.empty.title')}</p>
      <p className="max-w-[340px] text-note text-muted">{t('chat.empty.hint')}</p>
      <SuggestionChips />
    </div>
  )
}

/**
 * 新会话的建议提示词（视觉规范 §5）：点一下直接发送，等用户输入第一个字之前作为引导，
 * 之后整个欢迎屏随消息流一起淡出，chip 不重复出现。
 */
function SuggestionChips() {
  const { t } = useTranslation('session')
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const suggestions = [1, 2, 3].map((i) => t(`chat.empty.suggestion.${i}`))
  return (
    <div className="mt-3 flex max-w-[520px] flex-wrap justify-center gap-2">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => void sendPrompt(suggestion)}
          className="rounded-full bg-sunk px-3.5 py-1.5 text-note text-muted shadow-hair outline-none transition-colors hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent"
        >
          {suggestion}
        </button>
      ))}
    </div>
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
  entering,
  resolvePaths,
  onOpenFile,
}: {
  readonly live: LiveMessageView
  readonly view: SessionView | undefined
  readonly continued: boolean
  /** 新出现的流式消息才播入场动画。 */
  readonly entering: boolean
  readonly resolvePaths?: ((paths: readonly string[]) => Promise<ReadonlySet<string>>) | undefined
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
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
    <li
      aria-busy="true"
      className={cn(continued ? '-mt-3.5 text-fg' : 'text-fg', entering && 'animate-message-in')}
    >
      <strong className="sr-only">{t('message.assistant')}</strong>
      {showAgentBadge && agentDisplayName && (
        <div className="mb-1.5 flex items-center gap-1.5 text-note font-medium text-fg2">
          <AgentAvatar icon={agentSummary?.icon} color={agentSummary?.color} size={16} />
          <span>{agentDisplayName}</span>
        </div>
      )}
      {live.reasoning !== '' && <Reasoning text={live.reasoning} live={live.text === ''} />}
      {live.text !== '' && (
        <div className="stream-caret-anchor">
          <Markdown text={live.text} resolvePaths={resolvePaths} onOpenFile={onOpenFile} />
          <span aria-hidden className="stream-caret" />
        </div>
      )}
      {/* 已发出但还没有思考也没有正文：给出「思考中」占位，不留空白条目。 */}
      {live.reasoning === '' && live.text === '' && (
        <p className="flex items-center gap-1.5 text-note text-muted">
          <Shimmer>{t('run.thinking')}</Shimmer>
        </p>
      )}
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
  sessionId,
  onContinue,
  onOpenFile,
}: {
  readonly view: SessionView | undefined
  readonly onOpenPlan?: ((planId: string) => void) | undefined
  readonly onOpenChanges?: ((changeSetId?: string) => void) | undefined
  /** 审批状态所属的会话；省略时使用当前选中的会话。 */
  readonly sessionId?: string | undefined
  /** 达到限额后“继续”的动作；省略时向当前选中的会话发送继续提示。 */
  readonly onContinue?: ((prompt: string) => void) | undefined
  /** 点击消息里的文件：在右侧打开并定位到行。 */
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const openPlan = onOpenPlan ?? noopPlan
  const projects = useSessionStore((s) => s.projects)
  const pathsExist = useSessionStore((s) => s.pathsExist)
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
  const enteringIds = useEnteringIds([
    ...messages.map((message) => message.messageId),
    ...live.map((message) => message.messageId),
  ])
  const awaiting = useSessionStore(
    (s) => view !== undefined && s.awaitingTurn[view.sessionId] === true,
  )
  const outcome = view && turnOutcome(view, t, i18n)
  const outcomeStyle = view ? outcomePresentation(view) : undefined
  const runningKey =
    view !== undefined && outcome === undefined ? runningActivityKey(view, awaiting) : undefined
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const agents = useSessionStore((s) => s.agents) ?? []
  /** 上一轮因限额停下时，可以一键接着做（Runtime §10.3：开始新的一轮，计数重新开始）。 */
  const canContinue = view !== undefined && rootRun(view)?.turn?.limitReached !== undefined
  const footers = view ? turnFooters(view) : new Map<string, TurnFooter>()
  const switchedRuns = useMemo(() => {
    if (!view || view.runOrder.length <= 1)
      return new Map<string, { name: string; version: number | undefined }>()
    const map = new Map<string, { name: string; version: number | undefined }>()
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
        map.set(firstMsg.messageId, {
          name,
          version: isAgentDraftRef(run.agent) ? undefined : run.agent.version,
        })
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
        return {
          name,
          version: isAgentDraftRef(run.agent) ? undefined : run.agent.version,
        }
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
  const projectId =
    view?.info?.projectPath === undefined
      ? undefined
      : projects?.find((project) => project.path === view.info?.projectPath)?.projectId
  const resolvePaths = useMemo(() => {
    if (projectId === undefined || typeof pathsExist !== 'function') return undefined
    return (paths: readonly string[]) => pathsExist(projectId, paths)
  }, [pathsExist, projectId])
  if (!view) {
    return (
      <>
        <EmptyStream />
        <ol aria-label={t('chat.messages')} className="flex flex-col gap-7" />
      </>
    )
  }
  return (
    <>
      {messages.length === 0 && live.length === 0 && runningKey === undefined && <EmptyStream />}
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
                sessionId={sessionId}
                continued={continues(messages[index - 1], message)}
                restores={restores.get(message.messageId)}
                compacted={markBetween(previous, message.seq, view.compaction)}
                omitted={markBetween(previous, message.seq, view.toolOutputOmitted)}
                entering={enteringIds.has(message.messageId)}
                onOpenPlan={openPlan}
                onOpenChanges={onOpenChanges}
                resolvePaths={resolvePaths}
                onOpenFile={onOpenFile}
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
              <PlanSummaryCard plan={plan} onOpen={openPlan} />
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
            entering={enteringIds.has(message.messageId)}
            resolvePaths={resolvePaths}
            onOpenFile={onOpenFile}
          />
        ))}
      </ol>
      {runningKey !== undefined && <RunningIndicator text={t(runningKey)} />}
      {outcome && outcomeStyle && (
        <div
          className={`flex items-center gap-3 rounded-card px-3.5 py-2.5 text-ui ${TONE_SOFT[outcomeStyle.tone]}`}
        >
          <span role="img" aria-label={t(outcomeStyle.iconLabelKey)} className="shrink-0">
            <outcomeStyle.Icon aria-hidden className="size-4" />
          </span>
          <p className="min-w-0 flex-1">{outcome}</p>
          {canContinue && (
            <Button
              size="sm"
              onClick={() => {
                const prompt = t('turn.continue.prompt')
                if (onContinue) onContinue(prompt)
                else void sendPrompt(prompt)
              }}
            >
              {t('turn.continue')}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
