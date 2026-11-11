/**
 * 输入框（M2-04，视觉规范 §6）：悬浮在纸面底部的卡片。
 *
 * - 文本框自动增高（最多约 8 行）。Enter 发送，Shift+Enter 换行；输入法组字时的 Enter 不发送。
 *   运行中不能发送（主进程会报 `run.busy`），发送按钮换成停止按钮。发送时立即清空，失败时恢复。
 * - 草稿以 `/` 开头时弹出指令面板（注册表在 composer-commands.ts）。↑↓ 选择，Enter 执行，
 *   Tab 补全，Esc 关闭；没有匹配时按普通消息发送。写了空白之后面板收起，`/名称 参数` 在发送时执行，
 *   例如 `/plan 任务描述` 以计划模式发送、`/model 名称` 直接切换模型、`/settings mcp` 打开对应分区。
 *   运行中不能执行的指令在面板里置灰并说明原因。
 * - 文本框下面叠一层高亮（ComposerHighlight）：开头的指令、网址和代码片段有底色或下划线；
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
  Zap,
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
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
} from '@cairn/protocol'
import {
  COMPOSER_COMMANDS,
  composerCommandQuery,
  filterComposerCommands,
  matchCommandArg,
  parseComposerCommand,
  SETTINGS_SECTIONS,
} from './composer-commands.js'
import {
  RestoreDialog,
  turnCheckpoints,
  turnNumbers,
  useCanRestore,
  type RestoreTarget,
} from './Checkpoints.js'
import { ComposerHighlight } from './ComposerHighlight.js'
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
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const { t: ts } = useTranslation('settings')
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const compactSession = useSessionStore((s) => s.compactSession)
  const abort = useSessionStore((s) => s.abort)
  const agents = useSessionStore((s) => s.agents) ?? []
  const providers = useSessionStore((s) => s.settings?.providers) ?? []
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
  const commands = COMPOSER_COMMANDS.filter((command) =>
    command.panel !== undefined
      ? onOpenPanel !== undefined
      : command.id === 'new'
        ? onNewChat !== undefined
        : command.id === 'settings'
          ? onOpenSettings !== undefined
          : true,
  ).map((command) => ({
    ...command,
    description: t(command.descriptionKey),
    unavailable:
      command.idleOnly === true && active
        ? 'composer.command.unavailable.running'
        : command.id === 'model' && modelMenuDisabled
          ? 'composer.command.unavailable.model'
          : command.id === 'undo' && (!canRestore || undoTarget === undefined)
            ? 'composer.command.unavailable.undo'
            : undefined,
  }))
  const commandNames = commands.map((command) => command.name)
  const parsedCommand = parseComposerCommand(text, commands)
  const canSend =
    !sending &&
    text.trim() !== '' &&
    (parsedCommand !== undefined
      ? parsedCommand.command.unavailable === undefined &&
        // `/plan 任务` 会发出一轮对话，和普通消息一样要等运行结束。
        !(active && parsedCommand.command.id === 'plan' && parsedCommand.args !== '')
      : !active)
  const commandQuery = composerCommandQuery(text)
  const commandPanelOpen = commandQuery !== null && dismissedDraft !== text && !sending
  const filteredCommands =
    commandQuery === null ? [] : filterComposerCommands(commands, commandQuery)
  const activeCommandIndex =
    filteredCommands.length === 0 ? -1 : Math.min(commandIndex, filteredCommands.length - 1)

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

  const send = async () => {
    if (!canSend) return
    const draft = text
    if (parsedCommand !== undefined) {
      await runCommand(parsedCommand.command, parsedCommand.args)
      return
    }
    setText('')
    setSending(true)
    const sent = await sendPrompt(draft, planMode ? 'plan' : 'normal')
    setSending(false)
    if (!sent) setText((current) => (current === '' ? draft : current))
  }

  type AvailableCommand = (typeof commands)[number]

  const runCommand = async (command: AvailableCommand, args = '') => {
    if (sending) return
    if (command.unavailable !== undefined) {
      // 保留草稿，说明为什么现在不能执行。
      showNotice(command.unavailable, 'muted', command.name)
      return
    }
    const draft = text
    const restore = () => setText((current) => (current === '' ? draft : current))
    setDismissedDraft(null)
    setText('')
    // /model 把焦点交给下拉菜单，关闭时再由 onOpenChange 还回来；打开面板或设置时焦点跟过去。
    let keepFocus = true
    switch (command.id) {
      case 'plan':
        if (args === '') {
          setPlanMode((on) => !on)
        } else {
          setSending(true)
          const sent = await sendPrompt(args, 'plan')
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
    if (commandQuery === null) setDismissedDraft(null)
  }, [commandQuery])

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
        {commandPanelOpen && (
          <div
            id="composer-command-list"
            role="listbox"
            aria-label={t('composer.command.label')}
            className="absolute inset-x-0 bottom-full z-50 mb-2 max-h-64 overflow-y-auto rounded-card bg-raise p-1 text-ui text-fg shadow-2"
          >
            {filteredCommands.length === 0 ? (
              <p className="px-2 py-2 text-note text-muted">{t('composer.command.empty')}</p>
            ) : (
              filteredCommands.map((command, index) => {
                const selected = index === activeCommandIndex
                return (
                  <div
                    key={command.id}
                    id={`composer-command-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={command.unavailable !== undefined}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      void runCommand(command)
                    }}
                    onMouseEnter={() => setCommandIndex(index)}
                    className={cn(
                      'flex cursor-default select-none items-start gap-2 rounded-[7px] px-2 py-1.5',
                      selected && 'bg-hover',
                    )}
                  >
                    <span
                      className={cn(
                        'shrink-0 font-mono text-note',
                        command.unavailable === undefined ? 'text-fg' : 'text-faint',
                      )}
                    >
                      {'/'}
                      {command.name}
                      {command.args !== 'none' && (
                        <span className="text-faint">
                          {' '}
                          {t(`composer.command.args.${command.args}`)}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 text-note',
                        command.unavailable === undefined ? 'text-muted' : 'text-faint',
                      )}
                    >
                      {command.unavailable === undefined
                        ? command.description
                        : t(command.unavailable)}
                    </span>
                  </div>
                )
              })
            )}
            <p className="mt-1 border-t border-hair px-2 pt-1.5 text-[11px] text-faint">
              {t('composer.command.hint')}
            </p>
          </div>
        )}
        <form
          onSubmit={submit}
          onClick={(e) => {
            if (e.target === e.currentTarget) textarea.current?.focus()
          }}
          className="rounded-[14px] border border-hair2 bg-raise px-3.5 pt-3 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60"
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
              aria-expanded={commandPanelOpen}
              aria-controls={commandPanelOpen ? 'composer-command-list' : undefined}
              aria-activedescendant={
                commandPanelOpen && activeCommandIndex >= 0
                  ? `composer-command-${filteredCommands[activeCommandIndex]?.id}`
                  : undefined
              }
              placeholder={planMode ? t('composer.plan.placeholder') : t('input.placeholder')}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setCommandNotice(null)
              }}
              onKeyDown={keyDown}
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
            <button
              type="button"
              aria-pressed={planMode}
              aria-label={t('composer.plan.label')}
              title={t('composer.plan.hint', { shortcut: planShortcut() })}
              onClick={() => setPlanMode((on) => !on)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-item px-2 text-ui outline-none focus-visible:ring-1 focus-visible:ring-accent',
                planMode ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover',
              )}
            >
              <ListChecks className="size-3.5" />
              {t('composer.plan.toggle')}
            </button>
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
              {active ? (
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
    </div>
  )
}
