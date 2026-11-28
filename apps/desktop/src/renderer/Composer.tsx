/**
 * 输入框（M2-04，视觉规范 §6）：悬浮在纸面底部的卡片。
 *
 * - 文本框自动增高（最多约 8 行）。Enter 发送，Shift+Enter 换行；输入法组字时的 Enter 不发送。
 *   运行中不能发送（主进程会报 `run.busy`），发送按钮换成停止按钮。发送时立即清空，失败时恢复。
 * - 草稿以 `/` 开头时弹出指令面板（注册表在 composer-commands.ts）。↑↓ 选择，Enter 执行，
 *   Tab 补全，Esc 关闭；没有匹配时按普通消息发送。写了空白之后面板收起，`/名称 参数` 在发送时执行，
 *   例如 `/plan 任务描述` 以计划模式发送、`/model 名称` 直接切换模型、`/settings mcp` 打开对应分区。
 *   运行中不能执行的指令在面板里置灰并说明原因。
 * - 输入 `@` 弹出文件与文件夹候选（ComposerMentions，ADR-0037），发送时主进程把引用的内容附给模型。
 * - 文本框下面叠一层高亮（ComposerHighlight）：开头的指令、`@` 引用、网址和代码片段有底色或下划线；
 *   文本框自己的文字透明，只显示光标和选区。
 * - 下方左边是 Agent（当前会话使用哪一个，M6-08）、权限 / 计划模式合并菜单（上半部分选择只读 /
 *   询问 / 自动 / 完全访问，下半部分切换计划模式）与 Git 分支切换（非 Git 仓库时不出现；项目在
 *   顶栏面包屑里，不在这里重复），右边是模型切换（触发按钮只显示模型名，只改当前会话，下一轮生效）、上下文
 *   占用圆环（点击显示最近用量与分类占比）与发送 / 停止按钮。卡片下面不再单独占一行。
 */
import {
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  ListChecks,
  RotateCw,
  ShieldCheck,
  ShieldOff,
  Square,
  Zap,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from 'react'
import { useTranslation } from 'react-i18next'
import { openGoal, type RunView, type SessionView } from '@cairn/core'
import { translateError } from '@cairn/i18n'
import { GOAL_CONDITION_MAX } from '@cairn/protocol'
import type {
  AgentDefinitionRef,
  ModelRef,
  PermissionMode,
  SessionStatus,
  SkillSummary,
} from '@cairn/protocol'
import {
  goalErrorNoticeKey,
  matchCommandArg,
  parseComposerCommand,
  parseGoalCommand,
  SETTINGS_SECTIONS,
} from './composer-commands.js'
import { COMMAND_LIST_ID, commandOptionId, ComposerCommandList } from './ComposerCommandList.js'
import { ComposerAttachments } from './ComposerAttachments.js'
import {
  droppedAttachmentFiles,
  MAX_PROMPT_ATTACHMENTS,
  pastedAttachmentFiles,
  saveAttachment,
  type PendingAttachment,
} from './composer-attachments.js'
import { readComposerDraft, sessionDraftKey, writeComposerDraft } from './composer-drafts.js'
import {
  availableCommands,
  commandPanel,
  type AvailableComposerCommand,
} from './composer-shared.js'
import { CommandHelpDialog } from './CommandHelp.js'
import { extractAgents, mentionText } from './composer-tokens.js'
import { AgentPicker, availableAgents } from './agents/AgentPicker.js'
import { agentName, localized } from './agents/model.js'
import { contextBreakdown, latestSnapshot } from './context-breakdown.js'
import { formatCompactTokens } from './format.js'
import {
  FILE_DRAG_TYPE,
  draggedFile,
  externalDroppedFiles,
  pastedFilePaths,
  relativeMentionPath,
  type ExternalFile,
} from './file-drag.js'
import { onIdle } from './idle.js'
import {
  RestoreDialog,
  turnCheckpoints,
  turnNumbers,
  useCanRestore,
  type RestoreTarget,
} from './Checkpoints.js'
import { ComposerHighlight } from './ComposerHighlight.js'
import { MENTION_LIST_ID, useMentionMenu, type MentionAgent } from './ComposerMentions.js'
import { COMPOSER_FOCUS_EVENT, isPlanModeKey, planShortcut } from './layout/shortcuts.js'
import { ModelPicker } from './ModelPicker.js'
import { enabledModelChoices, modelLabels } from './model-labels.js'
import { rememberRecentModel } from './recent-models.js'
import { inspectionKey } from './session-store.js'
import type { SessionPanel } from './SessionPanels.js'
import type { SettingsSection } from './settings/SettingsPage.js'
import { useSessionStore } from './store-context.js'
import { WorkspaceGitBar } from './WorkspaceGitBar.js'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Tooltip,
} from './ui/index.js'

export { ModelPicker } from './ModelPicker.js'

export interface ComposerProps {
  readonly sessionId: string
  readonly status: SessionStatus
  readonly run: RunView | undefined
  /** 当前运行的 Agent（M3-12）；没有运行时为 undefined。 */
  readonly agent?: AgentDefinitionRef | undefined
  /** 会话的模型（下一轮使用）；没有记录时用默认模型。 */
  readonly model: ModelRef | undefined
  /** 会话的项目目录；输入框下方显示当前目录与分支。 */
  readonly projectPath: string | undefined
  /** 上下文占用的 token 数（最近一次用量）。 */
  readonly contextTokens: number | undefined
  /** `/files`、`/diff` 等打开右侧面板；没有时这些指令不出现。 */
  readonly onOpenPanel?: ((panel: SessionPanel) => void) | undefined
  /** `/new`；没有时指令不出现。 */
  readonly onNewChat?: (() => void) | undefined
  /** `/settings [分区]`；没有时指令不出现。 */
  readonly onOpenSettings?: ((section: SettingsSection) => void) | undefined
  /** `/search`；没有时指令不出现。 */
  readonly onOpenSearch?: (() => void) | undefined
}

type CommandNotice = {
  readonly id: number
  readonly key: string
  readonly tone: 'ok' | 'muted'
  readonly command?: string
  readonly params?: Readonly<Record<string, string>>
}

/** 指令面板里的一项：内置指令或一个已启用的技能。 */
type AvailableCommand = AvailableComposerCommand

/** 文本框最高（px），超过后滚动。 */
const MAX_TEXTAREA_HEIGHT = 200

const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask'
const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'ask', 'auto', 'full-access']
const PERMISSION_ICONS = {
  'read-only': Eye,
  ask: ShieldCheck,
  auto: Zap,
  'full-access': ShieldOff,
} as const

/**
 * 权限与计划模式的合并菜单：三个控件收成两个。
 * 触发按钮显示当前权限模式；计划模式开启时在末尾加“· 计划”，并让读屏读出计划模式已开启。
 * 菜单上半部分选择权限模式（全局设置），下半部分切换计划模式；`/plan` 与快捷键仍然可用。
 */
export function ModeMenu({
  planMode,
  onTogglePlan,
  open,
  onOpenChange,
  returnFocus,
}: {
  readonly planMode: boolean
  readonly onTogglePlan: () => void
  /** 由 `/permissions` 打开；省略时菜单自己管理开关。 */
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** 关闭时把焦点还给这里（通常是输入框）；省略时交给 Radix 还到触发按钮。 */
  readonly returnFocus?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const mode = useSessionStore((s) => s.settings?.permissionMode) ?? DEFAULT_PERMISSION_MODE
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const Icon = PERMISSION_ICONS[mode]
  const modeLabel = t(`composer.permission.${mode}`)
  const interactedOutside = useRef(false)
  const currentItem = useRef<HTMLDivElement>(null)
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  // 打开时聚焦当前权限模式：直接按 Enter 不会换成列表第一项。
  useEffect(() => {
    if (!isOpen) return
    const timer = window.setTimeout(() => {
      const node = currentItem.current
      if (node === null) return
      node.focus({ preventScroll: true })
      if (typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'nearest' })
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isOpen])
  return (
    <DropdownMenu
      open={isOpen}
      onOpenChange={(next) => {
        if (next) interactedOutside.current = false
        setInternalOpen(next)
        onOpenChange?.(next)
      }}
    >
      <DropdownMenuTrigger
        aria-label={
          planMode
            ? t('composer.mode.labelWithPlan', { mode: modeLabel })
            : t('composer.permission.label', { mode: modeLabel })
        }
        title={t('composer.mode.title')}
        className="flex h-7 items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent [&_svg]:size-3.5"
      >
        <Icon className="text-muted" />
        {modeLabel}
        {planMode && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-accent">{t('composer.mode.plan')}</span>
          </>
        )}
        <ChevronDown className="text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-72"
        onInteractOutside={() => {
          interactedOutside.current = true
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus === undefined || interactedOutside.current) return
          // 选中项或 Esc 关闭时，把焦点交还给调用方而不是触发按钮。
          event.preventDefault()
          returnFocus()
        }}
      >
        <DropdownMenuLabel>{t('composer.permission.title')}</DropdownMenuLabel>
        {PERMISSION_MODES.map((option) => {
          const OptionIcon = PERMISSION_ICONS[option]
          return (
            <DropdownMenuItem
              key={option}
              ref={option === mode ? currentItem : undefined}
              className="h-auto items-start py-1.5"
              onSelect={() => {
                if (option !== mode) void updateSettings({ permissionMode: option })
              }}
            >
              <OptionIcon className="mt-0.5" />
              <span className="flex flex-1 flex-col">
                <span>{t(`composer.permission.${option}`)}</span>
                <span className="text-note text-muted">
                  {t(`composer.permission.${option}.hint`)}
                </span>
              </span>
              {option === mode && <Check className="mt-0.5 text-fg!" />}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-auto items-start py-1.5" onSelect={onTogglePlan}>
          <ListChecks className="mt-0.5" />
          <span className="flex flex-1 flex-col">
            <span>{t('composer.plan.toggle')}</span>
            <span className="text-note text-muted">
              {t('composer.plan.hint', { shortcut: planShortcut() })}
            </span>
          </span>
          {planMode && <Check className="mt-0.5 text-fg!" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 上下文圆环与用量明细：点击后按需读取最近一次模型调用前的分类估算。 */
function ContextUsage({
  sessionId,
  model,
  tokens,
  open,
  onOpenChange,
  returnFocus,
}: {
  readonly sessionId: string
  readonly model: ModelRef | undefined
  readonly tokens: number | undefined
  /** 由 `/context` 指令与圆环按钮共用，状态由输入框管理。 */
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** 关闭时把焦点还给这里（通常是输入框）；省略时交给 Radix 还到触发按钮。 */
  readonly returnFocus?: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const providers = useSessionStore((s) => s.settings?.providers)
  const inspectRun = useSessionStore((s) => s.inspectRun)
  const inspection = useSessionStore((s) => s.inspections[inspectionKey(sessionId)])
  const window = providers
    ?.find((p) => p.id === model?.providerId)
    ?.models.find((m) => m.id === model?.modelId)?.contextWindow
  const used = tokens ?? 0
  const ratio = window === undefined ? 0 : Math.min(1, used / window)
  const percent = Math.round(ratio * 100)
  const r = 6
  const c = 2 * Math.PI * r
  const label =
    window === undefined
      ? t('composer.context.open')
      : t('composer.context', {
          percent,
          used: used.toLocaleString(i18n.language),
          total: window.toLocaleString(i18n.language),
        })
  const snapshot = latestSnapshot(inspection?.result?.snapshots ?? [])
  const breakdown = contextBreakdown(snapshot)
  const notFound = inspection?.error?.code === 'run.not_found'
  const error = inspection?.error === undefined || notFound ? undefined : inspection.error
  const interactedOutside = useRef(false)

  // 无论从圆环还是 `/context` 打开，都在展开时按需读取快照。
  useEffect(() => {
    if (open) void inspectRun(sessionId)
  }, [open, inspectRun, sessionId])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) interactedOutside.current = false
        onOpenChange(next)
      }}
    >
      <Tooltip content={label}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="flex size-7 items-center justify-center rounded-item outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
          >
            <svg viewBox="0 0 16 16" aria-hidden className="size-4 -rotate-90">
              <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-hair2" />
              {window !== undefined && (
                <circle
                  cx="8"
                  cy="8"
                  r={r}
                  fill="none"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={`${c * ratio} ${c}`}
                  className={
                    ratio >= 0.9 ? 'stroke-danger' : ratio >= 0.7 ? 'stroke-warn' : 'stroke-muted'
                  }
                />
              )}
            </svg>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        aria-label={t('composer.context.breakdown')}
        onInteractOutside={() => {
          interactedOutside.current = true
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus === undefined || interactedOutside.current) return
          event.preventDefault()
          returnFocus()
        }}
      >
        <div className="flex flex-col gap-3">
          <PopoverTitle>{t('composer.context.breakdown')}</PopoverTitle>
          <section className="rounded-item bg-sunk px-2.5 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-note text-muted">{t('composer.context.current')}</span>
              <span className="tabular text-ui font-medium text-fg">
                {tokens === undefined
                  ? t('composer.context.noUsage')
                  : window === undefined
                    ? t('composer.context.tokensUnknown', { used: formatCompactTokens(used) })
                    : t('composer.context.tokens', {
                        used: formatCompactTokens(used),
                        total: formatCompactTokens(window),
                      })}
              </span>
            </div>
            {window === undefined && (
              <p className="mt-1 text-note text-faint">{t('composer.context.unknownWindow')}</p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h4 className="text-note font-medium text-fg2">
                {t('composer.context.estimateTitle')}
              </h4>
              <p className="text-note text-faint">{t('composer.context.estimateHint')}</p>
            </div>
            {inspection?.loading && inspection.result === undefined ? (
              <p role="status" className="text-note text-muted">
                {t('composer.context.loading')}
              </p>
            ) : error !== undefined ? (
              <div role="alert" className="flex flex-col items-start gap-2">
                <p className="text-note text-danger">{translateError(i18n, error)}</p>
                <button
                  type="button"
                  onClick={() => void inspectRun(sessionId)}
                  className="flex h-7 items-center gap-1.5 rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
                >
                  <RotateCw aria-hidden className="size-3" />
                  {t('composer.context.retry')}
                </button>
              </div>
            ) : breakdown.total === 0 ? (
              <p className="text-note text-faint">{t('composer.context.empty')}</p>
            ) : (
              <>
                <div
                  role="img"
                  aria-label={t('inspector.context.bar', {
                    total: breakdown.total.toLocaleString(i18n.language),
                  })}
                  className="flex h-2 overflow-hidden rounded-full bg-sunk2"
                >
                  {breakdown.parts.map((part) => (
                    <span
                      key={part.key}
                      className={part.tone}
                      style={{ width: `${(part.tokens / breakdown.total) * 100}%` }}
                    />
                  ))}
                </div>
                <ul aria-label={t('inspector.context.breakdown')} className="flex flex-col gap-1">
                  {breakdown.parts.map((part) => (
                    <li key={part.key} className="flex items-center gap-2 text-note">
                      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', part.tone)} />
                      <span className="min-w-0 flex-1 text-fg2">
                        {t(`inspector.context.${part.key}`)}
                      </span>
                      <span className="tabular text-muted">
                        {formatCompactTokens(part.tokens)} ·{' '}
                        {Math.round((part.tokens / breakdown.total) * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** `/undo` 的目标：最后一轮及其检查点；没有可撤销的轮次时为 undefined。 */
export function lastTurnTarget(view: SessionView | undefined): RestoreTarget | undefined {
  if (view === undefined) return undefined
  const turns = turnNumbers(view)
  let last: { turnId: string; turn: number } | undefined
  for (const [turnId, turn] of turns)
    if (last === undefined || turn > last.turn) last = { turnId, turn }
  if (last === undefined) return undefined
  const checkpoint = turnCheckpoints(view).get(last.turnId)
  return checkpoint === undefined
    ? undefined
    : { checkpointId: checkpoint.checkpointId, turn: last.turn, later: false }
}

export function Composer({
  sessionId,
  status,
  run,
  agent,
  model,
  projectPath,
  contextTokens,
  onOpenPanel,
  onNewChat,
  onOpenSettings,
  onOpenSearch,
}: ComposerProps) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const { t: ts } = useTranslation('settings')
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const setSessionThinkingLevel = useSessionStore((s) => s.setSessionThinkingLevel)
  const compactSession = useSessionStore((s) => s.compactSession)
  const abort = useSessionStore((s) => s.abort)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const renameSession = useSessionStore((s) => s.renameSession)
  const setSessionAgent = useSessionStore((s) => s.setSessionAgent)
  const setGoal = useSessionStore((s) => s.setGoal)
  const pauseGoal = useSessionStore((s) => s.pauseGoal)
  const resumeGoal = useSessionStore((s) => s.resumeGoal)
  const clearGoal = useSessionStore((s) => s.clearGoal)
  const permissionMode =
    useSessionStore((s) => s.settings?.permissionMode) ?? DEFAULT_PERMISSION_MODE
  const agents = useSessionStore((s) => s.agents) ?? []
  const listSkills = useSessionStore((s) => s.listSkills)
  const delegationTargets = useSessionStore((s) => s.delegationTargets)
  const projects = useSessionStore((s) => s.projects)
  const providers = useSessionStore((s) => s.settings?.providers) ?? []
  const [skills, setSkills] = useState<readonly SkillSummary[]>([])
  /** `@Agent` 能点的目标（M4-02）；undefined 表示主进程没给名单，不过滤。 */
  const [delegateIds, setDelegateIds] = useState<readonly string[]>()
  const view = useSessionStore((s) => s.views[sessionId])
  const canRestore = useCanRestore(view)
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget>()
  const fixedAgentModel =
    agent !== undefined && agents.find((item) => item.agentId === agent.id)?.modelMode === 'fixed'
  /** 组件按会话重建（ChatPanel 用 sessionId 作 key），草稿从这里恢复。 */
  const draftKey = sessionDraftKey(sessionId)
  const [savedDraft] = useState(() => readComposerDraft(draftKey))
  const [text, setTextState] = useState(savedDraft.text)
  const [planMode, setPlanModeState] = useState(savedDraft.planMode)
  const [attachments, setAttachmentsState] = useState<readonly PendingAttachment[]>(
    savedDraft.attachments,
  )
  /**
   * 草稿在 setter 里同步写入，而不是等 effect：`/settings` 等指令会立刻切走页面，
   * 组件在 effect 之前就卸载了，晚一步写会把已经清空的输入框又留成旧草稿。
   */
  const draftState = useRef({ text, planMode, attachments })
  const writeDraft = (next: {
    text: string
    planMode: boolean
    attachments: readonly PendingAttachment[]
  }) => {
    draftState.current = next
    // 图片预览是本地 data URL，只留在内存里；草稿只记可以重新读取的引用。
    writeComposerDraft(draftKey, {
      text: next.text,
      planMode: next.planMode,
      attachments: next.attachments.map(({ preview: _preview, ...attachment }) => attachment),
    })
  }
  const setText = (next: SetStateAction<string>) => {
    const value = typeof next === 'function' ? next(draftState.current.text) : next
    writeDraft({ ...draftState.current, text: value })
    setTextState(value)
  }
  const setPlanMode = (next: SetStateAction<boolean>) => {
    const value = typeof next === 'function' ? next(draftState.current.planMode) : next
    writeDraft({ ...draftState.current, planMode: value })
    setPlanModeState(value)
  }
  const setAttachments = (next: SetStateAction<readonly PendingAttachment[]>) => {
    const value = typeof next === 'function' ? next(draftState.current.attachments) : next
    writeDraft({ ...draftState.current, attachments: value })
    setAttachmentsState(value)
  }
  const promptHistory = useRef<string[]>([])
  const historyIndex = useRef<number>(-1)
  const draftBeforeHistory = useRef<string>('')

  const recordHistory = (prompt: string) => {
    const trimmed = prompt.trim()
    if (trimmed === '') return
    const idx = promptHistory.current.indexOf(trimmed)
    if (idx !== -1) promptHistory.current.splice(idx, 1)
    promptHistory.current.unshift(trimmed)
    if (promptHistory.current.length > 50) promptHistory.current.pop()
    historyIndex.current = -1
  }
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null)
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const noticeId = useRef(0)
  const active = status === 'running' || status === 'waiting_approval' || status === 'waiting_input'
  const stopping = run?.state === 'aborting'
  const fixedModel = agent !== undefined && run?.agent.id === agent.id && fixedAgentModel
  const enabledModelCount = providers
    .flatMap((provider) => provider.models)
    .filter((item) => item.enabled !== false).length
  const modelMenuDisabled = fixedModel || enabledModelCount === 0
  const undoTarget = lastTurnTarget(view)
  const projectId = projects?.find((project) => project.path === projectPath)?.projectId
  /** 用户在空闲加载前输入 `/` 时立即补一次技能列表。 */
  const skillsRequestedFor = useRef<string | undefined>(undefined)
  const ensureSkills = () => {
    if (projectId === undefined || skills.length > 0) return
    if (skillsRequestedFor.current === projectId) return
    skillsRequestedFor.current = projectId
    void listSkills(projectId).then((list) => setSkills(list ?? []))
  }
  useEffect(() => {
    if (projectId === undefined) {
      setSkills([])
      return
    }
    let alive = true
    // 打开会话后不急着扫技能：先让消息区渲染，空闲时再读。
    const cancel = onIdle(() => {
      void listSkills(projectId).then((list) => {
        if (alive) setSkills(list ?? [])
      })
    }, 600)
    return () => {
      alive = false
      cancel()
    }
  }, [listSkills, projectId])

  // `@Agent` 只能点名当前 Agent 的委派白名单（M4-02）：主进程展开时按同一份名单过滤。
  useEffect(() => {
    let alive = true
    void delegationTargets(sessionId).then((targets) => {
      if (alive)
        setDelegateIds(targets === undefined ? undefined : targets.enabled ? targets.agentIds : [])
    })
    return () => {
      alive = false
    }
  }, [delegationTargets, sessionId])

  const agentOptions = useMemo<MentionAgent[]>(
    () =>
      agents
        .filter(
          (item) =>
            !item.archived && (delegateIds === undefined || delegateIds.includes(item.agentId)),
        )
        .map((item) => ({
          agentId: item.agentId,
          name: agentName(item, i18n.language),
          description: localized(item.description, i18n.language, ''),
        })),
    [agents, delegateIds, i18n.language],
  )
  /** `@` 后面能写的 Agent 名称（两种语言都认，发送时换成 id）。 */
  const agentMentions = useMemo(() => {
    const byName = new Map<string, { agentId: string; name: string }>()
    for (const item of agents) {
      if (item.archived) continue
      if (delegateIds !== undefined && !delegateIds.includes(item.agentId)) continue
      for (const candidate of [item.name['zh-CN'], item.name['en-US']]) {
        const name = candidate?.trim()
        if (name !== undefined && name !== '') byName.set(name, { agentId: item.agentId, name })
      }
    }
    return [...byName.values()]
  }, [agents, delegateIds])

  const commands: readonly AvailableCommand[] = availableCommands(
    skills,
    t,
    {
      active,
      modelMenuDisabled,
      undoAvailable: canRestore && undoTarget !== undefined,
      ...(onOpenPanel === undefined ? {} : { onOpenPanel }),
      ...(onNewChat === undefined ? {} : { onNewChat }),
      ...(onOpenSettings === undefined ? {} : { onOpenSettings }),
      ...(onOpenSearch === undefined ? {} : { onOpenSearch }),
    },
    true,
  )
  const commandNames = commands.map((command) => command.name)
  const parsedCommand = parseComposerCommand(text, commands)
  const canSend =
    !sending &&
    !stopping &&
    (text.trim() !== '' || attachments.length > 0) &&
    (parsedCommand !== undefined
      ? parsedCommand.command.unavailable === undefined &&
        (parsedCommand.command.kind === 'skill'
          ? // `/技能名` 后面要跟任务描述；运行中不能开新的一轮。
            parsedCommand.args !== '' && !active
          : // `/plan 任务` 会发出一轮对话，和普通消息一样要等运行结束。
            !(active && parsedCommand.command.id === 'plan' && parsedCommand.args !== ''))
      : // 普通消息运行中也能发：主进程会把它作为引导注入当前轮。
        true)
  const mention = useMentionMenu({
    text,
    setText,
    textarea,
    root,
    scope: { sessionId },
    agents: agentOptions,
    disabled: sending,
  })
  // 菜单分两组：内置指令在前，技能在后，各自按相关度排序。
  const panel = commandPanel(text, commands, dismissedDraft, commandIndex)
  const commandPanelOpen = !mention.open && panel.open && !sending
  const filteredCommands = commandPanelOpen ? panel.filtered : []
  const activeCommandIndex = panel.activeIndex

  const showNotice = (
    key: string,
    tone: CommandNotice['tone'],
    command?: string,
    params?: Readonly<Record<string, string>>,
  ) => {
    noticeId.current += 1
    setCommandNotice({
      id: noticeId.current,
      key,
      tone,
      ...(command ? { command } : {}),
      ...(params ? { params } : {}),
    })
  }

  // 自动增高
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [text])

  // ⌘L：根组件派发聚焦请求，由当前挂载的输入框响应。
  useEffect(() => {
    const onFocus = () => textarea.current?.focus()
    window.addEventListener(COMPOSER_FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, onFocus)
  }, [])

  const compactNow = async (): Promise<boolean | undefined> => {
    setSending(true)
    const compacted = await compactSession()
    setSending(false)
    if (compacted === true) showNotice('composer.command.compacted', 'ok', 'compact')
    else if (compacted === false)
      showNotice('composer.command.nothingToCompact', 'muted', 'compact')
    return compacted
  }

  /** 从草稿里取出 `@Agent名`；名称列表同时用来把它们排除在文件引用之外。 */
  const referencesOf = (draft: string) => ({
    agents: extractAgents(draft, agentMentions),
    agentNames: agentMentions.map((item) => item.name),
  })

  /** 把拖进来的文件插到光标处，等同于选中一个 `@` 候选。 */
  const insertReference = (path: string, kind: 'file' | 'dir') => {
    const element = textarea.current
    const start = element?.selectionStart ?? text.length
    const end = element?.selectionEnd ?? start
    const inserted = mentionText(path, kind)
    setText(text.slice(0, start) + inserted + text.slice(end))
    requestAnimationFrame(() => {
      const caret = start + inserted.length
      element?.focus()
      element?.setSelectionRange(caret, caret)
    })
  }

  /** 把外部拖入 / 粘贴的绝对路径转成工作空间相对路径，插到光标处；返回是否全部在工作空间内。 */
  const insertExternalFiles = (files: readonly ExternalFile[]) => {
    const root = projectPath
    if (root === undefined || root === '') {
      showNotice('input.needWorkspace', 'muted')
      return
    }
    const platform = window.cairn?.windowControls?.platform
    const references: { path: string; kind: 'file' | 'dir' }[] = []
    for (const file of files) {
      const relative = relativeMentionPath(root, file.path, platform)
      if (relative === undefined) continue
      references.push({ path: relative, kind: file.kind })
    }
    if (references.length === 0) {
      showNotice('input.outsideWorkspace', 'muted')
      return
    }
    if (references.length < files.length) showNotice('input.someOutsideWorkspace', 'muted')
    const element = textarea.current
    const start = element?.selectionStart ?? text.length
    const end = element?.selectionEnd ?? start
    const inserted = references.map((file) => mentionText(file.path, file.kind)).join('')
    setText(text.slice(0, start) + inserted + text.slice(end))
    requestAnimationFrame(() => {
      const caret = start + inserted.length
      element?.focus()
      element?.setSelectionRange(caret, caret)
    })
  }

  /** 粘贴 / 拖入的附件：先保存到主进程，再挂到输入框上方；失败时提示。 */
  const addAttachments = async (files: readonly File[]) => {
    if (files.length === 0) return
    const room = MAX_PROMPT_ATTACHMENTS - draftState.current.attachments.length
    if (room <= 0) {
      showNotice('input.attachment.tooMany', 'muted')
      return
    }
    if (files.length > room) showNotice('input.attachment.tooMany', 'muted')
    const results = await Promise.all(files.slice(0, room).map((file) => saveAttachment(file)))
    const error = results.find((result) => 'error' in result)
    if (error !== undefined && 'error' in error) showNotice(error.error, 'muted')
    const added = results.flatMap((result) => ('attachment' in result ? [result.attachment] : []))
    if (added.length === 0) return
    setAttachments((current) => {
      const existing = new Set(current.map((attachment) => attachment.blobRef))
      return [...current, ...added.filter((attachment) => !existing.has(attachment.blobRef))].slice(
        0,
        MAX_PROMPT_ATTACHMENTS,
      )
    })
  }

  /**
   * 发送 / 停止后把焦点还给输入框，接着打字不用再点一下。
   * 如果用户已经点到输入框外面（侧栏、设置等），不把焦点抢回来。
   */
  const restoreComposerFocus = () => {
    const active = document.activeElement
    if (active !== null && active !== document.body && root.current?.contains(active) !== true) {
      return
    }
    textarea.current?.focus()
  }

  const send = async () => {
    if (!canSend) return
    const draft = text
    if (parsedCommand !== undefined) {
      await runCommand(parsedCommand.command, parsedCommand.args)
      return
    }
    recordHistory(draft)
    const pendingAttachments = draftState.current.attachments
    setText('')
    setAttachments([])
    setSending(true)
    const sent = await sendPrompt(draft, planMode ? 'plan' : 'normal', {
      ...referencesOf(draft),
      attachments: pendingAttachments,
    })
    setSending(false)
    // 计划模式只对这一轮生效，发出后立即退出，避免后续消息仍被当作只读计划拦截。
    if (sent) setPlanMode(false)
    if (!sent) {
      setText((current) => (current === '' ? draft : current))
      setAttachments((current) => (current.length === 0 ? pendingAttachments : current))
    }
    restoreComposerFocus()
  }

  const runCommand = async (command: AvailableCommand, args = '') => {
    if (sending) return
    if (command.unavailable !== undefined) {
      // 保留草稿，说明为什么现在不能执行。
      showNotice(command.unavailable, 'muted', command.name)
      return
    }
    // `/技能名` 单独执行时先补全成可以接着写任务的样子，而不是发一条空消息。
    if (command.kind === 'skill' && args === '') {
      setDismissedDraft(null)
      setText(`/${command.name} `)
      textarea.current?.focus()
      return
    }
    const draft = text
    const restore = () => setText((current) => (current === '' ? draft : current))
    setDismissedDraft(null)
    setText('')
    if (command.kind === 'skill') {
      if (args !== '') recordHistory(`/${command.name} ${args}`)
      setSending(true)
      const sent = await sendPrompt(args, planMode ? 'plan' : 'normal', {
        ...referencesOf(args),
        skills: [command.name],
      })
      setSending(false)
      if (sent) setPlanMode(false)
      if (!sent) restore()
      textarea.current?.focus()
      return
    }
    // /model 把焦点交给下拉菜单，关闭时再由 onOpenChange 还回来；打开面板或设置时焦点跟过去。
    let keepFocus = true
    switch (command.id) {
      case 'plan':
        if (args === '') {
          setPlanMode((on) => !on)
        } else {
          recordHistory(`/plan ${args}`)
          setSending(true)
          const sent = await sendPrompt(args, 'plan', referencesOf(args))
          setSending(false)
          if (sent) setPlanMode(false)
          if (!sent) restore()
        }
        break
      case 'goal': {
        const action = parseGoalCommand(args)
        const current = view === undefined ? undefined : openGoal(view)
        if (action.action === 'status') {
          // 有未结束目标，或只有历史目标时，都打开面板；完全没有目标才提示。
          const hasHistory =
            view !== undefined &&
            view.goalOrder.some((goalId) => view.goals[goalId]?.status === 'ended')
          if (current !== undefined || hasHistory) {
            if (onOpenPanel !== undefined) {
              onOpenPanel('goal')
              keepFocus = false
            } else {
              restore()
              showNotice('composer.command.goal.none', 'muted', 'goal')
            }
          } else {
            restore()
            showNotice('composer.command.goal.none', 'muted', 'goal')
          }
          break
        }
        if (action.action === 'pause') {
          // 暂停 / 清除不清空草稿：用户往往还要接着用 `/goal` 查看或恢复。
          restore()
          if (current === undefined) {
            showNotice('composer.command.goal.none', 'muted', 'goal')
            break
          }
          const outcome = await pauseGoal(sessionId)
          showNotice(
            outcome.ok ? 'composer.command.goal.paused' : goalErrorNoticeKey(outcome.code),
            outcome.ok ? 'ok' : 'muted',
            'goal',
          )
          break
        }
        if (action.action === 'clear') {
          restore()
          if (current === undefined) {
            showNotice('composer.command.goal.none', 'muted', 'goal')
            break
          }
          const outcome = await clearGoal(sessionId)
          showNotice(
            outcome.ok ? 'composer.command.goal.cleared' : goalErrorNoticeKey(outcome.code),
            outcome.ok ? 'ok' : 'muted',
            'goal',
          )
          break
        }
        if (action.action === 'resume') {
          if (current === undefined) {
            restore()
            showNotice('composer.command.goal.none', 'muted', 'goal')
            break
          }
          if (current.status === 'active') {
            restore()
            showNotice('composer.command.goal.active', 'muted', 'goal')
            break
          }
          const outcome = await resumeGoal(sessionId)
          if (outcome.ok) showNotice('composer.command.goal.resumed', 'ok', 'goal')
          else {
            restore()
            showNotice(goalErrorNoticeKey(outcome.code), 'muted', 'goal')
          }
          break
        }
        const condition = action.condition.trim()
        if (condition === '') {
          restore()
          showNotice('composer.command.goal.empty', 'muted', 'goal')
          break
        }
        if (condition.length > GOAL_CONDITION_MAX) {
          restore()
          showNotice('composer.command.goal.tooLong', 'muted', 'goal', {
            max: String(GOAL_CONDITION_MAX),
          })
          break
        }
        const outcome = await setGoal(sessionId, condition)
        if (outcome.ok) {
          setPlanMode(false)
          showNotice('composer.command.goal.started', 'ok', 'goal')
        } else {
          restore()
          showNotice(goalErrorNoticeKey(outcome.code), 'muted', 'goal')
        }
        break
      }
      case 'model': {
        const choice =
          args === ''
            ? undefined
            : matchCommandArg(args, enabledModelChoices(providers), (item) => [
                item.name,
                item.ref.modelId,
                `${item.provider}${item.name}`,
              ])
        if (choice === undefined) {
          if (args !== '')
            showNotice('composer.command.model.notFound', 'muted', 'model', { query: args })
          setModelMenuOpen(true)
          keepFocus = false
        } else {
          rememberRecentModel(choice.ref)
          await setSessionModel(sessionId, choice.ref)
          showNotice('composer.command.model.switched', 'ok', 'model', { name: choice.name })
        }
        break
      }
      case 'help':
        setHelpOpen(true)
        keepFocus = false
        break
      case 'agent': {
        if (args === '') {
          setAgentPickerOpen(true)
          keepFocus = false
          break
        }
        const choice = matchCommandArg(args, availableAgents(agents), (item) => [
          item.name['zh-CN'] ?? '',
          item.name['en-US'] ?? '',
          item.agentId,
        ])
        if (choice === undefined) {
          showNotice('composer.command.agent.notFound', 'muted', 'agent', { query: args })
          break
        }
        const switched = await setSessionAgent(sessionId, {
          id: choice.agentId,
          version: choice.version,
        })
        showNotice(
          switched ? 'composer.command.agent.switched' : 'composer.command.agent.switchFailed',
          switched ? 'ok' : 'muted',
          'agent',
          { name: agentName(choice, i18n.language) },
        )
        break
      }
      case 'permissions': {
        if (args === '') {
          setModeMenuOpen(true)
          keepFocus = false
          break
        }
        const mode = matchCommandArg(args, PERMISSION_MODES, (item) => [
          item,
          t(`composer.permission.${item}`),
        ])
        if (mode === undefined) {
          showNotice('composer.command.permissions.notFound', 'muted', 'permissions', {
            query: args,
          })
          break
        }
        const saved = await updateSettings({ permissionMode: mode })
        showNotice(
          saved === undefined
            ? 'composer.command.permissions.switchFailed'
            : 'composer.command.permissions.switched',
          saved === undefined ? 'muted' : 'ok',
          'permissions',
          { mode: t(`composer.permission.${mode}`) },
        )
        break
      }
      case 'context':
        setContextOpen(true)
        keepFocus = false
        break
      case 'status': {
        const current =
          agent === undefined ? undefined : agents.find((item) => item.agentId === agent.id)
        showNotice('composer.command.status', 'muted', 'status', {
          model: modelLabels(model, providers).full ?? t('composer.model.none'),
          agent:
            agent === undefined
              ? t('composer.agent.default')
              : current === undefined
                ? agent.id
                : agentName(current, i18n.language),
          permission: t(`composer.permission.${permissionMode}`),
          context:
            contextTokens === undefined
              ? t('composer.context.noUsage')
              : formatCompactTokens(contextTokens),
        })
        break
      }
      case 'stop':
        await abort()
        break
      case 'compact': {
        const compacted = await compactNow()
        if (compacted === undefined) restore()
        break
      }
      case 'undo':
        setRestoreTarget(undoTarget)
        keepFocus = false
        break
      case 'new':
      case 'clear':
        onNewChat?.()
        keepFocus = false
        break
      case 'rename': {
        if (args === '') {
          restore()
          showNotice('composer.command.rename.missing', 'muted', 'rename')
          break
        }
        const renamed = await renameSession(sessionId, args)
        if (renamed) showNotice('composer.command.rename.done', 'ok', 'rename', { title: args })
        else {
          restore()
          showNotice('composer.command.rename.failed', 'muted', 'rename')
        }
        break
      }
      case 'search':
        onOpenSearch?.()
        keepFocus = false
        break
      case 'settings':
      case 'mcp':
      case 'skills':
      case 'providers': {
        const section =
          command.settings ??
          (args === ''
            ? undefined
            : matchCommandArg(args, SETTINGS_SECTIONS, (id) => [id, ts(`section.${id}.title`)]))
        onOpenSettings?.(section ?? 'general')
        keepFocus = false
        break
      }
      default:
        if (command.panel !== undefined) onOpenPanel?.(command.panel)
        keepFocus = false
    }
    if (keepFocus) textarea.current?.focus()
  }

  const stop = async () => {
    setAborting(true)
    await abort()
    setAborting(false)
    restoreComposerFocus()
  }

  // 运行中按 Esc 停止（对话框或菜单打开时由它们处理 Esc）
  const canStop = (status === 'running' || status === 'waiting_input') && !stopping && !aborting
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    if (!canStop) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"]:not([aria-hidden="true"]), [role="menu"]')) return
      event.preventDefault()
      void stopRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canStop])

  // Ctrl+Shift+P / ⌘⇧P 在正常 / 计划之间切换；对话框与菜单打开时交给它们。
  // `/` 与 `@` 候选列表只用方向键、Enter、Tab、Esc，快捷键仍然可用；其他列表（如 Agent 选择器）留给它们。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlanModeKey(event) || event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], ' +
            `[role="listbox"]:not(#${COMMAND_LIST_ID}):not(#${MENTION_LIST_ID})`,
        )
      )
        return
      event.preventDefault()
      setPlanMode((on) => !on)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // 面板打开时点发送键等同于执行当前高亮的命令，而不是把 `/plan` 当消息发出去。
    const command = commandPanelOpen ? filteredCommands[activeCommandIndex] : undefined
    if (command !== undefined) {
      void runCommand(command)
      return
    }
    void send()
  }

  useEffect(() => {
    setCommandIndex(0)
    // 离开 `/` 草稿后忘掉这次关闭，下一次重新输入 `/` 时面板还会打开。
    if (panel.query === null) setDismissedDraft(null)
  }, [panel.query])

  // 点击输入框以外的地方关闭命令面板，避免它一直挂在对话上方。
  useEffect(() => {
    if (!commandPanelOpen) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target) === true) return
      setDismissedDraft(text)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [commandPanelOpen, text])

  // 命令结果显示在工具栏中间的空位，只停留几秒，不占用输入框上方的空间。
  useEffect(() => {
    if (commandNotice === null) return
    const timer = setTimeout(() => setCommandNotice(null), 3_500)
    return () => clearTimeout(timer)
  }, [commandNotice])

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字时的按键（Enter、方向键等）属于候选词操作，不执行命令、也不发送。
    if (event.nativeEvent.isComposing) return
    if (mention.onKeyDown(event)) return
    if (commandPanelOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (filteredCommands.length === 0) return
        event.preventDefault()
        setCommandIndex((current) => {
          const base = Math.min(current, filteredCommands.length - 1)
          const next = event.key === 'ArrowDown' ? base + 1 : base - 1
          return (next + filteredCommands.length) % filteredCommands.length
        })
        return
      }
      if (event.key === 'Tab' && !event.shiftKey) {
        const command = filteredCommands[activeCommandIndex]
        if (command === undefined) return
        event.preventDefault()
        setText(command.args === 'none' ? `/${command.name}` : `/${command.name} `)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedDraft(text)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const command = filteredCommands[activeCommandIndex]
        if (command !== undefined) {
          event.preventDefault()
          void runCommand(command)
          return
        }
        // 没有匹配时按普通消息发送。
      }
    }
    if (!mention.open && !commandPanelOpen) {
      if (
        event.key === 'ArrowUp' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        const isAtStart =
          textarea.current?.selectionStart === 0 && textarea.current?.selectionEnd === 0
        if (isAtStart && promptHistory.current.length > 0) {
          if (historyIndex.current === -1) {
            draftBeforeHistory.current = text
          }
          const nextIndex = Math.min(historyIndex.current + 1, promptHistory.current.length - 1)
          const item = promptHistory.current[nextIndex]
          if (item !== undefined) {
            event.preventDefault()
            historyIndex.current = nextIndex
            setText(item)
            requestAnimationFrame(() => {
              textarea.current?.setSelectionRange(item.length, item.length)
            })
            return
          }
        }
      }
      if (
        event.key === 'ArrowDown' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        historyIndex.current >= 0
      ) {
        event.preventDefault()
        const nextIndex = historyIndex.current - 1
        historyIndex.current = nextIndex
        if (nextIndex < 0) {
          setText(draftBeforeHistory.current)
        } else {
          const item = promptHistory.current[nextIndex]
          if (item !== undefined) {
            setText(item)
            requestAnimationFrame(() => {
              textarea.current?.setSelectionRange(item.length, item.length)
            })
          }
        }
        return
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  return (
    <div ref={root}>
      <div className="relative">
        {mention.list}
        {commandPanelOpen && (
          <ComposerCommandList
            commands={filteredCommands}
            activeIndex={activeCommandIndex}
            onSelect={(command) => void runCommand(command)}
            onHover={setCommandIndex}
          />
        )}
        <WorkspaceGitBar projectPath={projectPath} returnFocus={() => textarea.current?.focus()} />
        <form
          onSubmit={submit}
          onClick={(e) => {
            if (e.target === e.currentTarget) textarea.current?.focus()
          }}
          onDragOver={(event) => {
            if (
              sending ||
              (!event.dataTransfer.types.includes(FILE_DRAG_TYPE) &&
                !event.dataTransfer.types.includes('Files'))
            ) {
              return
            }
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setDragging(false)
          }}
          onDrop={(event) => {
            setDragging(false)
            if (sending) return
            const internal = draggedFile(event)
            if (internal !== undefined) {
              event.preventDefault()
              insertReference(internal.path, internal.kind)
              return
            }
            // 其它拖入（如选中的文字）保持浏览器默认行为。
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            const paths = externalDroppedFiles(event, window.cairn?.filePaths?.fromFile)
            if (paths.length > 0) {
              insertExternalFiles(paths)
              return
            }
            // 没有磁盘路径的文件（浏览器拖来的图片、文档）作为附件保存。
            void addAttachments(droppedAttachmentFiles(event, window.cairn?.filePaths?.fromFile))
          }}
          onPaste={(event) => {
            const files = pastedFilePaths(event, window.cairn?.filePaths?.fromFile)
            if (files.length > 0) {
              event.preventDefault()
              insertExternalFiles(files)
              return
            }
            // 截图等只有内容、没有路径的文件：保存为附件，而不是让浏览器把二进制粘成文字。
            const attachments = pastedAttachmentFiles(event, window.cairn?.filePaths?.fromFile)
            if (attachments.length === 0) return
            event.preventDefault()
            void addAttachments(attachments)
          }}
          className={cn(
            'relative rounded-[14px] border border-hair2 bg-raise px-3.5 pt-3 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60',
            dragging && 'border-accent ring-2 ring-accent/20',
          )}
        >
          {dragging && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] border-2 border-dashed border-accent bg-accent/5 text-note text-accent"
            >
              {t('input.dropFiles')}
            </div>
          )}
          <ComposerAttachments
            attachments={attachments}
            onRemove={(blobRef) =>
              setAttachments((current) =>
                current.filter((attachment) => attachment.blobRef !== blobRef),
              )
            }
          />
          <div className="relative">
            <textarea
              ref={textarea}
              rows={1}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={t('input.label')}
              aria-expanded={commandPanelOpen || mention.open}
              aria-controls={
                mention.open ? MENTION_LIST_ID : commandPanelOpen ? COMMAND_LIST_ID : undefined
              }
              aria-activedescendant={
                mention.open
                  ? mention.activeId
                  : commandPanelOpen && activeCommandIndex >= 0
                    ? commandOptionId(filteredCommands[activeCommandIndex]!)
                    : undefined
              }
              placeholder={planMode ? t('composer.plan.placeholder') : t('input.placeholder')}
              value={text}
              onChange={(e) => {
                const next = e.target.value
                setText(next)
                setCommandNotice(null)
                if (historyIndex.current !== -1) historyIndex.current = -1
                if (next.trimStart().startsWith('/')) ensureSkills()
              }}
              onKeyDown={keyDown}
              onSelect={mention.onCaret}
              className="relative block max-h-[200px] min-h-6 w-full resize-none break-words bg-transparent px-1 text-body text-transparent caret-fg outline-none placeholder:text-faint"
            />
            {/* 放在文本框之后：它的布局副作用要等文本框的 ref 就绪 */}
            <ComposerHighlight
              text={text}
              commands={commandNames}
              textarea={textarea}
              className="px-1 text-body text-fg break-words"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <AgentPicker
              sessionId={sessionId}
              agent={agent}
              team={view?.info?.team}
              disabled={active}
              open={agentPickerOpen}
              onOpenChange={setAgentPickerOpen}
              returnFocus={() => textarea.current?.focus()}
              onManage={onOpenSettings === undefined ? undefined : () => onOpenSettings('agents')}
              onManageTeams={
                onOpenSettings === undefined ? undefined : () => onOpenSettings('teams')
              }
            />
            <ModeMenu
              planMode={planMode}
              onTogglePlan={() => setPlanMode((on) => !on)}
              open={modeMenuOpen}
              onOpenChange={setModeMenuOpen}
              returnFocus={() => textarea.current?.focus()}
            />
            {/* 指令结果放在工具栏中间的空位：不占文档流、不改变输入框高度，窄窗口截断后悬停看全文。 */}
            {commandNotice && (
              <p
                role="status"
                title={t(commandNotice.key, commandNotice.params ?? {})}
                className={cn(
                  'min-w-0 flex-1 truncate text-note',
                  commandNotice.tone === 'ok' ? 'text-ok' : 'text-muted',
                )}
              >
                {commandNotice.command && (
                  <span className="mr-1 font-mono text-fg2">/{commandNotice.command}</span>
                )}
                {t(commandNotice.key, commandNotice.params ?? {})}
              </p>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <ModelPicker
                providers={providers}
                model={model}
                fixed={fixedModel}
                disabled={modelMenuDisabled}
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                returnFocus={() => textarea.current?.focus()}
                onSelect={(next) => void setSessionModel(sessionId, next)}
                thinkingLevel={view?.info?.thinkingLevel}
                onSelectThinkingLevel={(level) => void setSessionThinkingLevel(sessionId, level)}
              />
              <ContextUsage
                sessionId={sessionId}
                model={model}
                tokens={contextTokens}
                open={contextOpen}
                onOpenChange={setContextOpen}
                returnFocus={() => textarea.current?.focus()}
              />
              {active ? (
                <button
                  type="button"
                  aria-label={tc('action.stop')}
                  title={tc('action.stop')}
                  disabled={stopping || aborting}
                  onClick={() => void stop()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-45"
                >
                  <Square className="size-3 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label={t('input.send')}
                  title={t('input.send')}
                  disabled={!canSend}
                  className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-25"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
      <RestoreDialog
        sessionId={sessionId}
        target={restoreTarget}
        onClose={() => {
          setRestoreTarget(undefined)
          textarea.current?.focus()
        }}
      />
      <CommandHelpDialog open={helpOpen} onOpenChange={setHelpOpen} commands={commands} />
    </div>
  )
}
