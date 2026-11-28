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
 *
 * 执行过程（`groupMessages`）：同一轮里连续的思考与工具调用归成一个活动组，默认折叠，组头说最新一步；
 * 助手写的正文（包括中途的说明）一律在折叠之外，按时间顺序穿插在活动组之间。单步工具调用同样走活动组。
 *
 * 性能：流式增量只改投影的 `live`，其余字段保持引用不变。已完成的消息与归组按 `propsEqualExceptLive`
 * 跳过重渲染（它们及子组件不读取 `live`），进行中的回复按块渲染 Markdown（`Markdown` 的 `streaming`）。
 */
import {
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  CirclePause,
  Copy,
  FileText,
  Lightbulb,
  Pencil,
  RefreshCw,
  Target,
  TriangleAlert,
} from 'lucide-react'
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  rootRun,
  type AssistantMessageView,
  type DelegationView,
  type GoalView,
  type LiveMessageView,
  type MessageView,
  type PlanView,
  type RestoreView,
  type RetryView,
  type ReviewLoopView,
  type PipelineView,
  type SessionView,
  type TeamChangeView,
  type UserMessageView,
} from '@cairn/core'
import { translateError, type I18nInstance, type TFunction } from '@cairn/i18n'
import {
  isAgentDraftRef,
  type ContentPart,
  type ErrorInfo,
  type MentionLines,
  type PromptAgent,
  type PromptSkill,
  type ResolvedMention,
  type ToolCall,
} from '@cairn/protocol'
import { RestoreMarks, restoresByMessage, UndoTurnButton, useCanRestore } from './Checkpoints.js'
import { COMPOSER_COMMANDS } from './composer-commands.js'
import {
  attachmentPreview,
  formatAttachmentSize,
  type DraftAttachment,
} from './composer-attachments.js'
import { extractAgents, parseMention, tokenize } from './composer-tokens.js'
import { FileTypeIcon } from './file-icons.js'
import { TurnChanges } from './FileChanges.js'
import { formatGoalDuration, goalDetailText } from './goal-display.js'
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
  latestActivityHeadline,
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  Shimmer,
} from './ui/index.js'
import { AgentAvatar } from './agents/AgentAvatar.js'
import { agentName, localized } from './agents/model.js'

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

const NO_MESSAGES: readonly MessageView[] = []
const NONE: readonly never[] = []
const NO_FOOTERS: ReadonlyMap<string, TurnFooter> = new Map()
const NO_RESTORES: ReadonlyMap<string, readonly RestoreView[]> = new Map()

/**
 * 两个会话投影除进行中的消息（`live`）外是否相同。流式增量只改 `live`，`reduceSession` 让其余字段保持
 * 引用不变，因此已完成的消息可以据此跳过重渲染。
 */
export function sameViewExceptLive(a: SessionView, b: SessionView): boolean {
  if (a === b) return true
  const keys = Object.keys(b) as (keyof SessionView)[]
  if (Object.keys(a).length !== keys.length) return false
  return keys.every((key) => key === 'live' || a[key] === b[key])
}

/** `memo` 的比较：`view` 按 {@link sameViewExceptLive}，其余属性按引用。组件及其子组件不能读取 `view.live`。 */
export function propsEqualExceptLive<P extends { readonly view: SessionView }>(
  prev: Readonly<P>,
  next: Readonly<P>,
): boolean {
  const keys = Object.keys(next) as (keyof P)[]
  if (Object.keys(prev).length !== keys.length) return false
  return keys.every((key) =>
    key === 'view' ? sameViewExceptLive(prev.view, next.view) : Object.is(prev[key], next[key]),
  )
}

/** 父组件每次渲染都传入新的回调时，换成引用稳定的包装（调用最新的回调），不打断子组件的 memo。 */
function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  const defined = fn !== undefined
  return useMemo(() => (defined ? (...args: A) => ref.current!(...args) : undefined), [defined])
}

/** 按轮次分组（保持原顺序）；没有轮次的条目不收。 */
function byTurn<T extends { readonly turnId?: string | undefined }>(
  items: readonly T[] | undefined,
): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>()
  for (const item of items ?? []) {
    if (item.turnId === undefined) continue
    const list = map.get(item.turnId)
    if (list) list.push(item)
    else map.set(item.turnId, [item])
  }
  return map
}

/** 挂在一轮最后一条消息后面的卡片（计划、审查循环、流水线）；其余位置为空。 */
function turnItems<T>(
  map: ReadonlyMap<string, readonly T[]>,
  lastOfTurn: boolean,
  turnId: string | undefined,
): readonly T[] {
  return lastOfTurn && turnId !== undefined ? (map.get(turnId) ?? NONE) : NONE
}

/** 本次会话挂载时不播动画；之后新出现的消息才淡入。 */
function useEnteringIds(ids: readonly string[]): ReadonlySet<string> {
  const initial = useRef<ReadonlySet<string> | null>(null)
  if (initial.current === null) initial.current = new Set(ids)
  return new Set(ids.filter((id) => !initial.current!.has(id)))
}

/**
 * 思考过程：收起时显示可换行的摘要（最多两行），点开看全文。
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
  const summary = text.replace(/\s+/g, ' ').trim()
  // 展开后触发器只保留标签，避免短思考在摘要行与正文里各出现一次。
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-full">
      <CollapsibleTrigger
        aria-label={t('message.reasoning')}
        className={cn(
          'group/reasoning -mx-[7px] grid min-h-[26px] w-full cursor-pointer items-start gap-x-[7px] rounded-[7px] px-[7px] py-1 text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent',
          open ? 'grid-cols-[18px_auto_14px]' : 'grid-cols-[18px_auto_minmax(0,1fr)_14px]',
        )}
      >
        <span className="flex h-[18px] w-[18px] items-center">
          <Lightbulb aria-hidden className="size-[13px] shrink-0 text-muted opacity-70" />
        </span>
        <span className="flex h-[18px] shrink-0 items-center text-[11px] font-medium tracking-[.04em] text-muted">
          {t('message.reasoningShort')}
        </span>
        {!open && (
          <span className="min-w-0 line-clamp-2 text-[12.5px] leading-[18px] break-words whitespace-normal text-faint">
            {summary === '' ? (
              live ? (
                <Shimmer>{t('message.reasoning')}</Shimmer>
              ) : (
                t('message.reasoning')
              )
            ) : (
              summary
            )}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-faint opacity-40 transition-transform duration-150 group-hover/reasoning:opacity-70',
            open && 'rotate-90 opacity-70',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount aria-hidden={!open} className={cn(!open && 'hidden')}>
        <div className="mt-1 mb-1.5 ml-[25px] rounded-[8px] border border-hair bg-sunk px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg2">
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
    ) : part.type === 'image' ? (
      <p key={index}>{t('message.image')}</p>
    ) : (
      <p key={index}>{part.name}</p>
    ),
  )
})

/** 活动组里的一步：一条助手消息的思考与工具调用（正文在组外）。 */
export interface TurnActivityStep {
  readonly key: string
  readonly reasoning?: string | undefined
  readonly toolCalls?: readonly ToolCall[] | undefined
}

interface TurnActivityGroupProps {
  readonly steps: readonly TurnActivityStep[]
  readonly view: SessionView
  readonly isRunning: boolean
  readonly awaiting: ReadonlySet<string>
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
}

/**
 * 活动组：同一轮里连续的思考与工具调用，默认折叠。组头只说最新一步（图标是它的操作图标）并带上总耗时，
 * 不因失败、取消或等待审批改口；状态变化也不自动展开，只有用户点过组头才展开。
 */
const TurnActivityGroup = memo(function TurnActivityGroup({
  steps,
  view,
  isRunning,
  awaiting,
  onOpenFile,
}: TurnActivityGroupProps) {
  const { t } = useTranslation('session')
  const calls = useMemo(() => steps.flatMap((step) => step.toolCalls ?? []), [steps])

  const headline = useMemo<ActivityHeadline>(
    () => latestActivityHeadline({ calls, tools: view.tools, isRunning, t }),
    [calls, view.tools, isRunning, t],
  )

  const [open, setOpen] = useState(false)

  const body = steps.map((step) => (
    <Fragment key={step.key}>
      {step.reasoning && <Reasoning text={step.reasoning} />}
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
  ))

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2 max-w-full">
      <CollapsibleTrigger data-activity-group className={ACTIVITY_TRIGGER_CLASS}>
        <ActivityGroupHeaderContent
          headline={headline}
          open={open}
          shimmer={headline.tone === 'running'}
        />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount aria-hidden={!open} className={cn(!open && 'hidden')}>
        <div className="flex flex-col pt-0.5 pb-1">{body}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}, propsEqualExceptLive)

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

/** 用户消息里的图片（ADR-0052）：按 blob 引用读取内容；读不到时退回文字占位。 */
const MessageImage = memo(function MessageImage({
  part,
}: {
  readonly part: Extract<ContentPart, { type: 'image' }>
}) {
  const { t } = useTranslation('session')
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    let alive = true
    void attachmentPreview(part.blobRef, part.mimeType).then((value) => {
      if (alive) setSrc(value)
    })
    return () => {
      alive = false
    }
  }, [part.blobRef, part.mimeType])
  if (src === undefined) return <span className="text-faint">{t('message.image')}</span>
  return (
    <img
      src={src}
      alt={t('message.image')}
      className="mt-1 max-h-64 max-w-full rounded-[8px] border border-hair"
    />
  )
})

/** 用户消息里的文件附件：显示名称与大小；正文已经作为上下文发给模型。 */
const MessageFile = memo(function MessageFile({
  part,
}: {
  readonly part: Extract<ContentPart, { type: 'file' }>
}) {
  return (
    <span className="mr-1 inline-flex max-w-full items-center gap-1.5 rounded-[6px] border border-hair bg-raise px-2 py-1 align-baseline text-note text-fg2">
      <FileText aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 truncate">{part.name}</span>
      <span className="shrink-0 text-faint">{formatAttachmentSize(part.size)}</span>
    </span>
  )
})

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
      ) : part.type === 'image' ? (
        <MessageImage part={part} />
      ) : (
        <MessageFile part={part} />
      )}
    </p>
  ))
})

const textOf = (parts: readonly ContentPart[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n')

/**
 * 自动续轮消息（ADR-0047）：不显示成用户气泡，也不提供编辑 / 重新生成。
 * 默认只显示“目标继续”和触发它的判定理由；展开后是完整消息（条件与理由），长文本可滚动。
 */
function GoalContinuationRow({
  message,
  view,
}: {
  readonly message: UserMessageView
  readonly view: SessionView
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const goal = message.goalId === undefined ? undefined : view.goals[message.goalId]
  const reason = goal?.evaluations.filter((item) => item.seq < message.seq).at(-1)?.reason
  return (
    <div className="w-full self-stretch rounded-card border-[0.5px] border-hair bg-sunk px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <CairnMark size={16} className="shrink-0 text-accent" />
        <span className="shrink-0 text-note font-medium text-fg2">
          {t('goal.continuation.label')}
        </span>
        <span className="min-w-0 flex-1 truncate text-note text-muted" title={reason}>
          {reason ?? t('goal.continuation.fallback')}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? 'goal.continuation.collapse' : 'goal.continuation.expand')}
          onClick={() => setOpen((value) => !value)}
          className="grid size-6 shrink-0 place-items-center rounded-[5px] text-muted outline-none hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          />
        </button>
      </div>
      {open && (
        <p className="mt-2 max-h-60 overflow-y-auto rounded-item bg-raise px-2.5 py-2 text-note whitespace-pre-wrap break-words text-fg2">
          {textOf(message.content)}
        </p>
      )}
    </div>
  )
}

/** 目标结束卡：挂在结束那一轮的消息后面，只在有 `endedTurnId` 时显示。 */
function GoalEndedCard({
  goal,
  onOpen,
}: {
  readonly goal: GoalView
  readonly onOpen?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const met = goal.endReason === 'met'
  const warn = goal.endReason === 'impossible' || goal.endReason === 'budget'
  const ended = goal.lifecycle.find((item) => item.kind === 'ended')
  const detail = goalDetailText(goal.endDetail, t)
  return (
    <section
      aria-label={t('goal.endedCard.label')}
      data-goal={goal.goalId}
      className={cn(
        'flex flex-col gap-1.5 rounded-card border-[0.5px] px-3.5 py-3',
        met
          ? 'border-ok/40 bg-ok-soft'
          : warn
            ? 'border-warn/40 bg-warn-soft'
            : 'border-hair bg-sunk',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {met ? (
          <CircleCheck aria-hidden className="size-4 shrink-0 text-ok" />
        ) : (
          <Target
            aria-hidden
            className={cn('size-4 shrink-0', warn ? 'text-warn' : 'text-muted')}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-note font-medium text-fg">
          {t(`goal.end.${goal.endReason ?? 'user'}`)}
        </span>
        <span className="shrink-0 text-[11px] text-muted">
          {t('goal.panel.endedSummary', {
            turns: ended?.turns ?? goal.turnIds.length,
            duration: formatGoalDuration(ended?.durationMs ?? goal.activeMs),
          })}
        </span>
      </div>
      <p className="line-clamp-2 text-note text-fg2" title={goal.condition}>
        {goal.condition}
      </p>
      {detail !== undefined && (
        <p className="text-note whitespace-pre-wrap break-words text-muted">{detail}</p>
      )}
      {onOpen !== undefined && (
        <Button size="sm" variant="ghost" className="self-start" onClick={onOpen}>
          {t('goal.endedCard.open')}
        </Button>
      )}
    </section>
  )
}

/**
 * 回退对话的确认框（编辑重发 / 重新生成共用）：说明会丢掉这一轮之后的对话，
 * 并明确工作区文件不会自动撤销（撤销文件仍走轮次操作里的“撤销本轮”）。
 */
function RewindDialog({
  open,
  later,
  onClose,
  onConfirm,
}: {
  readonly open: boolean
  /** 这一轮之后还有几轮会被丢弃；0 表示只重做这一轮。 */
  readonly later: number
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent tone="danger" icon={<TriangleAlert />}>
        <DialogTitle>{t('rewind.title')}</DialogTitle>
        <DialogDescription>
          {later > 0 ? t('rewind.description', { count: later }) : t('rewind.descriptionLast')}
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{tc('action.cancel')}</Button>
          </DialogClose>
          <Button variant="danger" onClick={onConfirm}>
            {t('rewind.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 轮次操作里的“重新生成”：回退这一轮并按原输入重新开始。 */
function RegenerateButton({
  view,
  messageId,
  turnNumber,
  turnCount,
}: {
  readonly view: SessionView
  /** 这一轮最后一条助手消息；主进程据此找到轮次开头。 */
  readonly messageId: string
  readonly turnNumber: number | undefined
  readonly turnCount: number
}) {
  const { t } = useTranslation('session')
  const canRewind = useCanRestore(view)
  const regenerate = useSessionStore((s) => s.regenerate)
  const [confirming, setConfirming] = useState(false)
  const later = turnCount - (turnNumber ?? turnCount)
  const run = () => void regenerate(messageId)
  return (
    <>
      <IconButton
        label={t('message.regenerate')}
        size="icon-sm"
        disabled={!canRewind}
        onClick={() => (later > 0 ? setConfirming(true) : run())}
      >
        <RefreshCw />
      </IconButton>
      <RewindDialog
        open={confirming}
        later={later}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          run()
        }}
      />
    </>
  )
}

/**
 * 用户消息：气泡，以及“编辑并重发”。编辑时气泡换成多行输入框；
 * 有后续轮次时先确认，避免误删之后的对话。
 */
function UserMessage({
  message,
  view,
  canEdit,
  turnNumber,
  turnCount,
  onOpenFile,
}: {
  readonly message: UserMessageView
  readonly view: SessionView
  readonly canEdit: boolean
  readonly turnNumber: number | undefined
  readonly turnCount: number
  readonly onOpenFile?: ((path: string, line?: number) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const canRewind = useCanRestore(view)
  const editMessage = useSessionStore((s) => s.editMessage)
  const agents = useSessionStore((s) => s.agents) ?? []
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const later = turnCount - (turnNumber ?? turnCount)

  const startEditing = () => {
    setDraft(textOf(message.content))
    setEditing(true)
  }
  const cancelEditing = () => {
    setEditing(false)
    setConfirming(false)
  }
  const save = async () => {
    if (draft.trim() === '' || saving) return
    setSaving(true)
    // 编辑后的文本可能改动了 `@` 引用：按当前 Agent 名称重新提取，文件引用交给主进程展开。
    const agentMentions = agents.flatMap((agent) =>
      [agent.name['zh-CN'], agent.name['en-US']]
        .map((name) => name?.trim())
        .filter((name): name is string => name !== undefined && name !== '')
        .map((name) => ({ agentId: agent.agentId, name })),
    )
    // 编辑文字时保留原消息里的附件（ADR-0052）：界面没有单独删除附件的入口，
    // 静默丢掉截图或文件会让模型看不到原来那一轮的内容。
    const attachments: DraftAttachment[] = message.content.flatMap((part): DraftAttachment[] => {
      if (part.type === 'image') {
        return [
          {
            blobRef: part.blobRef,
            kind: 'image' as const,
            name: `image.${part.mimeType.split('/')[1] ?? 'png'}`,
            mimeType: part.mimeType,
            size: 0,
          },
        ]
      }
      return part.type === 'file'
        ? [
            {
              blobRef: part.blobRef,
              kind: 'file' as const,
              name: part.name,
              mimeType: part.mimeType,
              size: part.size,
            },
          ]
        : []
    })
    const sent = await editMessage(message.messageId, draft, {
      agents: extractAgents(draft, agentMentions),
      agentNames: agentMentions.map((item) => item.name),
      attachments,
    })
    setSaving(false)
    if (sent) setEditing(false)
  }
  const requestSave = () => {
    if (later > 0) setConfirming(true)
    else void save()
  }

  return (
    <>
      {editing ? (
        <div className="w-full max-w-[78%] rounded-[10px] bg-sunk2 px-3.5 py-2.5 shadow-1">
          <textarea
            aria-label={t('message.edit')}
            autoFocus
            value={draft}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelEditing()
              } else if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                requestSave()
              }
            }}
            className="block max-h-[45vh] w-full resize-y break-words bg-transparent text-body text-fg caret-fg outline-none placeholder:text-faint"
          />
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={saving} onClick={cancelEditing}>
              {t('message.edit.cancel')}
            </Button>
            <Button size="sm" disabled={saving || draft.trim() === ''} onClick={requestSave}>
              {t('message.edit.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-[78%] rounded-[10px] bg-sunk2 px-3.5 py-2.5 text-fg shadow-1">
          <UserContent
            parts={message.content}
            mentions={message.mentions ?? []}
            skills={message.skills ?? []}
            agents={message.agents ?? []}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
      {canEdit && !editing && (
        <div className="mt-1 flex items-center gap-0.5">
          <IconButton
            label={t('message.edit')}
            size="icon-sm"
            disabled={!canRewind}
            onClick={startEditing}
          >
            <Pencil />
          </IconButton>
        </div>
      )}
      <RewindDialog
        open={confirming}
        later={later}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void save()
        }}
      />
    </>
  )
}

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

function TeamSwitchDivider({ name, version }: { readonly name: string; readonly version: number }) {
  const { t } = useTranslation('session')
  return (
    <div className="flex items-center gap-3 text-note text-faint">
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span className="shrink-0">{t('chat.teamSwitched', { name, version })}</span>
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
  continued,
  restores,
  compacted,
  omitted,
  entering,
  onOpenPlan,
  onOpenChanges,
  resolvePaths,
  onOpenFile,
  canEdit,
  turnNumber,
  turnCount,
  toolsFollow = false,
}: {
  readonly message: MessageView
  readonly view: SessionView
  /**
   * 这条助手消息的工具调用由紧跟着的活动组显示：这里只显示思考与正文，未完成标记与轮次末尾的内容
   * （本轮变更、轮次操作、卡片）也交给活动组，免得出现在工具步骤前面。
   */
  readonly toolsFollow?: boolean
  /** 这条用户消息是所在轮次的第一条（可以编辑重发）。 */
  readonly canEdit: boolean
  /** 这条消息所在轮次的序号（从 1 开始）。 */
  readonly turnNumber: number | undefined
  readonly turnCount: number
  readonly footer: TurnFooter | undefined
  readonly plans: readonly PlanView[]
  /** 这一轮的审查循环（M7-07）：挂在最后一轮消息后面。 */
  readonly reviewLoops: readonly ReviewLoopView[]
  /** 这一轮的流水线（M7-08）。 */
  readonly pipelines: readonly PipelineView[]
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
  const agents = useSessionStore((s) => s.agents) ?? []
  const { i18n } = useTranslation('session')
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
        {message.origin === 'goal' ? (
          <GoalContinuationRow message={message} view={view} />
        ) : (
          <UserMessage
            message={message}
            view={view}
            canEdit={canEdit}
            turnNumber={turnNumber}
            turnCount={turnCount}
            onOpenFile={onOpenFile}
          />
        )}
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
      {message.incomplete && !toolsFollow && (
        // 用 div：消息正文提取只看 `<p>`，避免把未完成提示当成回复段落。
        <div className="mt-2 flex items-center gap-2 rounded-item bg-sunk px-2.5 py-1.5 text-note text-muted">
          <CirclePause aria-hidden className="size-3.5 shrink-0" />
          <span>{t('message.incomplete')}</span>
        </div>
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
          {message.turnId !== undefined && (
            <>
              <RegenerateButton
                view={view}
                messageId={message.messageId}
                turnNumber={turnNumber}
                turnCount={turnCount}
              />
              <UndoTurnButton view={view} turnId={message.turnId} />
            </>
          )}
        </TurnActions>
      )}
      {cards}
      {restores && <RestoreMarks view={view} restores={restores} />}
    </li>
  )
}

/** 已完成的消息：流式增量（只改 `view.live`）不触发重渲染。 */
const MemoMessage = memo(Message, propsEqualExceptLive)

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
            streaming
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

/**
 * 等待重试时的剩余秒数。`model.retry` 只给出这一次的等待时长，界面上要自己按秒倒数；
 * 计时放在这一行里，避免整段对话每秒重渲染一次。
 */
function RetryNotice({
  retry,
  t,
  i18n,
}: {
  readonly retry: RetryView
  readonly t: TFunction
  readonly i18n: I18nInstance
}): ReactNode {
  const deadline = retry.at + retry.delayMs
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (deadline <= Date.now()) return undefined
    const timer = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= deadline) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [deadline])
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000))
  return t('turn.retrying', {
    reason: translateError(i18n, retry.error),
    seconds,
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
  })
}

/** 宿主因缺少/无法读取 Key 启动失败时，用具体凭据错误文案，避免只显示笼统的崩溃提示。 */
function crashMessage(crash: ErrorInfo, t: TFunction, i18n: I18nInstance): string {
  const cause = crash.params?.['cause']
  if (
    cause === 'credentials.missing' ||
    cause === 'credentials.decrypt_failed' ||
    cause === 'credentials.unavailable'
  ) {
    return t('turn.failed', { reason: translateError(i18n, { code: cause }) })
  }
  return t('crashed.message')
}

/** 上一轮没有正常完成、或正在等待重试时的说明；正常完成或仍在进行时为 undefined。 */
function turnOutcome(view: SessionView, t: TFunction, i18n: I18nInstance): ReactNode {
  if (view.crash) return crashMessage(view.crash, t, i18n)
  const turn = rootRun(view)?.turn
  if (turn?.status === 'aborted') {
    if (turn.abortReason === 'shutdown') return t('turn.interrupted')
    // 助手消息上已有「未完成」条时，不再在流末尾再挂一条「已停止」。
    const hasIncomplete = view.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === turn.turnId &&
        message.incomplete === true,
    )
    if (hasIncomplete) return undefined
    return t('turn.aborted')
  }
  if (turn?.status === 'running' && turn.retry) {
    return <RetryNotice retry={turn.retry} t={t} i18n={i18n} />
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

export type RenderItem =
  | {
      readonly kind: 'message'
      readonly message: MessageView
      readonly index: number
      /** 这条助手消息的工具调用在紧跟着的活动组里（本条只显示思考与正文）。 */
      readonly toolsFollow?: boolean
    }
  | {
      readonly kind: 'activity_group'
      /** React key：第一步所在的消息，后面追加步骤时不变（展开状态得以保留）。 */
      readonly key: string
      readonly turnId: string | undefined
      readonly messages: readonly AssistantMessageView[]
      readonly indices: readonly number[]
      readonly steps: readonly TurnActivityStep[]
      /** 第一步来自上一条已经显示了正文的消息：标记、Agent 名与切换分隔线已经随正文显示过。 */
      readonly afterProse: boolean
    }

interface OpenGroup {
  readonly key: string
  readonly turnId: string | undefined
  readonly runId: string
  readonly messages: AssistantMessageView[]
  readonly indices: number[]
  readonly steps: TurnActivityStep[]
  readonly afterProse: boolean
}

/**
 * 消息流的条目，单遍扫描、只看已经出现的消息：
 * - 用户消息、带正文的助手消息各自一条：正文（包括中途的说明）一律在折叠之外；
 * - 同一轮、同一个运行里连续的思考与工具调用归成一个活动组，被正文、用户消息、轮次或运行切开；
 * - 带正文又调用了工具的助手消息：正文单独一条，它的工具调用开启紧跟着的活动组；
 * - 只有思考、没有工具调用的一段不归组，照常显示（思考本身就是一行可展开的淡字）。
 * 新消息只会追加条目或延长最后一个组，已有的条目不变，因此流式过程中不会跳动。
 */
export function groupMessages(messages: readonly MessageView[]): RenderItem[] {
  const items: RenderItem[] = []
  let group: OpenGroup | undefined
  const close = () => {
    const current = group
    group = undefined
    if (current === undefined) return
    if (current.steps.some((step) => (step.toolCalls?.length ?? 0) > 0)) {
      items.push({
        kind: 'activity_group',
        key: current.key,
        turnId: current.turnId,
        messages: current.messages,
        indices: current.indices,
        steps: current.steps,
        afterProse: current.afterProse,
      })
      return
    }
    current.messages.forEach((message, k) =>
      items.push({ kind: 'message', message, index: current.indices[k]! }),
    )
  }

  messages.forEach((message, index) => {
    if (message.role !== 'assistant') {
      close()
      items.push({ kind: 'message', message, index })
      return
    }
    const joinable =
      group !== undefined &&
      message.turnId !== undefined &&
      group.turnId === message.turnId &&
      group.runId === message.runId
    if (!joinable) close()
    const hasTools = message.toolCalls.length > 0
    if (message.content.length > 0) {
      close()
      items.push({ kind: 'message', message, index, ...(hasTools ? { toolsFollow: true } : {}) })
      if (hasTools) {
        group = {
          key: `${message.messageId}:tools`,
          turnId: message.turnId,
          runId: message.runId,
          messages: [message],
          indices: [index],
          steps: [{ key: message.messageId, toolCalls: message.toolCalls }],
          afterProse: true,
        }
      }
      return
    }
    const reasoning = message.reasoning?.text ?? ''
    if (!hasTools && reasoning === '') {
      // 没有正文、思考与工具调用（例如被打断的空回复）：照常一条，显示未完成标记
      close()
      items.push({ kind: 'message', message, index })
      return
    }
    const step: TurnActivityStep = {
      key: message.messageId,
      ...(reasoning === '' ? {} : { reasoning }),
      ...(hasTools ? { toolCalls: message.toolCalls } : {}),
    }
    if (group === undefined) {
      group = {
        key: message.messageId,
        turnId: message.turnId,
        runId: message.runId,
        messages: [message],
        indices: [index],
        steps: [step],
        afterProse: false,
      }
    } else {
      group.messages.push(message)
      group.indices.push(index)
      group.steps.push(step)
    }
  })
  close()
  return items
}

/** 活动组里还有没跑完的工具：已请求（含等待审批）、执行中，或者运行还在这一轮且工具事件尚未到达。 */
function groupHasActiveTools(
  view: SessionView,
  item: {
    readonly steps: readonly TurnActivityStep[]
    readonly messages: readonly AssistantMessageView[]
  },
): boolean {
  return item.messages.some((message, k) =>
    (item.steps[k]?.toolCalls ?? []).some((call) => {
      const status = view.tools[call.id]?.status
      return (
        status === 'requested' ||
        status === 'running' ||
        (status === undefined && view.runs[message.runId]?.turn?.status === 'running')
      )
    }),
  )
}

export function MessageStream({
  view,
  onOpenPlan,
  onOpenChanges,
  sessionId,
  onContinue,
  onOpenFile,
  onOpenRun,
  onOpenGoal,
}: {
  readonly view: SessionView | undefined
  readonly onOpenPlan?: ((planId: string) => void) | undefined
  readonly onOpenChanges?: ((changeSetId?: string) => void) | undefined
  /** 点击目标结束卡的“查看目标”：在右侧工作台打开目标面板。 */
  readonly onOpenGoal?: (() => void) | undefined
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
  const openPlan = useStableCallback(onOpenPlan) ?? noopPlan
  const openChanges = useStableCallback(onOpenChanges)
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
  const viewMessages = view?.messages
  const viewRuns = view?.runs
  const viewRunOrder = view?.runOrder
  // 流式增量不改消息与运行：按它们缓存，下面依赖 `messages` 的 useMemo 才能命中
  const messages = useMemo<readonly MessageView[]>(
    () =>
      viewMessages?.filter((message) => {
        const run = viewRuns?.[message.runId]
        return run === undefined || run.parentRunId === undefined
      }) ?? NO_MESSAGES,
    [viewMessages, viewRuns],
  )
  const groupedItems = useMemo(() => groupMessages(messages), [messages])
  /** 轮次序号（编辑 / 重新生成时判断后面还有几轮）；只数顶层运行的消息，子 Agent 的轮次不算。 */
  const turns = useMemo(() => {
    const numbers = new Map<string, number>()
    for (const message of messages) {
      if (message.turnId !== undefined && !numbers.has(message.turnId)) {
        numbers.set(message.turnId, numbers.size + 1)
      }
    }
    return numbers
  }, [messages])
  /** 每轮的第一条用户消息：只有它能作为编辑重发的起点。 */
  const turnStarts = useMemo(() => {
    const seen = new Set<string>()
    const starts = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'user' || message.turnId === undefined) continue
      if (seen.has(message.turnId)) continue
      seen.add(message.turnId)
      starts.add(message.messageId)
    }
    return starts
  }, [messages])
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
  const hasLive = view !== undefined && Object.keys(view.live).length > 0
  // turnFooters 只读消息、运行与“有没有进行中的消息”
  const footers = useMemo(
    () => (view ? turnFooters(view) : NO_FOOTERS),
    [viewMessages, viewRuns, viewRunOrder, hasLive],
  )
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
  }, [viewRunOrder, viewRuns, viewMessages, agents, i18n.language, t])
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
  /**
   * 团队切换的分隔提示：只取每条消息之前最后一条团队变化；最后一条是“离开团队”时不显示，
   * 交给随后换 Agent 的运行分隔。第一条消息之前的变化属于开场配置，不算切换。
   */
  const teamDividers = useMemo(() => {
    const byMessage = new Map<string, TeamChangeView>()
    const changes = view?.teamChanges
    const first = messages[0]
    if (changes === undefined || changes.length === 0 || first === undefined) {
      return { byMessage, live: undefined as TeamChangeView | undefined }
    }
    let cursor = 0
    while (cursor < changes.length && changes[cursor]!.seq <= first.seq) cursor += 1
    for (let index = 1; index < messages.length; index++) {
      const from = messages[index - 1]!.seq
      const to = messages[index]!.seq
      let latest: TeamChangeView | undefined
      while (cursor < changes.length && changes[cursor]!.seq <= to) {
        const change = changes[cursor]!
        if (change.seq > from) latest = change
        cursor += 1
      }
      if (latest?.team !== undefined) byMessage.set(messages[index]!.messageId, latest)
    }
    let latest: TeamChangeView | undefined
    while (cursor < changes.length) {
      latest = changes[cursor]
      cursor += 1
    }
    const lastSeq = messages.at(-1)!.seq
    const liveChange =
      latest !== undefined && latest.seq > lastSeq && latest.team !== undefined ? latest : undefined
    return { byMessage, live: liveChange }
  }, [view?.teamChanges, messages])
  const liveTeamChange = teamDividers.live
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
  const viewRestores = view?.restores
  // restoresByMessage 只读恢复记录与消息
  const restores = useMemo(
    () => (view ? restoresByMessage(view) : NO_RESTORES),
    [viewRestores, viewMessages],
  )
  const viewPlans = view?.plans
  const viewLoops = view?.reviewLoops
  const viewPipelines = view?.pipelineRuns
  const plansByTurn = useMemo(() => byTurn(viewPlans), [viewPlans])
  const loopsByTurn = useMemo(() => byTurn(viewLoops), [viewLoops])
  const pipelinesByTurn = useMemo(() => byTurn(viewPipelines), [viewPipelines])
  const delegationsByTurn = useMemo(() => {
    const map = new Map<string, DelegationView[]>()
    for (const delegation of view?.delegations ?? []) {
      if (delegation.turnId === undefined) continue
      const list = map.get(delegation.turnId) ?? []
      list.push(delegation)
      map.set(delegation.turnId, list)
    }
    return map
  }, [view?.delegations])
  /** 结束了、且有可挂靠轮次的目标：在该轮消息后插入结果卡。 */
  const endedGoalsByTurn = useMemo(() => {
    const map = new Map<string, GoalView[]>()
    for (const goalId of view?.goalOrder ?? []) {
      const goal = view?.goals[goalId]
      if (goal?.status !== 'ended' || goal.endedTurnId === undefined) continue
      const list = map.get(goal.endedTurnId) ?? []
      list.push(goal)
      map.set(goal.endedTurnId, list)
    }
    return map
  }, [view?.goalOrder, view?.goals])
  // 已经挂在某一轮“最后一条消息”后面的委派；其余（尚无轮次、或本轮还在继续写、只有 live）
  // 排在流末尾，避免子 Agent 跑完后卡片从对话里消失、只剩工具行。
  const anchoredDelegationIds = useMemo(() => {
    const ids = new Set<string>()
    messages.forEach((message, index) => {
      const next = messages[index + 1]
      const lastOfTurn = next === undefined || next.turnId !== message.turnId
      if (!lastOfTurn || message.turnId === undefined) return
      for (const delegation of delegationsByTurn.get(message.turnId) ?? []) {
        ids.add(delegation.childRunId)
      }
    })
    return ids
  }, [messages, delegationsByTurn])
  const orphanDelegations = (view?.delegations ?? []).filter(
    (item) => !anchoredDelegationIds.has(item.childRunId),
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
  // 只有末尾是活动组（它有组头）时，才由它承担状态；工具调用一律在活动组里。
  const tailIsLive =
    runningKey !== undefined && tail?.kind === 'activity_group' && tail.turnId === rootTurnId

  return (
    <>
      {messages.length === 0 && live.length === 0 && runningKey === undefined && <EmptyStream />}
      <ol aria-label={t('chat.messages')} className="flex flex-col gap-7">
        {groupedItems.map((item) => {
          if (item.kind === 'message') {
            const message = item.message
            const previous = messages[item.index - 1]?.seq ?? 0
            const next = messages[item.index + 1]
            // 工具调用在后面的活动组里时，轮次末尾的内容由活动组显示
            const toolsFollow = item.toolsFollow === true
            const lastOfTurn =
              !toolsFollow && (next === undefined || next.turnId !== message.turnId)
            const teamChange = teamDividers.byMessage.get(message.messageId)
            const switchInfo =
              teamChange === undefined ? switchedRuns.get(message.messageId) : undefined
            return (
              <Fragment key={message.messageId}>
                {teamChange?.team !== undefined && (
                  <li className="list-none">
                    <TeamSwitchDivider
                      name={localized(teamChange.team.name, i18n.language, teamChange.team.teamId)}
                      version={teamChange.team.version}
                    />
                  </li>
                )}
                {switchInfo && (
                  <li className="list-none">
                    <AgentSwitchDivider name={switchInfo.name} version={switchInfo.version} />
                  </li>
                )}
                <MemoMessage
                  message={message}
                  view={view}
                  footer={toolsFollow ? undefined : footers.get(message.messageId)}
                  plans={turnItems(plansByTurn, lastOfTurn, message.turnId)}
                  reviewLoops={turnItems(loopsByTurn, lastOfTurn, message.turnId)}
                  pipelines={turnItems(pipelinesByTurn, lastOfTurn, message.turnId)}
                  continued={continues(messages[item.index - 1], message)}
                  restores={toolsFollow ? undefined : restores.get(message.messageId)}
                  compacted={markBetween(previous, message.seq, view.compaction)}
                  omitted={markBetween(previous, message.seq, view.toolOutputOmitted)}
                  entering={enteringIds.has(message.messageId)}
                  onOpenPlan={openPlan}
                  onOpenChanges={openChanges}
                  resolvePaths={resolvePaths}
                  onOpenFile={onOpenFile}
                  canEdit={message.role === 'user' && turnStarts.has(message.messageId)}
                  turnNumber={message.turnId === undefined ? undefined : turns.get(message.turnId)}
                  turnCount={turns.size}
                  toolsFollow={toolsFollow}
                />
                {lastOfTurn &&
                  message.turnId !== undefined &&
                  (delegationsByTurn.get(message.turnId) ?? []).map((delegation) => (
                    <li key={delegation.childRunId} className="list-none">
                      <DelegationCard
                        sessionId={view.sessionId}
                        view={view}
                        delegation={delegation}
                        onOpenChanges={openChanges}
                        {...(onOpenRun === undefined ? {} : { onOpenRun })}
                      />
                    </li>
                  ))}
                {lastOfTurn &&
                  message.turnId !== undefined &&
                  (endedGoalsByTurn.get(message.turnId) ?? []).map((goal) => (
                    <li key={`goal-${goal.goalId}`} className="list-none">
                      <GoalEndedCard goal={goal} onOpen={onOpenGoal} />
                    </li>
                  ))}
              </Fragment>
            )
          }

          // activity_group: 同一轮中连续的思考与工具调用
          const group = item.messages
          const firstMsg = group[0]!
          const lastMsg = group[group.length - 1]!
          const firstIndex = item.indices[0]!
          const lastIndex = item.indices[item.indices.length - 1]!
          const previous = messages[firstIndex - 1]?.seq ?? 0
          const nextMsg = messages[lastIndex + 1]
          const lastOfTurn = nextMsg === undefined || nextMsg.turnId !== item.turnId
          // 接在同一条消息的正文后面：切换分隔线、标记与 Agent 名已经随正文显示过
          const teamChange = teamDividers.byMessage.get(firstMsg.messageId)
          const switchInfo =
            item.afterProse || teamChange !== undefined
              ? undefined
              : switchedRuns.get(firstMsg.messageId)
          const continued = item.afterProse || continues(messages[firstIndex - 1], firstMsg)
          const entering = group.some((m) => enteringIds.has(m.messageId))

          // 有工具没跑完，或者它是正在进行的这一轮的末尾（工具都跑完了、模型还在想）
          const isRunning = groupHasActiveTools(view, item) || (item === tail && tailIsLive)
          const compacted = !item.afterProse && markBetween(previous, firstMsg.seq, view.compaction)
          const omitted =
            !item.afterProse && markBetween(previous, firstMsg.seq, view.toolOutputOmitted)
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

          const plans = turnItems(plansByTurn, lastOfTurn, lastMsg.turnId)
          const loops = turnItems(loopsByTurn, lastOfTurn, lastMsg.turnId)
          const pipelines = turnItems(pipelinesByTurn, lastOfTurn, lastMsg.turnId)
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
            <Fragment key={item.key}>
              {teamChange?.team !== undefined && !item.afterProse && (
                <li className="list-none">
                  <TeamSwitchDivider
                    name={localized(teamChange.team.name, i18n.language, teamChange.team.teamId)}
                    version={teamChange.team.version}
                  />
                </li>
              )}
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
                  steps={item.steps}
                  view={view}
                  isRunning={isRunning}
                  awaiting={awaitingApprovalSet}
                  onOpenFile={onOpenFile}
                />
                {lastMsg.incomplete && (
                  <div className="mt-2 flex items-center gap-2 rounded-item bg-sunk px-2.5 py-1.5 text-note text-muted">
                    <CirclePause aria-hidden className="size-3.5 shrink-0" />
                    <span>{t('message.incomplete')}</span>
                  </div>
                )}
                {footer && lastMsg.turnId !== undefined && (
                  <TurnChanges
                    sessionId={view.sessionId}
                    turnId={lastMsg.turnId}
                    {...(openChanges === undefined ? {} : { onOpen: () => openChanges() })}
                    {...(onOpenFile === undefined
                      ? {}
                      : { onOpenFile: (path: string) => onOpenFile(path) })}
                  />
                )}
                {footer && (
                  <TurnActions text={footer.text}>
                    {lastMsg.turnId !== undefined && (
                      <>
                        <RegenerateButton
                          view={view}
                          messageId={lastMsg.messageId}
                          turnNumber={turns.get(lastMsg.turnId)}
                          turnCount={turns.size}
                        />
                        <UndoTurnButton view={view} turnId={lastMsg.turnId} />
                      </>
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
                      onOpenChanges={openChanges}
                      {...(onOpenRun === undefined ? {} : { onOpenRun })}
                    />
                  </li>
                ))}
              {lastOfTurn &&
                lastMsg.turnId !== undefined &&
                (endedGoalsByTurn.get(lastMsg.turnId) ?? []).map((goal) => (
                  <li key={`goal-${goal.goalId}`} className="list-none">
                    <GoalEndedCard goal={goal} onOpen={onOpenGoal} />
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
        {liveTeamChange?.team !== undefined && (
          <li className="list-none">
            <TeamSwitchDivider
              name={localized(liveTeamChange.team.name, i18n.language, liveTeamChange.team.teamId)}
              version={liveTeamChange.team.version}
            />
          </li>
        )}
        {liveTeamChange === undefined && liveSwitch && (
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
              onOpenChanges={openChanges}
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
