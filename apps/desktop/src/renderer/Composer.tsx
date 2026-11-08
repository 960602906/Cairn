/**
 * 输入框（M2-04，视觉规范 §6）：悬浮在纸面底部的卡片。
 *
 * - 上方是运行状态条：运行中显示转圈、“运行中 · 思考中”、本轮已用时间与“按 Esc 停止”；空闲时状态只给读屏。
 *   页面上唯一的 `role="status"` 区域在这里（只放状态文字，已用时间不放进去，避免读屏每秒播报）。
 * - 文本框自动增高（最多约 8 行）。Enter 发送，Shift+Enter 换行；输入法组字时的 Enter 不发送。
 *   运行中不能发送（主进程会报 `run.busy`），发送按钮换成停止按钮。发送时立即清空，失败时恢复。
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
import type { RunView } from '@cairn/core'
import type {
  AgentDefinitionRef,
  ModelRef,
  PermissionMode,
  RunState,
  SessionStatus,
} from '@cairn/protocol'
import { AgentPicker } from './agents/AgentPicker.js'
import { useSessionStore } from './store-context.js'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Kbd,
  Spinner,
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
  /** 上下文占用的 token 数（最近一次用量）。 */
  readonly contextTokens: number | undefined
}

/** 运行中时进一步说明的运行状态。 */
const RUN_DETAILS: ReadonlySet<RunState> = new Set(['thinking', 'tooling', 'aborting'])

/** 文本框最高（px），超过后滚动。 */
const MAX_TEXTAREA_HEIGHT = 200

const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask'
const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'ask', 'auto']
const PERMISSION_ICONS = { 'read-only': Eye, ask: ShieldCheck, auto: Zap } as const

const sameModel = (a: ModelRef | undefined, b: ModelRef) =>
  a?.providerId === b.providerId && a.modelId === b.modelId

/** 已用时间：m:ss（超过一小时为 h:mm:ss）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** 运行中每秒刷新的当前时间。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function RunBar({
  status,
  run,
}: {
  readonly status: SessionStatus
  readonly run: RunView | undefined
}) {
  const { t } = useTranslation('session')
  const active = status === 'running' || status === 'waiting_approval'
  // 已发送、这一轮还没开始时从发送时刻算起
  const [sentAt, setSentAt] = useState(() => Date.now())
  const turn = run?.turn?.status === 'running' ? run.turn : undefined
  useEffect(() => {
    if (active && !turn) setSentAt(Date.now())
  }, [active, turn])
  const now = useNow(active)
  const detail = status === 'running' && run && RUN_DETAILS.has(run.state) ? run.state : undefined
  const text = `${t(`status.${status}`)}${detail ? ` · ${t(`run.${detail}`)}` : ''}`
  if (!active) {
    return (
      <p role="status" className="sr-only">
        {text}
      </p>
    )
  }
  return (
    <div className="mb-2 flex items-center gap-2 px-3 text-note text-muted">
      <Spinner />
      <p role="status" className="text-fg2">
        {text}
      </p>
      <span aria-hidden className="tabular">
        · {formatElapsed(now - (turn?.startedAt ?? sentAt))}
      </span>
      {status === 'running' && (
        <span className="ml-auto flex items-center gap-1">
          {t('composer.escToStop.before')}
          <Kbd>{t('composer.escKey')}</Kbd>
          {t('composer.escToStop.after')}
        </span>
      )}
    </div>
  )
}

function PermissionMenu() {
  const { t } = useTranslation('session')
  const mode = useSessionStore((s) => s.settings?.permissionMode) ?? DEFAULT_PERMISSION_MODE
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const Icon = PERMISSION_ICONS[mode]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('composer.permission.label', { mode: t(`composer.permission.${mode}`) })}
        className="flex h-7 items-center gap-1.5 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover [&_svg]:size-3.5"
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

function ModelMenu({
  sessionId,
  model,
  fixed,
}: {
  readonly sessionId: string
  readonly model: ModelRef | undefined
  /** Agent 固定了模型（M3-12）：显示当前模型并禁用。 */
  readonly fixed: boolean
}) {
  const { t } = useTranslation('session')
  const providers = useSessionStore((s) => s.settings?.providers) ?? []
  const setSessionModel = useSessionStore((s) => s.setSessionModel)
  const all = providers.flatMap((provider) =>
    provider.models.map((m) => ({
      ref: { providerId: provider.id, modelId: m.id },
      provider: provider.displayName,
      name: m.displayName ?? m.id,
      enabled: m.enabled !== false,
    })),
  )
  // 停用的模型不列出（M2-10）；会话正在用的仍显示它的名称
  const options = all.filter((o) => o.enabled)
  const current = all.find((o) => sameModel(model, o.ref))
  const label = current
    ? `${current.provider} · ${current.name}`
    : (model?.modelId ?? t('composer.model.none'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={options.length === 0 || fixed}
        aria-label={t('composer.model.label', { model: label })}
        title={fixed ? t('composer.model.fixedByAgent') : undefined}
        className="flex h-7 max-w-[240px] items-center gap-1 rounded-item px-2 text-note text-fg2 outline-none hover:bg-hover disabled:opacity-60 [&_svg]:size-3.5"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-faint">{t('composer.model.title')}</DropdownMenuLabel>
        {options.map((option, index) => (
          <Fragment key={`${option.ref.providerId}/${option.ref.modelId}`}>
            {options[index - 1]?.ref.providerId !== option.ref.providerId && (
              <DropdownMenuLabel className="pt-2">{option.provider}</DropdownMenuLabel>
            )}
            <DropdownMenuItem
              onSelect={() => {
                if (!sameModel(model, option.ref)) void setSessionModel(sessionId, option.ref)
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
        className="flex size-7 items-center justify-center rounded-item outline-none"
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

export function Composer({ sessionId, status, run, agent, model, contextTokens }: ComposerProps) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const sendPrompt = useSessionStore((s) => s.sendPrompt)
  const compactSession = useSessionStore((s) => s.compactSession)
  const abort = useSessionStore((s) => s.abort)
  const agents = useSessionStore((s) => s.agents) ?? []
  const fixedAgentModel =
    agent !== undefined && agents.find((item) => item.agentId === agent.id)?.modelMode === 'fixed'
  const [text, setText] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const active = status === 'running' || status === 'waiting_approval'
  const stopping = run?.state === 'aborting'
  const canSend = !active && !sending && text.trim() !== ''

  // 自动增高
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [text])

  const send = async () => {
    if (!canSend) return
    const draft = text
    setText('')
    setSending(true)
    // /compact 立刻压缩，不作为用户消息发给模型。
    const sent =
      draft.trim() === '/compact'
        ? await compactSession()
        : await sendPrompt(draft, planMode ? 'plan' : 'normal')
    setSending(false)
    if (!sent) setText((current) => (current === '' ? draft : current))
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
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      event.preventDefault()
      void stopRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canStop])

  // Shift+Tab 在正常 / 计划之间切换。对话框、菜单和其他输入框里不抢焦点。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
        return
      if (event.defaultPrevented) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest('[role="dialog"], [role="menu"]')) return
      const field = target.closest('input, textarea, [contenteditable="true"]')
      if (field && field !== textarea.current) return
      event.preventDefault()
      setPlanMode((on) => !on)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <div>
      <RunBar status={status} run={run} />
      <form
        onSubmit={submit}
        onClick={(e) => {
          if (e.target === e.currentTarget) textarea.current?.focus()
        }}
        className="rounded-input bg-raise px-3.5 pt-3.5 pb-2.5 shadow-2"
      >
        <textarea
          ref={textarea}
          rows={1}
          aria-label={t('input.label')}
          placeholder={planMode ? t('composer.plan.placeholder') : t('input.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyDown}
          className="block max-h-[200px] min-h-6 w-full resize-none bg-transparent px-1 text-body text-fg outline-none placeholder:text-faint"
        />
        <div className="mt-2 flex items-center gap-1">
          <AgentPicker sessionId={sessionId} agent={agent} disabled={active} />
          <PermissionMenu />
          <button
            type="button"
            aria-pressed={planMode}
            aria-label={t('composer.plan.label')}
            title={t('composer.plan.hint')}
            onClick={() => setPlanMode((on) => !on)}
            className={cn(
              'flex h-7 items-center gap-1 rounded-item px-2 text-ui',
              planMode ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover',
            )}
          >
            <ListChecks className="size-3.5" />
            {t('composer.plan.toggle')}
          </button>
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <ModelMenu
              sessionId={sessionId}
              model={model}
              fixed={agent !== undefined && run?.agent.id === agent.id && fixedAgentModel}
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
                  'flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-fg transition-opacity hover:opacity-85 disabled:opacity-45',
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
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-fg transition-opacity hover:opacity-85 disabled:opacity-25"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
