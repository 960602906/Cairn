/**
 * 输入框（M2-04，视觉规范 §6）：悬浮在纸面底部的卡片。
 *
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
import type { AgentDefinitionRef, ModelRef, PermissionMode, SessionStatus } from '@cairn/protocol'
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
}

/** 文本框最高（px），超过后滚动。 */
const MAX_TEXTAREA_HEIGHT = 200

const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask'
const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'ask', 'auto']
const PERMISSION_ICONS = { 'read-only': Eye, ask: ShieldCheck, auto: Zap } as const

const sameModel = (a: ModelRef | undefined, b: ModelRef) =>
  a?.providerId === b.providerId && a.modelId === b.modelId

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

export function Composer({
  sessionId,
  status,
  run,
  agent,
  model,
  projectPath,
  contextTokens,
}: ComposerProps) {
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
      <WorkspaceGitBar projectPath={projectPath} />
      <form
        onSubmit={submit}
        onClick={(e) => {
          if (e.target === e.currentTarget) textarea.current?.focus()
        }}
        className="rounded-[14px] border border-hair2 bg-raise px-3.5 pt-3 pb-2.5 shadow-2 transition-colors focus-within:border-accent/60"
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
                  'flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg transition-opacity hover:opacity-85 disabled:opacity-45',
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
                className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-ink text-ink-fg transition-opacity hover:opacity-85 disabled:opacity-25"
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
