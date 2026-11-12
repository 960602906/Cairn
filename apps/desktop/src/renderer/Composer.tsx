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
 * - 下方左边是权限模式（只读 / 询问 / 自动，全局设置），右边是“供应商 · 模型”切换（只改当前会话，下一轮生效）、
 *   上下文占用圆环（悬停显示百分比与 token 数）与发送 / 停止按钮。
 */
import {
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  ListChecks,
  ShieldCheck,
  Square,
  X,
  Zap,
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { RunView, SessionView } from '@cairn/core'
import type {
  AgentDefinitionRef,
  ModelRef,
  PermissionMode,
  ProviderConfig,
  SessionStatus,
  SkillSummary,
} from '@cairn/protocol'
import { matchCommandArg, parseComposerCommand, SETTINGS_SECTIONS } from './composer-commands.js'
import { COMMAND_LIST_ID, commandOptionId, ComposerCommandList } from './ComposerCommandList.js'
import {
  availableCommands,
  commandPanel,
  type AvailableComposerCommand,
} from './composer-shared.js'
import { extractAgents, mentionText } from './composer-tokens.js'
import { agentName, localized } from './agents/model.js'
import { FILE_DRAG_TYPE, draggedFile } from './file-drag.js'
import {
  RestoreDialog,
  turnCheckpoints,
  turnNumbers,
  useCanRestore,
  type RestoreTarget,
} from './Checkpoints.js'
import { ComposerHighlight } from './ComposerHighlight.js'
import { MENTION_LIST_ID, useMentionMenu, type MentionAgent } from './ComposerMentions.js'
import { isPlanModeKey, planShortcut } from './layout/shortcuts.js'
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
  DropdownMenuTrigger,
  Tooltip,
} from './ui/index.js'

export interface ComposerProps {
  readonly sessionId: string
  readonly status: SessionStatus
  readonly run: RunView | undefined
  /** 当前运行的 Agent（M3-12）；没有运行时为 undefined。 */
  readonly agent?: AgentDefinitionRef | undefined
  /** 会话的模型（下一轮使用）；没有记录时用默认模型。 */
  readonly model: ModelRef | undefined
  /** 会话的项目目录；输入框上方显示当前目录与分支。 */
  readonly projectPath: string | undefined
  /** 上下文占用的 token 数（最近一次用量）。 */
  readonly contextTokens: number | undefined
  /** `/files`、`/diff` 等打开右侧面板；没有时这些指令不出现。 */
  readonly onOpenPanel?: ((panel: SessionPanel) => void) | undefined
  /** `/new`；没有时指令不出现。 */
  readonly onNewChat?: (() => void) | undefined
  /** `/settings [分区]`；没有时指令不出现。 */
  readonly onOpenSettings?: ((section: SettingsSection) => void) | undefined
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
const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'ask', 'auto']
const PERMISSION_ICONS = { 'read-only': Eye, ask: ShieldCheck, auto: Zap } as const

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a !== undefined && b !== undefined && a.providerId === b.providerId && a.modelId === b.modelId

/** 模型选择项：供应商名称用于分组，模型短名称用于按钮与菜单。 */
export interface ModelChoice {
  readonly ref: ModelRef
  readonly provider: string
  readonly name: string
}

/** 把设置里的供应商列表摊平成可选模型；停用的模型不列出。 */
export function enabledModelChoices(providers: readonly ProviderConfig[]): readonly ModelChoice[] {
  return providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled !== false)
      .map((model) => ({
        ref: { providerId: provider.id, modelId: model.id },
        provider: provider.displayName,
        name: model.displayName ?? model.id,
      })),
  )
}

/** 新会话的默认模型：优先设置里的默认模型，否则用第一个启用的模型。 */
export function resolveDefaultModel(
  providers: readonly ProviderConfig[],
  preferred: ModelRef | undefined,
): ModelRef | undefined {
  const choices = enabledModelChoices(providers)
  return (choices.find((choice) => sameModel(preferred, choice.ref)) ?? choices[0])?.ref
}

/** 当前模型的短名称与“供应商 · 模型”全名。 */
export function modelLabels(
  model: ModelRef | undefined,
  providers: readonly ProviderConfig[],
): { readonly short: string | undefined; readonly full: string | undefined } {
  if (model === undefined) return { short: undefined, full: undefined }
  const provider = providers.find((item) => item.id === model.providerId)
  const configured = provider?.models.find((item) => item.id === model.modelId)
  const short = configured?.displayName ?? configured?.id ?? model.modelId
  const full = provider === undefined ? model.modelId : `${provider.displayName} · ${short}`
  return { short, full }
}

/**
 * 计划模式标记：只在开启时出现，点一下退出。开启靠 `/plan` 或快捷键，不再常驻一个开关按钮。
 */
export function PlanModeChip({
  on,
  onExit,
}: {
  readonly on: boolean
  readonly onExit: () => void
}) {
  const { t } = useTranslation('session')
  if (!on) return null
  return (
    <button
      type="button"
      aria-label={t('composer.plan.exit')}
      title={t('composer.plan.hint', { shortcut: planShortcut() })}
      onClick={onExit}
      className="group flex h-7 items-center gap-1 rounded-item bg-accent-soft px-2 text-ui text-accent outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <ListChecks className="size-3.5" />
      {t('composer.plan.toggle')}
      <X className="size-3 opacity-60 group-hover:opacity-100" />
    </button>
  )
}

export function PermissionMenu() {
  const { t } = useTranslation('session')
  const mode = useSessionStore((s) => s.settings?.permissionMode) ?? DEFAULT_PERMISSION_MODE
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const Icon = PERMISSION_ICONS[mode]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('composer.permission.label', { mode: t(`composer.permission.${mode}`) })}
        className="flex h-7 items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent [&_svg]:size-3.5"
      >
        <Icon className="text-muted" />
        {t(`composer.permission.${mode}`)}
        <ChevronDown className="text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuLabel>{t('composer.permission.title')}</DropdownMenuLabel>
        {PERMISSION_MODES.map((option) => {
          const OptionIcon = PERMISSION_ICONS[option]
          return (
            <DropdownMenuItem
              key={option}
              className="h-auto items-start py-1.5"
              onSelect={() => void updateSettings({ permissionMode: option })}
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ModelPicker({
  providers,
  model,
  fixed,
  disabled,
  open,
  onOpenChange,
  onSelect,
  align = 'end',
}: {
  readonly providers: readonly ProviderConfig[]
  readonly model: ModelRef | undefined
  /** Agent 固定了模型（M3-12）：显示当前模型并禁用。 */
  readonly fixed: boolean
  /** 没有可选模型时禁用。 */
  readonly disabled: boolean
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSelect: (model: ModelRef) => void
  readonly align?: 'start' | 'end'
}) {
  const { t } = useTranslation('session')
  // 停用的模型不列出（M2-10）；会话正在用的仍显示它的名称。
  const options = enabledModelChoices(providers)
  const { full, short } = modelLabels(model, providers)
  const label = full ?? short ?? t('composer.model.none')
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={t('composer.model.label', { model: label })}
        title={fixed ? t('composer.model.fixedByAgent') : undefined}
        className="flex h-7 max-w-[240px] items-center gap-1 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60 [&_svg]:size-3.5"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side="top" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-faint">{t('composer.model.title')}</DropdownMenuLabel>
        {options.map((option, index) => (
          <Fragment key={`${option.ref.providerId}/${option.ref.modelId}`}>
            {options[index - 1]?.ref.providerId !== option.ref.providerId && (
              <DropdownMenuLabel className="pt-2">{option.provider}</DropdownMenuLabel>
            )}
            <DropdownMenuItem
              onSelect={() => {
                if (!sameModel(model, option.ref)) onSelect(option.ref)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {sameModel(model, option.ref) && <Check className="text-fg!" />}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 上下文占用圆环：模型的上下文窗口已用多少；不知道窗口大小时不显示。 */
function ContextRing({
  model,
  tokens,
}: {
  readonly model: ModelRef | undefined
  readonly tokens: number
}) {
  const { t, i18n } = useTranslation('session')
  const providers = useSessionStore((s) => s.settings?.providers)
  const window = providers
    ?.find((p) => p.id === model?.providerId)
    ?.models.find((m) => m.id === model?.modelId)?.contextWindow
  if (!window) return null
  const ratio = Math.min(1, tokens / window)
  const percent = Math.round(ratio * 100)
  const r = 6
  const c = 2 * Math.PI * r
  const label = t('composer.context', {
    percent,
    used: tokens.toLocaleString(i18n.language),
    total: window.toLocaleString(i18n.language),
  })
  return (
    <Tooltip content={label}>
      <span
        role="img"
        aria-label={label}
        tabIndex={0}
        className="flex size-7 items-center justify-center rounded-item outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-hair2" />
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
        </svg>
      </span>
    </Tooltip>
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
}: ComposerProps) {
  const { t, i18n } = useTranslation('session')
  const { t: tc } = useTranslation()
  const { t: ts } = useTranslation('settings')
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const compactSession = useSessionStore((s) => s.compactSession)
  const abort = useSessionStore((s) => s.abort)
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
  const [text, setText] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null)
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const noticeId = useRef(0)
  const active = status === 'running' || status === 'waiting_approval'
  const stopping = run?.state === 'aborting'
  const fixedModel = agent !== undefined && run?.agent.id === agent.id && fixedAgentModel
  const enabledModelCount = providers
    .flatMap((provider) => provider.models)
    .filter((item) => item.enabled !== false).length
  const modelMenuDisabled = fixedModel || enabledModelCount === 0
  const undoTarget = lastTurnTarget(view)
  const projectId = projects?.find((project) => project.path === projectPath)?.projectId
  useEffect(() => {
    if (projectId === undefined) {
      setSkills([])
      return
    }
    let alive = true
    void listSkills(projectId).then((list) => {
      if (alive) setSkills(list ?? [])
    })
    return () => {
      alive = false
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
        .filter((item) => delegateIds === undefined || delegateIds.includes(item.agentId))
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
    },
    true,
  )
  const commandNames = commands.map((command) => command.name)
  const parsedCommand = parseComposerCommand(text, commands)
  const canSend =
    !sending &&
    !stopping &&
    text.trim() !== '' &&
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

  const send = async () => {
    if (!canSend) return
    const draft = text
    if (parsedCommand !== undefined) {
      await runCommand(parsedCommand.command, parsedCommand.args)
      return
    }
    setText('')
    setSending(true)
    const sent = await sendPrompt(draft, planMode ? 'plan' : 'normal', referencesOf(draft))
    setSending(false)
    if (!sent) setText((current) => (current === '' ? draft : current))
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
      setSending(true)
      const sent = await sendPrompt(args, planMode ? 'plan' : 'normal', {
        ...referencesOf(args),
        skills: [command.name],
      })
      setSending(false)
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
          setSending(true)
          const sent = await sendPrompt(args, 'plan', referencesOf(args))
          setSending(false)
          if (!sent) restore()
        }
        break
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
          await setSessionModel(sessionId, choice.ref)
          showNotice('composer.command.model.switched', 'ok', 'model', { name: choice.name })
        }
        break
      }
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
        onNewChat?.()
        keepFocus = false
        break
      case 'settings': {
        const section =
          args === ''
            ? undefined
            : matchCommandArg(args, SETTINGS_SECTIONS, (id) => [id, ts(`section.${id}.title`)])
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
  }

  // 运行中按 Esc 停止（对话框或菜单打开时由它们处理 Esc）
  const canStop = status === 'running' && !stopping && !aborting
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
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlanModeKey(event) || event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
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

  // 命令结果只停留几秒，避免长期占用输入框上方的空间。
  useEffect(() => {
    if (commandNotice === null) return
    const timer = setTimeout(() => setCommandNotice(null), 3_500)
    return () => clearTimeout(timer)
  }, [commandNotice])

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字时的 Enter 属于候选词确认，不执行命令、也不发送。
    if (event.key === 'Enter' && event.nativeEvent.isComposing) return
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
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  return (
    <div ref={root}>
      <WorkspaceGitBar projectPath={projectPath} />
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
        <form
          onSubmit={submit}
          onClick={(e) => {
            if (e.target === e.currentTarget) textarea.current?.focus()
          }}
          onDragOver={(event) => {
            if (sending || !event.dataTransfer.types.includes(FILE_DRAG_TYPE)) return
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
            const file = draggedFile(event)
            if (sending || file === undefined) return
            event.preventDefault()
            insertReference(file.path, file.kind)
          }}
          className={cn(
            'rounded-[14px] border border-hair2 bg-raise px-3.5 pt-3 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60',
            dragging && 'border-accent ring-2 ring-accent/20',
          )}
        >
          {commandNotice && (
            <p
              role="status"
              className={cn(
                'px-1 pb-1 text-note',
                commandNotice.tone === 'ok' ? 'text-ok' : 'text-muted',
              )}
            >
              {commandNotice.command && (
                <span className="mr-1 font-mono text-fg2">/{commandNotice.command}</span>
              )}
              {t(commandNotice.key, commandNotice.params ?? {})}
            </p>
          )}
          <div className="relative">
            <textarea
              ref={textarea}
              rows={1}
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
                setText(e.target.value)
                setCommandNotice(null)
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
          <div className="mt-2 flex items-center gap-1">
            <PermissionMenu />
            <PlanModeChip on={planMode} onExit={() => setPlanMode(false)} />
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <ModelPicker
                providers={providers}
                model={model}
                fixed={fixedModel}
                disabled={modelMenuDisabled}
                open={modelMenuOpen}
                onOpenChange={(next) => {
                  setModelMenuOpen(next)
                  if (!next) textarea.current?.focus()
                }}
                onSelect={(next) => void setSessionModel(sessionId, next)}
              />
              <ContextRing model={model} tokens={contextTokens ?? 0} />
              {active && (
                <button
                  type="button"
                  aria-label={tc('action.stop')}
                  title={tc('action.stop')}
                  disabled={stopping || aborting}
                  onClick={() => void stop()}
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-45',
                  )}
                >
                  <Square className="size-3 fill-current" />
                </button>
              )}
              <button
                type="submit"
                aria-label={t('input.send')}
                title={t('input.send')}
                disabled={!canSend}
                className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-25"
              >
                <ArrowUp className="size-4" />
              </button>
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
    </div>
  )
}
