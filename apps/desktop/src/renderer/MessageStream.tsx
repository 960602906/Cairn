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
import { Bot, Check, ChevronRight, Copy, Lightbulb } from 'lucide-react'
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  rootRun,
  type AssistantMessageView,
  type DelegationView,
  type LiveMessageView,
  type MessageView,
  type PlanView,
  type RestoreView,
  type ReviewLoopView,
  type PipelineView,
  type SessionView,
  type ToolCallView,
} from '@cairn/core'
import { translateError, type I18nInstance, type TFunction } from '@cairn/i18n'
import {
  isAgentDraftRef,
  type ContentPart,
  type MentionLines,
  type PromptAgent,
  type PromptSkill,
  type ResolvedMention,
  type ToolCall,
} from '@cairn/protocol'
import { RestoreMarks, restoresByMessage, UndoTurnButton } from './Checkpoints.js'
import { COMPOSER_COMMANDS } from './composer-commands.js'
import { parseMention, tokenize } from './composer-tokens.js'
import { FileTypeIcon } from './file-icons.js'
import { TurnChanges } from './FileChanges.js'
import { DelegationCard } from './DelegationCard.js'
import { Markdown } from './Markdown.js'
import { PlanSummaryCard } from './PlanCard.js'
import { PipelineCard } from './PipelineCard.js'
import { ReviewLoopCard } from './ReviewLoopCard.js'
import { RunningIndicator } from './RunningIndicator.js'
import { outcomePresentation, runningActivityKey, TONE_SOFT } from './status-presentation.js'
import { useSessionStore } from './store-context.js'
import {
  ACTIVITY_TRIGGER_CLASS,
  ActivityGroupHeaderContent,
  activityDuration,
  describeToolCall,
  summarizeActivity,
  ToolStep,
  ToolTimeline,
  type ActivityHeadline,
} from './ToolTimeline.js'
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
 * 思考过程：一行淡字（“思考 · 一句话摘要”），点开看全文。
 *
 * 它同时充当执行过程的阶段分隔：连续的工具步骤被思考切成几段，扫读时有了停顿。
 * 正文用 `forceMount` 常驻 DOM、收起时靠高度归零（而不是卸载），这样流式内容和按文本查找都不受影响；
 * 收起状态下加 `aria-hidden`，与原生 `<details>` 一样不让读屏读到未展开的正文。
 */
const Reasoning = memo(function Reasoning({
  text,
  live = false,
}: {
  readonly text: string
  readonly live?: boolean
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const firstLine = text.replace(/\s+/g, ' ').trim()
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-full">
      <CollapsibleTrigger
        aria-label={t('message.reasoning')}
        className="group/reasoning -mx-[7px] grid h-[26px] w-full cursor-pointer grid-cols-[18px_auto_minmax(0,1fr)_14px] items-center gap-x-[7px] rounded-[7px] px-[7px] text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span className="flex w-[18px] items-center">
          <Lightbulb aria-hidden className="size-[13px] shrink-0 text-faint opacity-55" />
        </span>
        <span className="w-[26px] shrink-0 text-[11px] tracking-[.04em] text-faint opacity-80">
          {t('message.reasoningShort')}
        </span>
        <span className="min-w-0 truncate text-[12.5px] text-muted">
          {firstLine === '' ? (
            live ? (
              <Shimmer>{t('message.reasoning')}</Shimmer>
            ) : (
              t('message.reasoning')
            )
          ) : (
            firstLine
          )}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-faint opacity-0 transition-transform duration-150 group-hover/reasoning:opacity-70',
            open && 'rotate-90 opacity-70',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount aria-hidden={!open} className={cn(!open && 'hidden')}>
        <div className="mt-1 mb-1.5 ml-[25px] rounded-[8px] bg-sunk px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

/** 助手正文：文本按 Markdown 渲染；行内代码里的项目路径可以点开。 */
const AssistantContent = memo(function AssistantContent({
  parts,
  resolvePaths,
  onOpenFile,
}: {
  readonly parts: readonly ContentPart[]
  readonly resolvePaths:
    ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined
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
})

export interface TurnActivityStep {
  readonly key: string
  readonly reasoning?: string | undefined
  readonly content?: readonly ContentPart[] | undefined
  readonly toolCalls?: readonly ToolCall[] | undefined
}

interface TurnActivityGroupProps {
  readonly steps: readonly TurnActivityStep[]
  readonly view: SessionView
  readonly isRunning: boolean
  readonly hasAwaitingApproval: boolean
  readonly awaiting: ReadonlySet<string>
  readonly resolvePaths?:
    ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
}

/**
 * 组头里的“卡点”：只有需要用户留意时才点明具体是哪一步。
 *
 * - 有失败：`<命令> 失败`
 * - 有取消：`<命令> 已取消`（用户按了停止，不是失败）
 * - 有等待审批：`等待审批 <命令>`
 * - 最后一步命令非零退出：`<命令> 失败`（后面又跑了别的步骤，说明模型已经接着处理，
 *   此时交给整组摘要，不让一次旧失败永久占住组头）
 *
 * 其余时候组头用 {@link summaryHeadline} 说这组做过什么，不再显示“正在执行 / 已执行 N 步”。
 */
function liveHeadline({
  calls,
  tools,
  awaiting,
  t,
}: {
  readonly calls: readonly ToolCall[]
  readonly tools: Readonly<Record<string, ToolCallView>>
  readonly awaiting: ReadonlySet<string> | undefined
  readonly t: TFunction
}): ActivityHeadline | undefined {
  const statusOf = (call: ToolCall) => tools[call.id]?.status
  const argsOf = (call: ToolCall) => tools[call.id]?.input ?? call.input
  const describe = (call: ToolCall) => describeToolCall(call.name, argsOf(call), t)
  /** 命令跑起来了但退出码不是 0：工具本身“完成”，这一步其实失败了。 */
  const badExit = (call: ToolCall) => {
    const code = tools[call.id]?.display?.exitCode
    return typeof code === 'number' && code !== 0
  }

  const failed = calls.find((call) => statusOf(call) === 'failed')
  if (failed) {
    const { object, plain } = describe(failed)
    return { tone: 'attention', label: t('tool.group.failed'), object, plain, objectFirst: true }
  }
  const cancelled = calls.find((call) => statusOf(call) === 'cancelled')
  if (cancelled) {
    const { object, plain } = describe(cancelled)
    return {
      tone: 'cancelled',
      label: t('tool.group.cancelled'),
      object,
      plain,
      objectFirst: true,
    }
  }
  const waiting = calls.find((call) => awaiting?.has(call.id) === true)
  if (waiting) {
    const { object, plain } = describe(waiting)
    return { tone: 'waiting', label: t('tool.group.waiting'), object, plain }
  }
  const last = calls.at(-1)
  if (last !== undefined && statusOf(last) === 'completed' && badExit(last)) {
    const { object, plain } = describe(last)
    return { tone: 'attention', label: t('tool.group.failed'), object, plain, objectFirst: true }
  }
  return undefined
}

/** 折叠后的组头：把这一组做过的事说成一句话，右侧带上总耗时。 */
function summaryHeadline({
  calls,
  tools,
  isRunning,
  t,
}: {
  readonly calls: readonly ToolCall[]
  readonly tools: Readonly<Record<string, ToolCallView>>
  readonly isRunning: boolean
  readonly t: TFunction
}): ActivityHeadline {
  return {
    tone: isRunning ? 'running' : 'done',
    label: summarizeActivity(calls, tools, t) ?? t('tool.group.thinking'),
    meta: activityDuration(calls, tools),
  }
}

/** 单条助手消息（没有归组）的组头：和归组一样，优先点明卡点，否则说做过什么。 */
function messageHeadline(
  message: AssistantMessageView,
  view: SessionView,
  awaiting: ReadonlySet<string>,
  running: boolean,
  t: TFunction,
): ActivityHeadline {
  const live = liveHeadline({ calls: message.toolCalls, tools: view.tools, awaiting, t })
  if (live) return live
  return summaryHeadline({ calls: message.toolCalls, tools: view.tools, isRunning: running, t })
}

const TurnActivityGroup = memo(function TurnActivityGroup({
  steps,
  view,
  isRunning,
  hasAwaitingApproval,
  awaiting,
  resolvePaths,
  onOpenFile,
}: TurnActivityGroupProps) {
  const { t } = useTranslation('session')
  const calls = useMemo(() => steps.flatMap((step) => step.toolCalls ?? []), [steps])

  const headline = useMemo<ActivityHeadline>(() => {
    const live = liveHeadline({ calls, tools: view.tools, awaiting, t })
    if (live) return live
    return summaryHeadline({ calls, tools: view.tools, isRunning, t })
  }, [calls, view.tools, awaiting, t, isRunning])

  /** 失败、取消或等待审批时组保持展开，把出错的那一步露在外面；其余时候一律折叠。 */
  const needsAttention =
    hasAwaitingApproval ||
    headline.tone === 'attention' ||
    headline.tone === 'cancelled' ||
    headline.tone === 'waiting'

  const [open, setOpen] = useState(needsAttention)
  const [manuallyOpened, setManuallyOpened] = useState(false)

  // 状态变化时自动更新展开状态（如果用户没手动操作）
  useEffect(() => {
    if (!manuallyOpened) {
      setOpen(needsAttention)
    }
  }, [needsAttention, manuallyOpened])

  const handleToggle = () => {
    setManuallyOpened(true)
    setOpen(!open)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2 max-w-full">
      <CollapsibleTrigger
        onClick={handleToggle}
        data-activity-group
        className={ACTIVITY_TRIGGER_CLASS}
      >
        <ActivityGroupHeaderContent
          headline={headline}
          open={open}
          shimmer={headline.tone === 'running'}
        />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount aria-hidden={!open} className={cn(!open && 'hidden')}>
        <div className="flex flex-col pt-0.5 pb-1">
          {steps.map((step) => (
            <Fragment key={step.key}>
              {step.reasoning && <Reasoning text={step.reasoning} />}
              {step.content && step.content.length > 0 && (
                <div className="py-1">
                  <AssistantContent
                    parts={step.content}
                    resolvePaths={resolvePaths}
                    onOpenFile={onOpenFile}
                  />
                </div>
              )}
              {step.toolCalls && step.toolCalls.length > 0 && (
                <ToolTimeline>
                  {step.toolCalls.map((call) => (
                    <ToolStep
                      key={call.id}
                      name={call.name}
                      input={call.input}
                      tool={view.tools[call.id]}
                      live={view.liveToolOutput[call.id]}
                      awaitingApproval={awaiting.has(call.id)}
                      onOpenFile={onOpenFile}
                    />
                  ))}
                </ToolTimeline>
              )}
            </Fragment>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

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
const UserContent = memo(function UserContent({
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
})

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
  reviewLoops,
  pipelines,
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
  /** 这一轮的审查循环（M7-07）：挂在最后一轮消息后面。 */
  readonly reviewLoops: readonly ReviewLoopView[]
  /** 这一轮的流水线（M7-08）。 */
  readonly pipelines: readonly PipelineView[]
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
  readonly resolvePaths?:
    ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined
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
  const cards = [
    ...plans.map((plan) => <PlanSummaryCard key={plan.planId} plan={plan} onOpen={onOpenPlan} />),
    ...reviewLoops.map((loop) => <ReviewLoopCard key={loop.reviewId} loop={loop} />),
    ...pipelines.map((pipeline) => <PipelineCard key={pipeline.pipelineId} pipeline={pipeline} />),
  ]
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
  const messageRunning = message.toolCalls.some((call) => {
    const status = view.tools[call.id]?.status
    return (
      status === 'requested' ||
      status === 'running' ||
      (status === undefined && view.runs[message.runId]?.turn?.status === 'running')
    )
  })
  const headline = messageHeadline(message, view, awaiting, messageRunning, t)
  const messageAttention =
    headline.tone === 'attention' || headline.tone === 'cancelled' || headline.tone === 'waiting'

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
        <ToolTimeline
          count={message.toolCalls.length}
          running={messageRunning}
          attention={messageAttention}
          headline={headline}
        >
          {message.toolCalls.map((call) => (
            <ToolStep
              key={call.id}
              name={call.name}
              input={call.input}
              tool={view.tools[call.id]}
              live={view.liveToolOutput[call.id]}
              awaitingApproval={awaiting.has(call.id)}
              onOpenFile={onOpenFile}
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
          {...(onOpenFile === undefined ? {} : { onOpenFile: (path: string) => onOpenFile(path) })}
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
  readonly resolvePaths?:
    ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined
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
          <Markdown
            text={live.text}
            resolvePaths={resolvePaths}
            onOpenFile={onOpenFile}
            debounceMs={300}
          />
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

type RenderItem =
  | {
      readonly kind: 'message'
      readonly message: MessageView
      readonly index: number
    }
  | {
      readonly kind: 'activity_group'
      readonly turnId: string | undefined
      readonly messages: readonly AssistantMessageView[]
      readonly indices: readonly number[]
    }

function groupMessages(messages: readonly MessageView[]): RenderItem[] {
  const items: RenderItem[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    const isAssistant = msg.role === 'assistant'
    const hasToolsLaterInTurn =
      isAssistant &&
      msg.turnId !== undefined &&
      messages
        .slice(i + 1)
        .some((m) => m.role === 'assistant' && m.turnId === msg.turnId && m.toolCalls.length > 0)

    const isFinalResponse = isAssistant && msg.content.length > 0 && !hasToolsLaterInTurn
    const isActivityStep =
      isAssistant &&
      !isFinalResponse &&
      (msg.toolCalls.length > 0 ||
        (msg.reasoning !== undefined && msg.reasoning.text !== '') ||
        hasToolsLaterInTurn)

    if (!isActivityStep) {
      items.push({ kind: 'message', message: msg, index: i })
      i++
      continue
    }

    // 收集同一轮内连续的中间工具/思考步骤
    const activityGroup: AssistantMessageView[] = [msg as AssistantMessageView]
    const indices: number[] = [i]
    let j = i + 1
    while (j < messages.length) {
      const next = messages[j]!
      const nextHasToolsLater =
        next.role === 'assistant' &&
        next.turnId !== undefined &&
        messages
          .slice(j + 1)
          .some((m) => m.role === 'assistant' && m.turnId === next.turnId && m.toolCalls.length > 0)
      const nextIsFinalResponse =
        next.role === 'assistant' && next.content.length > 0 && !nextHasToolsLater

      if (
        next.role === 'assistant' &&
        next.turnId !== undefined &&
        next.turnId === msg.turnId &&
        !nextIsFinalResponse &&
        (next.toolCalls.length > 0 ||
          (next.reasoning !== undefined && next.reasoning.text !== '') ||
          nextHasToolsLater)
      ) {
        activityGroup.push(next as AssistantMessageView)
        indices.push(j)
        j++
      } else {
        break
      }
    }

    const totalToolCalls = activityGroup.reduce((sum, m) => sum + m.toolCalls.length, 0)
    const totalReasonings = activityGroup.filter(
      (m) => m.reasoning !== undefined && m.reasoning.text !== '',
    ).length
    const isMultiStep =
      activityGroup.length > 1 ||
      totalToolCalls >= 2 ||
      (totalToolCalls >= 1 && totalReasonings >= 1)

    if (isMultiStep) {
      items.push({
        kind: 'activity_group',
        turnId: msg.turnId,
        messages: activityGroup,
        indices,
      })
    } else {
      for (let k = 0; k < activityGroup.length; k++) {
        items.push({
          kind: 'message',
          message: activityGroup[k]!,
          index: indices[k]!,
        })
      }
    }
    i = j
  }

  return items
}

export function MessageStream({
  view,
  onOpenPlan,
  onOpenChanges,
  sessionId,
  onContinue,
  onOpenFile,
  onOpenRun,
}: {
  readonly view: SessionView | undefined
  readonly onOpenPlan?: ((planId: string) => void) | undefined
  readonly onOpenChanges?: ((changeSetId?: string) => void) | undefined
  /** 点击委派卡片：在右侧工作台打开子 Agent 详情。 */
  readonly onOpenRun?: ((runId: string) => void) | undefined
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
  const approvals = useSessionStore((s) => {
    const id = sessionId ?? s.activeSessionId
    return id === undefined ? undefined : s.approvals[id]
  })
  const awaitingApprovalSet = useMemo(
    () => new Set(approvals?.map((a) => a.toolCallId)),
    [approvals],
  )
  const messages = view
    ? view.messages.filter((message) => {
        const run = view.runs[message.runId]
        return run === undefined || run.parentRunId === undefined
      })
    : []
  const groupedItems = useMemo(() => groupMessages(messages), [messages])
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
  const anchoredLoops = new Set(
    (view?.reviewLoops ?? []).flatMap((loop) =>
      loop.turnId !== undefined && messages.some((message) => message.turnId === loop.turnId)
        ? [loop.reviewId]
        : [],
    ),
  )
  const anchoredPipelines = new Set(
    (view?.pipelineRuns ?? []).flatMap((pipeline) =>
      pipeline.turnId !== undefined &&
      messages.some((message) => message.turnId === pipeline.turnId)
        ? [pipeline.pipelineId]
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
  // 没有落到任何一轮消息末尾的委派：还没有轮次归属、本轮的完成消息尚未到达（只有 live 消息），
  // 或者这一轮没有可挂靠的消息。它们排在流末尾，保证运行中的子 Agent 也能看到。
  const turnsWithMessages = useMemo(
    () =>
      new Set(
        messages.flatMap((message) => (message.turnId === undefined ? [] : [message.turnId])),
      ),
    [messages],
  )
  const orphanDelegations = (view?.delegations ?? []).filter(
    (item) => item.turnId === undefined || !turnsWithMessages.has(item.turnId),
  )
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
  /**
   * 末尾那一条是否就是正在跑的内容：是的话，状态由它的组头承担（“正在调用工具”），
   * 下面不再补一行运行指示 —— 两行说同一件事只是噪音。
   */
  const rootTurnId = rootRun(view)?.turn?.turnId
  const tail = groupedItems.at(-1)
  // 只有末尾这一条自己有组头（归组，或带工具调用的助手消息）时，才由它承担状态。
  const tailHasHeader =
    tail?.kind === 'activity_group' ||
    (tail?.kind === 'message' &&
      tail.message.role === 'assistant' &&
      tail.message.toolCalls.length > 0)
  const tailIsLive =
    runningKey !== undefined &&
    tail !== undefined &&
    tailHasHeader &&
    (tail.kind === 'activity_group' ? tail.turnId : tail.message.turnId) === rootTurnId

  return (
    <>
      {messages.length === 0 && live.length === 0 && runningKey === undefined && <EmptyStream />}
      <ol aria-label={t('chat.messages')} className="flex flex-col gap-7">
        {groupedItems.map((item) => {
          if (item.kind === 'message') {
            const message = item.message
            const previous = messages[item.index - 1]?.seq ?? 0
            const next = messages[item.index + 1]
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
                  reviewLoops={
                    lastOfTurn && message.turnId !== undefined
                      ? (view.reviewLoops ?? []).filter((loop) => loop.turnId === message.turnId)
                      : []
                  }
                  pipelines={
                    lastOfTurn && message.turnId !== undefined
                      ? (view.pipelineRuns ?? []).filter(
                          (pipeline) => pipeline.turnId === message.turnId,
                        )
                      : []
                  }
                  sessionId={sessionId}
                  continued={continues(messages[item.index - 1], message)}
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
                        {...(onOpenRun === undefined ? {} : { onOpenRun })}
                      />
                    </li>
                  ))}
              </Fragment>
            )
          }

          // activity_group: 同一轮中连续的多个工具调用/思考步骤
          const group = item.messages
          const firstMsg = group[0]!
          const lastMsg = group[group.length - 1]!
          const firstIndex = item.indices[0]!
          const lastIndex = item.indices[item.indices.length - 1]!
          const previous = messages[firstIndex - 1]?.seq ?? 0
          const nextMsg = messages[lastIndex + 1]
          const lastOfTurn = nextMsg === undefined || nextMsg.turnId !== item.turnId
          const switchInfo = switchedRuns.get(firstMsg.messageId)
          const continued = continues(messages[firstIndex - 1], firstMsg)
          const entering = group.some((m) => enteringIds.has(m.messageId))

          const steps: TurnActivityStep[] = group.map((m) => ({
            key: m.messageId,
            reasoning: m.reasoning?.text,
            content: m.content.length > 0 ? m.content : undefined,
            toolCalls: m.toolCalls,
          }))

          const isTurnRunning =
            (rootRun(view)?.turn?.status === 'running' &&
              rootRun(view)?.turn?.turnId === item.turnId) ||
            Object.values(view?.live ?? {}).some((l) => l.turnId === item.turnId)
          const hasAwaitingApproval = group.some((m) =>
            m.toolCalls.some((c) => awaitingApprovalSet.has(c.id)),
          )

          const compacted = markBetween(previous, firstMsg.seq, view.compaction)
          const omitted = markBetween(previous, firstMsg.seq, view.toolOutputOmitted)
          const marks = (compacted || omitted) && (
            <div className="mb-3.5 flex w-full flex-col gap-2 self-stretch">
              {compacted && view.compaction && <CompactionMark summary={view.compaction.summary} />}
              {omitted && <OmissionNote />}
            </div>
          )

          const run = view.runs[firstMsg.runId]
          const showAgentBadge =
            view.runOrder.filter((runId) => view.runs[runId]?.parentRunId === undefined).length >
              1 && !continued
          const agent = run?.agent
          const agentSummary = agent ? agents.find((a) => a.agentId === agent.id) : undefined
          const agentDisplayName = agentSummary
            ? agentName(agentSummary, i18n.language)
            : agent?.id === 'builtin.coder'
              ? t('composer.agent.default')
              : agent?.id

          const plans =
            lastOfTurn && lastMsg.turnId !== undefined
              ? view.plans.filter((plan) => plan.turnId === lastMsg.turnId)
              : []
          const loops =
            lastOfTurn && lastMsg.turnId !== undefined
              ? (view.reviewLoops ?? []).filter((loop) => loop.turnId === lastMsg.turnId)
              : []
          const pipelines =
            lastOfTurn && lastMsg.turnId !== undefined
              ? (view.pipelineRuns ?? []).filter((pipeline) => pipeline.turnId === lastMsg.turnId)
              : []
          const cards = [
            ...plans.map((plan) => (
              <PlanSummaryCard key={plan.planId} plan={plan} onOpen={openPlan} />
            )),
            ...loops.map((loop) => <ReviewLoopCard key={loop.reviewId} loop={loop} />),
            ...pipelines.map((pipeline) => (
              <PipelineCard key={pipeline.pipelineId} pipeline={pipeline} />
            )),
          ]
          const restoresForMsg = restores.get(lastMsg.messageId)
          const footer = footers.get(lastMsg.messageId)

          return (
            <Fragment key={firstMsg.messageId}>
              {switchInfo && (
                <li className="list-none">
                  <AgentSwitchDivider name={switchInfo.name} version={switchInfo.version} />
                </li>
              )}
              <li
                className={cn(
                  continued ? '-mt-3.5 text-fg' : 'text-fg',
                  entering && 'animate-message-in',
                )}
              >
                {marks}
                <strong className="sr-only">{t('message.assistant')}</strong>
                {showAgentBadge && agentDisplayName && (
                  <div className="mb-1.5 flex items-center gap-1.5 text-note font-medium text-fg2">
                    <AgentAvatar icon={agentSummary?.icon} color={agentSummary?.color} size={16} />
                    <span>{agentDisplayName}</span>
                  </div>
                )}
                <TurnActivityGroup
                  steps={steps}
                  view={view}
                  isRunning={isTurnRunning}
                  hasAwaitingApproval={hasAwaitingApproval}
                  awaiting={awaitingApprovalSet}
                  resolvePaths={resolvePaths}
                  onOpenFile={onOpenFile}
                />
                {lastMsg.incomplete && (
                  <em className="mt-1.5 block text-note text-muted not-italic">
                    {t('message.incomplete')}
                  </em>
                )}
                {footer && lastMsg.turnId !== undefined && (
                  <TurnChanges
                    sessionId={view.sessionId}
                    turnId={lastMsg.turnId}
                    {...(onOpenChanges === undefined ? {} : { onOpen: () => onOpenChanges() })}
                    {...(onOpenFile === undefined
                      ? {}
                      : { onOpenFile: (path: string) => onOpenFile(path) })}
                  />
                )}
                {footer && (
                  <TurnActions text={footer.text}>
                    {lastMsg.turnId !== undefined && (
                      <UndoTurnButton view={view} turnId={lastMsg.turnId} />
                    )}
                  </TurnActions>
                )}
                {cards}
                {restoresForMsg && <RestoreMarks view={view} restores={restoresForMsg} />}
              </li>
              {lastOfTurn &&
                lastMsg.turnId !== undefined &&
                (delegationsByTurn.get(lastMsg.turnId) ?? []).map((delegation) => (
                  <li key={delegation.childRunId} className="list-none">
                    <DelegationCard
                      sessionId={view.sessionId}
                      view={view}
                      delegation={delegation}
                      onOpenChanges={onOpenChanges}
                      {...(onOpenRun === undefined ? {} : { onOpenRun })}
                    />
                  </li>
                ))}
            </Fragment>
          )
        })}
        {view?.plans
          .filter((plan) => !anchored.has(plan.planId))
          .map((plan) => (
            <li key={plan.planId} className="list-none">
              <PlanSummaryCard plan={plan} onOpen={openPlan} />
            </li>
          ))}
        {(view?.reviewLoops ?? [])
          .filter((loop) => !anchoredLoops.has(loop.reviewId))
          .map((loop) => (
            <li key={loop.reviewId} className="list-none">
              <ReviewLoopCard loop={loop} />
            </li>
          ))}
        {(view?.pipelineRuns ?? [])
          .filter((pipeline) => !anchoredPipelines.has(pipeline.pipelineId))
          .map((pipeline) => (
            <li key={pipeline.pipelineId} className="list-none">
              <PipelineCard pipeline={pipeline} />
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
        {orphanDelegations.map((delegation) => (
          <li key={delegation.childRunId} className="list-none">
            <DelegationCard
              sessionId={view.sessionId}
              view={view}
              delegation={delegation}
              onOpenChanges={onOpenChanges}
              {...(onOpenRun === undefined ? {} : { onOpenRun })}
            />
          </li>
        ))}
      </ol>
      {runningKey !== undefined && !tailIsLive && <RunningIndicator text={t(runningKey)} />}
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
