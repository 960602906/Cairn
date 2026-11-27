/**
 * 设置页“模型供应商”（M2-10、ADR-0049）。
 *
 * - 顶部按接口格式分标签（Anthropic / OpenAI / Gemini），标签右侧“添加供应商”。
 * - 每个标签下是供应商卡片；点名称或编辑按钮打开弹窗，删除也在卡片上。
 * - 添加时从目录选服务，按“模型厂商 / 聚合平台与中转 / 本机运行”分组，不必先知道接口格式：
 *   目录项预填地址、接口格式、名称与兼容参数，用户通常只需粘贴 Key。没有预置模型的服务在填入 Key 后
 *   自动拉取模型列表并启用建议的模型。“自定义”仍可接入任意 OpenAI / Anthropic / Gemini 兼容地址。
 *   目录可由供应商插件（只有数据的 JSON 文件）扩展，插件在同一个对话框里安装与卸载。
 * - 弹窗保持单栏：名称、Base URL（有多个接入点时可切换国际 / 中国大陆）、Key、测试连接，然后是模型列表。
 *   拉取到的模型与已配置的模型合并在同一个列表里，每行一个开关；展开某一行才显示
 *   上下文、输出上限与默认模型，显示名称和能力再收在“更多设置”里。
 *   拉取结果保存在配置中，下次打开直接显示，不用重新拉取；手动添加收在列表底部。
 * - 测试连接默认只测一个模型（默认模型或第一个启用的）；测试全部模型要再确认一次，避免消耗额度或触发限流。
 * - 保存时先写 Key，Key 写入失败就不改设置；设置写入失败时撤回刚写入的新 Key，并就地说明。
 * - 有未保存的改动（包括新填的 Key）时，关闭弹窗要先确认。
 * - 高级兼容参数收在编辑弹窗底部的折叠区，不再让用户先理解“来源/兼容哪家”。
 */
import {
  findTemplateIn,
  keysUrlFor,
  regionOf,
  suggestedModelIds,
  type ProviderTemplate,
} from '@cairn/core'
import type {
  ErrorInfo,
  ModelCompat,
  ModelProfile,
  ProviderConfig,
  ProviderKind,
  ProviderPluginInfo,
  RemoteModel,
  ThinkingFormat,
} from '@cairn/protocol'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  FileUp,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { translateError } from '@cairn/i18n'
import { useTranslation } from 'react-i18next'
import type { CredentialStatus, ProviderTestResult } from '../session-store.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  IconButton,
  SegmentedControl,
  Spinner,
  Switch,
} from '../ui/index.js'
import { inputClass, selectClass, SettingsCard } from './Field.js'
import { DeepseekIcon, ProviderBrandIcon } from './ProviderBrandIcon.js'
import {
  BRAND_TEMPLATES,
  catalogGroups,
  catalogOf,
  configOf,
  credentialRefFor,
  draftOf,
  enabledModelIdsOf,
  formatTokens,
  genericDraftFor,
  hostOf,
  initials,
  LOCAL_AUTO_ENABLE_LIMIT,
  modelRowsOf,
  newDraftForTemplate,
  problemsOf,
  profileFrom,
  slugId,
  sourceOf,
  templatesOf,
  testTargetOf,
  uniqueProviderId,
  type ModelRow,
  type ProviderDraft,
} from './providers-model.js'
import { SettingsHeader } from './SettingsPage.js'

type KeyStatus = CredentialStatus
type TestResult = ProviderTestResult

/** 一次连接测试：逐个启用的模型的结果。 */
type TestOutcome = { readonly modelId: string; readonly result: TestResult }
type TestSummary = readonly TestOutcome[]

/** 失败的那些模型；测试请求本身失败（没有结果）的模型不在里面。 */
function failuresOf(outcomes: TestSummary | undefined) {
  return (outcomes ?? []).flatMap((outcome) =>
    outcome.result.ok
      ? []
      : [{ modelId: outcome.modelId, error: outcome.result.error as ErrorInfo }],
  )
}

const KINDS: readonly ProviderKind[] = ['anthropic', 'openai', 'gemini']
const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'] as const
const THINKING_FORMATS: readonly ThinkingFormat[] = [
  'openai',
  'deepseek',
  'qwen',
  'openrouter',
  'zai',
]

function useErrorText() {
  const { i18n } = useTranslation()
  return (error: ErrorInfo) => translateError(i18n, error)
}

function Logo({
  name,
  kind,
  template,
  size = 32,
}: {
  readonly name: string
  readonly kind: ProviderKind
  readonly template?: string | undefined
  readonly size?: number
}) {
  return (
    <span
      aria-hidden
      title={name}
      className="inline-grid shrink-0 place-items-center rounded-[9px] bg-paper text-fg shadow-[inset_0_0_0_0.5px_var(--hair2)]"
      style={{
        width: size,
        height: size,
      }}
    >
      {template === 'deepseek' ? (
        <DeepseekIcon className="w-[68%]" />
      ) : template !== undefined && !BRAND_TEMPLATES.has(template) ? (
        <span
          className="leading-none font-semibold tracking-tight text-fg2"
          style={{ fontSize: Math.round(size * 0.36) }}
        >
          {initials(name)}
        </span>
      ) : (
        <ProviderBrandIcon kind={kind} className="size-[58%]" />
      )}
    </span>
  )
}

const TAG_TONE = { ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn' } as const

function Tag({ tone, children }: { tone: keyof typeof TAG_TONE; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] font-medium whitespace-nowrap',
        TAG_TONE[tone],
      )}
    >
      {children}
    </span>
  )
}

const STATUS_DOT = { ok: 'bg-ok', danger: 'bg-danger' } as const

function Status({ tone, children }: { tone: keyof typeof STATUS_DOT; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn('size-1.5 rounded-full', STATUS_DOT[tone])} />
      {children}
    </span>
  )
}

function Labeled({
  label,
  labelFor,
  hint,
  action,
  className,
  children,
}: {
  readonly label: string
  readonly labelFor?: string
  readonly hint?: ReactNode
  /** 标签行右侧的操作（如“获取 Key”链接）。 */
  readonly action?: ReactNode
  readonly className?: string
  readonly children: ReactNode
}) {
  const text = <span className="text-[12.5px] font-medium text-fg2">{label}</span>
  const head = labelFor ? (
    <label htmlFor={labelFor} className="contents">
      {text}
    </label>
  ) : (
    text
  )
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {action ? (
        <div className="flex items-center justify-between gap-2">
          {head}
          {action}
        </div>
      ) : (
        head
      )}
      {children}
      {hint && <p className="text-note leading-relaxed text-muted">{hint}</p>}
    </div>
  )
}

function DeleteProvider({
  name,
  compact = false,
  onConfirm,
}: {
  readonly name: string
  readonly compact?: boolean
  readonly onConfirm: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  return (
    <Dialog>
      <DialogTrigger asChild>
        {compact ? (
          <IconButton
            label={t('providers.delete.button')}
            size="icon-sm"
            className="text-muted hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 />
          </IconButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 />
            {t('providers.delete.button')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent tone="danger" icon={<Trash2 />}>
        <DialogTitle>{t('providers.delete.title', { name })}</DialogTitle>
        <DialogDescription>{t('providers.delete.description')}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{tc('action.cancel')}</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="danger" onClick={onConfirm}>
              {t('providers.delete.confirm')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProviderCard({
  provider,
  isDefault,
  keyStatus,
  result,
  onEdit,
  onDelete,
}: {
  readonly provider: ProviderConfig
  readonly isDefault: boolean
  readonly keyStatus: KeyStatus | undefined
  readonly result: TestSummary | undefined
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const enabled = provider.models.filter((model) => model.enabled !== false).length
  const missingKey = provider.credentialRef !== undefined && keyStatus?.configured === false
  const failed = failuresOf(result)
  return (
    <li className="group flex items-center gap-3 rounded-card bg-raise px-4 py-3 shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)] transition-colors hover:bg-sunk">
      <Logo
        name={provider.displayName}
        kind={provider.kind}
        template={provider.template}
        size={34}
      />
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[14px] font-medium text-fg">
          {provider.displayName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted">
          {provider.baseUrl || t('providers.card.noUrl')}
          <span className="font-sans">
            {' · '}
            {t('providers.card.modelCount', {
              count: provider.models.length,
              enabled,
            })}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-2.5 text-note text-muted">
        {isDefault && <Tag tone="ok">{t('providers.default')}</Tag>}
        {missingKey && <Tag tone="warn">{t('providers.noKey')}</Tag>}
        {result &&
          (failed.length > 0 ? (
            <Status tone="danger">{t('providers.status.failed')}</Status>
          ) : (
            <Status tone="ok">{t('providers.status.ok')}</Status>
          ))}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <IconButton label={t('providers.edit')} size="icon-sm" onClick={onEdit}>
          <SquarePen />
        </IconButton>
        <DeleteProvider compact name={provider.displayName} onConfirm={onDelete} />
      </span>
    </li>
  )
}

function KindTabs({
  value,
  counts,
  onChange,
}: {
  readonly value: ProviderKind
  readonly counts: Readonly<Record<ProviderKind, number>>
  readonly onChange: (kind: ProviderKind) => void
}) {
  const { t } = useTranslation('settings')
  // 按 WAI-ARIA 的 tabs 模式：← / → 在接口格式间移动并切换，Home / End 跳到两端。
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const selected = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true')
    const from = current === -1 ? Math.max(selected, 0) : current
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowLeft'
            ? (from - 1 + buttons.length) % buttons.length
            : (from + 1) % buttons.length
    buttons[next]?.focus()
    const kind = KINDS[next]
    if (kind !== undefined && kind !== value) onChange(kind)
  }
  return (
    <div
      role="tablist"
      aria-label={t('providers.field.kind')}
      onKeyDown={keyDown}
      className="flex min-w-0 flex-wrap items-center gap-1 rounded-item bg-sunk2 p-0.5"
    >
      {KINDS.map((kind) => {
        const selected = kind === value
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(kind)}
            className={cn(
              'inline-flex h-8 items-center gap-2 rounded-[7px] px-3 text-[12.5px] text-muted transition-colors hover:text-fg',
              selected && 'bg-raise font-medium text-fg shadow-1',
            )}
          >
            <span aria-hidden className="flex size-4 items-center justify-center text-fg">
              <ProviderBrandIcon kind={kind} className="size-3.5" />
            </span>
            {t(`providers.kind.${kind}.name`)}
            <span className="tabular text-[11px] text-faint">{counts[kind]}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 不可用的具体原因对应的文案 key（M6-04）；未知原因回退到通用说明。 */
function unavailableHintKey(reason: CredentialStatus['reason']): string {
  switch (reason) {
    case 'insecure-linux-backend':
    case 'unknown-linux-backend':
    case 'system-encryption-unavailable':
      return `providers.key.unavailable.${reason}`
    default:
      return 'providers.key.unavailable'
  }
}

function KeysLink({ href }: { readonly href: string }) {
  const { t } = useTranslation('settings')
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-note text-muted transition-colors hover:text-fg [&_svg]:size-3"
    >
      {t('providers.key.getKey')}
      <ExternalLink />
    </a>
  )
}

function KeyField({
  status,
  secret,
  optional = false,
  keysUrl,
  autoFocus = false,
  onSecret,
}: {
  readonly status: KeyStatus | undefined
  readonly secret: string | undefined
  /** 本机服务通常不需要 Key。 */
  readonly optional?: boolean
  readonly keysUrl?: string | undefined
  readonly autoFocus?: boolean
  readonly onSecret: (secret: string | undefined) => void
}) {
  const { t } = useTranslation('settings')
  const id = useId()
  const unavailable = status?.available === false
  const action = keysUrl ? <KeysLink href={keysUrl} /> : undefined
  if (status?.configured && secret === undefined) {
    return (
      <Labeled label={t('providers.field.key')} action={action}>
        <div className={cn(inputClass, 'flex items-center gap-2 pr-1 font-mono text-[13px]')}>
          <span className="flex-1 truncate">
            {status.last4 ? t('providers.key.masked', { last4: status.last4 }) : '••••••••'}
          </span>
          <span className="font-sans text-note whitespace-nowrap text-muted">
            {t('providers.key.saved')}
          </span>
          <Button variant="ghost" size="sm" className="h-[26px]" onClick={() => onSecret('')}>
            {t('providers.key.replace')}
          </Button>
        </div>
      </Labeled>
    )
  }
  return (
    <Labeled
      label={t('providers.field.key')}
      labelFor={id}
      action={action}
      hint={
        unavailable
          ? t(unavailableHintKey(status?.reason))
          : optional
            ? t('providers.key.optionalHint')
            : t('providers.key.hint')
      }
    >
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={unavailable}
          data-autofocus={autoFocus || undefined}
          value={secret ?? ''}
          placeholder={
            optional ? t('providers.key.optionalPlaceholder') : t('providers.key.placeholder')
          }
          onChange={(e) => onSecret(e.target.value)}
          className={cn(inputClass, 'font-mono text-[13px]')}
        />
        {status?.configured && (
          <Button variant="ghost" size="sm" onClick={() => onSecret(undefined)}>
            {t('providers.key.keep')}
          </Button>
        )}
      </div>
    </Labeled>
  )
}

/** 测试全部已启用的模型：每个模型各发一次请求，先确认。 */
function TestAllButton({
  count,
  disabled,
  onConfirm,
}: {
  readonly count: number
  readonly disabled: boolean
  readonly onConfirm: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          {t('providers.test.all', { count })}
        </Button>
      </DialogTrigger>
      <DialogContent icon={<TriangleAlert />}>
        <DialogTitle>{t('providers.test.allTitle', { count })}</DialogTitle>
        <DialogDescription>{t('providers.test.allDescription')}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{tc('action.cancel')}</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="primary" onClick={onConfirm}>
              {t('providers.test.allConfirm')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TestBar({
  outcomes,
  testing,
  progress,
  disabled,
  enabledCount,
  onTest,
  onTestAll,
}: {
  readonly outcomes: TestSummary | undefined
  readonly testing: boolean
  readonly progress: { readonly done: number; readonly total: number } | undefined
  readonly disabled: boolean
  readonly enabledCount: number
  readonly onTest: () => void
  readonly onTestAll: () => void
}) {
  const { t } = useTranslation('settings')
  const errorText = useErrorText()
  const failures = failuresOf(outcomes)
  const latencyMs = (outcomes ?? []).reduce(
    (slowest, outcome) => Math.max(slowest, outcome.result.latencyMs ?? 0),
    0,
  )
  const total = outcomes?.length ?? 0
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] text-fg2',
        outcomes === undefined || testing
          ? 'bg-sunk'
          : failures.length === 0
            ? 'bg-ok-soft'
            : 'bg-danger-soft',
      )}
    >
      {testing ? (
        <>
          <Spinner />
          <span>
            {t('providers.test.running', {
              done: progress?.done ?? 0,
              total: progress?.total ?? 0,
            })}
          </span>
        </>
      ) : outcomes === undefined ? (
        <span className="text-muted">{t('providers.test.idle')}</span>
      ) : failures.length === 0 ? (
        <>
          <Check className="size-3.5 text-ok" strokeWidth={2.2} />
          <span className="min-w-0">
            <b className="font-medium text-ok">
              {total === 1 ? t('providers.test.okOne') : t('providers.test.ok', { count: total })}
            </b>
            {' · '}
            {total === 1
              ? t('providers.test.okModel', { name: outcomes[0]!.modelId, ms: latencyMs })
              : t('providers.test.latency', { ms: latencyMs })}
          </span>
        </>
      ) : (
        <>
          <TriangleAlert className="size-3.5 shrink-0 text-danger" />
          <span className="min-w-0">
            <b className="font-medium text-danger">
              {total === 1
                ? t('providers.test.failedOne')
                : t('providers.test.failed', { failed: failures.length, total })}
            </b>
            {' · '}
            {t('providers.test.failedModel', {
              name: failures[0]!.modelId,
              reason: errorText(failures[0]!.error),
            })}
            {failures.length > 1 && ` ${t('providers.test.more', { count: failures.length - 1 })}`}
          </span>
        </>
      )}
      <span className="flex-1" />
      {enabledCount > 1 && (
        <TestAllButton count={enabledCount} disabled={disabled || testing} onConfirm={onTestAll} />
      )}
      <Button variant="ghost" size="sm" disabled={disabled || testing} onClick={onTest}>
        {outcomes === undefined ? t('providers.test.run') : t('providers.test.again')}
      </Button>
    </div>
  )
}

/** 添加供应商时选中的服务：目录项带模板 id，自定义只有接口格式。 */
type AddChoice = { readonly kind: ProviderKind; readonly template?: string }

const pickRowClass =
  'flex w-full items-center gap-2.5 rounded-[9px] bg-sunk px-2.5 py-2 text-left transition-colors hover:bg-hover'

function SmallTag({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-[17px] shrink-0 items-center rounded-[5px] bg-paper px-1.5 text-[10.5px] font-medium whitespace-nowrap text-muted shadow-[inset_0_0_0_0.5px_var(--hair2)]">
      {children}
    </span>
  )
}

function ServiceTile({
  template,
  pluginName,
  onPick,
}: {
  readonly template: ProviderTemplate
  readonly pluginName: string | undefined
  readonly onPick: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <li>
      <button type="button" onClick={onPick} className={pickRowClass}>
        <Logo name={template.displayName} kind={template.kind} template={template.id} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-fg">
            {template.displayName}
          </span>
          <span className="block truncate font-mono text-[11.5px] text-muted">
            {hostOf(template.baseUrl)}
          </span>
        </span>
        {pluginName !== undefined && <SmallTag>{t('providers.add.pluginTag')}</SmallTag>}
        {!template.requiresKey && <SmallTag>{t('providers.add.noKeyTag')}</SmallTag>}
        <ChevronRight className="size-4 shrink-0 text-faint" />
      </button>
    </li>
  )
}

function RemovePlugin({
  plugin,
  onConfirm,
}: {
  readonly plugin: ProviderPluginInfo
  readonly onConfirm: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  return (
    <Dialog>
      <DialogTrigger asChild>
        <IconButton
          label={t('providers.plugins.remove', { name: plugin.name })}
          size="icon-sm"
          className="text-muted hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 />
        </IconButton>
      </DialogTrigger>
      <DialogContent tone="danger" icon={<Trash2 />}>
        <DialogTitle>{t('providers.plugins.removeTitle', { name: plugin.name })}</DialogTitle>
        <DialogDescription>{t('providers.plugins.removeDescription')}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{tc('action.cancel')}</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="danger" onClick={onConfirm}>
              {t('providers.plugins.removeConfirm')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 供应商插件（ADR-0049）：列出已安装的插件与无法加载的文件；从文件安装时先预览其中的服务与地址，
 * 确认后才写入插件目录。
 */
function ProviderPlugins() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const errorText = useErrorText()
  const list = useSessionStore((s) => s.providerPlugins)
  const pick = useSessionStore((s) => s.pickProviderPlugin)
  const install = useSessionStore((s) => s.installProviderPlugin)
  const remove = useSessionStore((s) => s.removeProviderPlugin)
  const [preview, setPreview] = useState<
    | { readonly path: string; readonly plugin: ProviderPluginInfo; readonly replaces: boolean }
    | undefined
  >()
  const [failure, setFailure] = useState<ErrorInfo | undefined>()
  const [busy, setBusy] = useState(false)
  const plugins = list?.plugins ?? []
  const skipped = list?.skipped ?? []

  const choose = async () => {
    setFailure(undefined)
    const path = await pick()
    if (path === undefined) return
    const outcome = await install(path)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    setPreview({ path, plugin: outcome.result.plugin, replaces: outcome.result.replaces })
  }

  const confirm = async () => {
    if (!preview) return
    setBusy(true)
    const outcome = await install(preview.path, true)
    setBusy(false)
    setPreview(undefined)
    if (!outcome.ok) setFailure(outcome.error)
  }

  return (
    <section aria-label={t('providers.plugins.title')} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-[11.5px] font-medium text-muted">{t('providers.plugins.title')}</h3>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="h-7" onClick={() => void choose()}>
          <FileUp />
          {t('providers.plugins.install')}
        </Button>
      </div>
      <p className="px-1 text-note leading-relaxed text-muted">{t('providers.plugins.hint')}</p>
      {failure !== undefined && (
        <p
          role="alert"
          className="rounded-[9px] bg-danger-soft px-2.5 py-1.5 text-note text-danger"
        >
          {t('providers.plugins.installFailed', { reason: errorText(failure) })}
        </p>
      )}
      {(plugins.length > 0 || skipped.length > 0) && (
        <ul aria-label={t('providers.plugins.list')} className="flex flex-col gap-1">
          {plugins.map((plugin) => (
            <li
              key={plugin.id}
              className="flex items-center gap-2.5 rounded-[9px] bg-sunk px-2.5 py-1.5"
            >
              <Puzzle className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {plugin.name}
                  {plugin.version && (
                    <span className="ml-1.5 font-normal text-faint">
                      {t('providers.plugins.version', { version: plugin.version })}
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11.5px] text-muted">
                  {t('providers.plugins.services', { count: plugin.templates.length })}
                  {plugin.description ? ` · ${plugin.description}` : ''}
                </span>
              </span>
              <RemovePlugin plugin={plugin} onConfirm={() => void remove(plugin.id)} />
            </li>
          ))}
          {skipped.map((item) => (
            <li
              key={item.file}
              className="flex items-center gap-2.5 rounded-[9px] bg-warn-soft px-2.5 py-1.5 text-note text-warn"
            >
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t('providers.plugins.skipped', {
                  file: item.file,
                  reason: errorText({ code: item.code }),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={preview !== undefined} onOpenChange={(next) => !next && setPreview(undefined)}>
        <DialogContent icon={<Puzzle />}>
          <DialogTitle>
            {t('providers.plugins.previewTitle', { name: preview?.plugin.name ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('providers.plugins.previewDescription')}</DialogDescription>
          <ul
            aria-label={t('providers.plugins.previewList')}
            className="mt-4 flex max-h-64 flex-col gap-1 overflow-y-auto"
          >
            {preview?.plugin.templates.map((template) => (
              <li key={template.id} className="rounded-[9px] bg-sunk px-2.5 py-1.5">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {template.displayName}
                  <span className="ml-1.5 font-normal text-faint">
                    {t(`providers.kind.${template.kind}.name`)}
                  </span>
                </span>
                <span className="block truncate font-mono text-[11.5px] text-muted">
                  {template.baseUrl}
                </span>
              </li>
            ))}
          </ul>
          {preview?.replaces && (
            <p className="mt-3 text-note text-warn">{t('providers.plugins.previewReplaces')}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button>{tc('action.cancel')}</Button>
            </DialogClose>
            <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
              {t('providers.plugins.installConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/**
 * 添加供应商：从目录选服务，按“模型厂商 / 聚合平台与中转 / 本机运行”分组，可搜索。
 *
 * 点目录项直接用模板预填地址、接口格式、模型与兼容参数，进入编辑弹窗后通常只需粘贴 Key；
 * 点“自定义”的某种接口格式得到空白草稿。每一行都是普通按钮，单击（或键盘 Enter / 空格）就进入编辑弹窗，
 * 没有“先选中再下一步”。底部是供应商插件的安装与管理。
 */
function AddProviderDialog({
  open,
  catalog,
  plugins,
  onPick,
  onClose,
}: {
  readonly open: boolean
  readonly catalog: readonly ProviderTemplate[]
  readonly plugins: readonly ProviderPluginInfo[]
  readonly onPick: (choice: AddChoice) => void
  readonly onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const groups = catalogGroups(catalog, query)
  const pluginNames = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-48px)] w-[min(640px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0">
        <header className="shrink-0 px-6 pt-5 pb-3">
          <DialogTitle>{t('providers.add.pickService')}</DialogTitle>
          <DialogDescription>{t('providers.add.pickServiceHint')}</DialogDescription>
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <input
              type="search"
              aria-label={t('providers.add.search')}
              placeholder={t('providers.add.search')}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              className={cn(inputClass, 'pl-8')}
            />
          </div>
        </header>
        <div
          role="group"
          aria-label={t('providers.add.serviceList')}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-5"
        >
          {groups.map((group) => (
            <section key={group.category} className="flex flex-col gap-1.5">
              <h3 className="px-1 text-[11.5px] font-medium text-muted">
                {t(`providers.category.${group.category}`)}
              </h3>
              <ul className="grid gap-1 sm:grid-cols-2">
                {group.templates.map((template) => (
                  <ServiceTile
                    key={template.id}
                    template={template}
                    pluginName={
                      template.pluginId !== undefined
                        ? (pluginNames.get(template.pluginId) ?? template.pluginId)
                        : undefined
                    }
                    onPick={() => onPick({ kind: template.kind, template: template.id })}
                  />
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="px-1 py-2 text-note text-muted">{t('providers.add.noMatch')}</p>
          )}
          <section className="flex flex-col gap-1.5">
            <h3 className="px-1 text-[11.5px] font-medium text-muted">
              {t('providers.add.customGroup')}
            </h3>
            <ul className="grid gap-1 sm:grid-cols-3">
              {KINDS.map((kind) => (
                <li key={kind}>
                  <button
                    type="button"
                    aria-label={t('providers.add.genericFor', {
                      format: t(`providers.kind.${kind}.name`),
                    })}
                    onClick={() => onPick({ kind })}
                    className={pickRowClass}
                  >
                    <span
                      aria-hidden
                      className="inline-grid size-7 shrink-0 place-items-center rounded-[8px] bg-paper text-muted shadow-[inset_0_0_0_0.5px_var(--hair2)]"
                    >
                      <Plus className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">
                        {t('providers.add.compatible', {
                          format: t(`providers.kind.${kind}.name`),
                        })}
                      </span>
                      <span className="block truncate text-[11.5px] text-muted">
                        {t(`providers.kind.${kind}.api`)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="px-1 text-note text-muted">{t('providers.add.genericHint')}</p>
          </section>
          <ProviderPlugins />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  readonly label: string
  readonly value: number
  readonly onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const next = Number(text)
    if (Number.isInteger(next) && next > 0) onCommit(next)
    else setText(String(value))
  }
  return (
    <Labeled label={label}>
      <input
        aria-label={label}
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        className={cn(inputClass, 'font-mono text-[12.5px]')}
      />
    </Labeled>
  )
}

function CapabilityRow({
  label,
  checked,
  onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[12.5px] text-fg2">{label}</span>
      <Switch checked={checked} aria-label={label} onCheckedChange={onChange} />
    </div>
  )
}

/** 展开某个模型后的设置：常用项直接可见，显示名称与能力收在“更多设置”里。 */
function ModelSettings({
  model,
  isDefault,
  onChange,
  onDefault,
  onRemove,
}: {
  readonly model: ModelProfile
  readonly isDefault: boolean
  readonly onChange: (patch: Partial<ModelProfile>) => void
  readonly onDefault: () => void
  readonly onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const [more, setMore] = useState(false)
  return (
    <div className="border-t border-hair bg-sunk/60 px-3 py-3">
      <div className="grid grid-cols-2 gap-2.5">
        <NumberField
          label={t('providers.model.contextLength')}
          value={model.contextWindow}
          onCommit={(contextWindow) => onChange({ contextWindow })}
        />
        <NumberField
          label={t('providers.model.maxOutput')}
          value={model.maxOutputTokens}
          onCommit={(maxOutputTokens) => onChange({ maxOutputTokens })}
        />
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={isDefault}
          onClick={onDefault}
          className="justify-start"
        >
          <Check />
          {isDefault ? t('providers.model.isDefault') : t('providers.model.setDefault')}
        </Button>
        <span className="flex-1" />
        <IconButton
          label={t('providers.model.remove', { name: model.displayName ?? model.id })}
          size="icon-sm"
          disabled={isDefault}
          onClick={onRemove}
        >
          <Trash2 />
        </IconButton>
      </div>
      {isDefault && (
        <p className="text-note leading-relaxed text-muted">{t('providers.model.defaultHint')}</p>
      )}
      <button
        type="button"
        aria-expanded={more}
        onClick={() => setMore((value) => !value)}
        className="mt-1 flex w-fit items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', more && 'rotate-90')} />
        {t('providers.model.more')}
      </button>
      {more && (
        <div className="mt-2.5 flex flex-col gap-3">
          <Labeled label={t('providers.model.displayName')}>
            <input
              aria-label={t('providers.model.displayName')}
              value={model.displayName ?? ''}
              placeholder={model.id}
              onChange={(event) => onChange({ displayName: event.target.value })}
              className={inputClass}
            />
          </Labeled>
          <div className="rounded-[10px] bg-paper px-3 py-1 shadow-[inset_0_0_0_0.5px_var(--hair2)]">
            <CapabilityRow
              label={t('providers.model.tools')}
              checked={model.supportsTools}
              onChange={(supportsTools) => onChange({ supportsTools })}
            />
            <CapabilityRow
              label={t('providers.model.parallel')}
              checked={model.supportsParallelToolCalls}
              onChange={(supportsParallelToolCalls) => onChange({ supportsParallelToolCalls })}
            />
            <CapabilityRow
              label={t('providers.model.reasoning')}
              checked={model.supportsReasoning}
              onChange={(supportsReasoning) => onChange({ supportsReasoning })}
            />
            {model.supportsReasoning && (
              <div className="mt-1 border-t border-hair pt-2 pb-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12.5px] text-fg2">
                    {t('providers.model.thinkingLevel')}
                  </span>
                  <SegmentedControl
                    label={t('providers.model.thinkingLevel')}
                    value={model.thinkingLevel ?? 'high'}
                    options={[
                      { value: 'low', label: t('providers.model.thinkingLevel.low') },
                      { value: 'medium', label: t('providers.model.thinkingLevel.medium') },
                      { value: 'high', label: t('providers.model.thinkingLevel.high') },
                    ]}
                    onChange={(thinkingLevel) => onChange({ thinkingLevel })}
                  />
                </div>
                <p className="mt-1 text-note text-faint">
                  {t('providers.model.thinkingLevel.hint')}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ManualModel({
  onAdd,
  defaultContext,
}: {
  readonly onAdd: (model: RemoteModel) => void
  readonly defaultContext: number
}) {
  const { t } = useTranslation('settings')
  const [id, setId] = useState('')
  const [context, setContext] = useState(String(defaultContext))
  const contextValue = Number(context)
  const valid = id.trim() !== '' && Number.isInteger(contextValue) && contextValue > 0
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={t('providers.manual.id')}
        placeholder={t('providers.manual.id')}
        value={id}
        spellCheck={false}
        onChange={(e) => setId(e.target.value)}
        className={cn(inputClass, 'h-8 flex-1 font-mono text-[12.5px]')}
      />
      <input
        aria-label={t('providers.manual.context')}
        inputMode="numeric"
        value={context}
        onChange={(e) => setContext(e.target.value.replace(/[^\d]/g, ''))}
        className={cn(inputClass, 'h-8 w-24 font-mono text-[12.5px]')}
      />
      <Button
        size="sm"
        disabled={!valid}
        onClick={() => {
          onAdd({ id: id.trim(), contextWindow: contextValue })
          setId('')
        }}
      >
        {t('providers.manual.add')}
      </Button>
    </div>
  )
}

function CompatOptions({
  compat,
  onChange,
}: {
  readonly compat: ModelCompat | undefined
  readonly onChange: (compat: ModelCompat) => void
}) {
  const { t } = useTranslation('settings')
  const set = <K extends keyof ModelCompat>(key: K, value: ModelCompat[K] | undefined) => {
    const next: Record<string, unknown> = { ...compat }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange(next as ModelCompat)
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Labeled label={t('providers.compat.thinkingFormat')}>
        <select
          aria-label={t('providers.compat.thinkingFormat')}
          className={cn(selectClass, 'h-8 text-[13px]')}
          value={compat?.thinkingFormat ?? ''}
          onChange={(e) =>
            set('thinkingFormat', (e.target.value || undefined) as ThinkingFormat | undefined)
          }
        >
          <option value="">{t('providers.compat.auto')}</option>
          {THINKING_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label={t('providers.compat.maxTokensField')}>
        <select
          aria-label={t('providers.compat.maxTokensField')}
          className={cn(selectClass, 'h-8 text-[13px]')}
          value={compat?.maxTokensField ?? ''}
          onChange={(e) =>
            set('maxTokensField', (e.target.value || undefined) as ModelCompat['maxTokensField'])
          }
        >
          <option value="">{t('providers.compat.auto')}</option>
          {MAX_TOKENS_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Labeled>
      {(
        [
          'requiresReasoningContentOnAssistantMessages',
          'supportsDeveloperRole',
          'supportsUsageInStreaming',
        ] as const
      ).map((key) => (
        <Labeled key={key} label={t(`providers.compat.${key}`)}>
          <SegmentedControl
            label={t(`providers.compat.${key}`)}
            value={compat?.[key] === undefined ? 'auto' : compat[key] ? 'yes' : 'no'}
            options={[
              { value: 'auto', label: t('providers.compat.auto') },
              { value: 'yes', label: t('providers.compat.yes') },
              { value: 'no', label: t('providers.compat.no') },
            ]}
            onChange={(v) => set(key, v === 'auto' ? undefined : v === 'yes')}
          />
        </Labeled>
      ))}
    </div>
  )
}

function ProviderEditor({
  saved,
  initialDraft,
  providers,
  catalog,
  keyStatus,
  result,
  onResult,
  onSaved,
  onCancel,
}: {
  readonly saved: ProviderConfig | undefined
  readonly initialDraft: ProviderDraft
  readonly providers: readonly ProviderConfig[]
  /** 内置加插件的目录：用于查找模板（默认能力、建议模型、接入点）。 */
  readonly catalog: readonly ProviderTemplate[]
  readonly keyStatus: KeyStatus | undefined
  readonly result: TestSummary | undefined
  readonly onResult: (result: TestSummary | undefined) => void
  readonly onSaved: (providerId: string | undefined) => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const errorText = useErrorText()
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const saveCredential = useSessionStore((s) => s.saveCredential)
  const deleteCredential = useSessionStore((s) => s.deleteCredential)
  const testProvider = useSessionStore((s) => s.testProvider)
  const fetchModels = useSessionStore((s) => s.fetchModels)
  const credentialStatus = useSessionStore((s) => s.credentialStatus)
  const nameId = useId()
  const urlId = useId()

  const initial = useMemo(() => (saved ? draftOf(saved) : initialDraft), [saved, initialDraft])
  const [draft, setDraft] = useState<ProviderDraft>(initial)
  const [secret, setSecret] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testProgress, setTestProgress] = useState<
    { readonly done: number; readonly total: number } | undefined
  >()
  const [fetching, setFetching] = useState(false)
  const [fetchFailure, setFetchFailure] = useState<ErrorInfo | undefined>()
  const [manual, setManual] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [search, setSearch] = useState('')
  /** 用户动过草稿（新建时用来判断关闭前要不要确认；自动拉取与建议的模型不算）。 */
  const [touched, setTouched] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [saveError, setSaveError] = useState<'key' | 'settings' | 'settingsKeyKept' | undefined>()
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>()
  const [defaultModelId, setDefaultModelId] = useState<string | undefined>(() =>
    saved && settings?.defaultModel?.providerId === saved.id
      ? settings.defaultModel.modelId
      : undefined,
  )

  const [newKeyStatus, setNewKeyStatus] = useState<KeyStatus | undefined>()
  const id = saved?.id ?? uniqueProviderId(draft.template ?? slugId(draft.displayName), providers)
  useEffect(() => {
    if (saved) return
    let cancelled = false
    void credentialStatus(id).then((status) => {
      if (!cancelled) setNewKeyStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [saved, id, credentialStatus])

  const problems = problemsOf(draft)
  const valid = Object.keys(problems).length === 0
  const typedSecret = secret?.trim() ? secret.trim() : undefined
  const savedDefault =
    saved && settings?.defaultModel?.providerId === saved.id
      ? settings.defaultModel.modelId
      : undefined
  /**
   * 拉取到的模型列表已经随下拉保存过（地址与接口格式没变），就不再算作未保存的改动：
   * 拉取只是刷新缓存，不该让“保存”按钮亮起来。
   */
  const catalogIsCache =
    saved !== undefined && saved.baseUrl === draft.baseUrl.trim() && saved.kind === draft.kind
  const withoutCachedCatalog = (value: ProviderDraft) => {
    if (!catalogIsCache) return value
    const { catalog: _catalog, ...rest } = value
    return rest
  }
  const dirty =
    saved === undefined ||
    JSON.stringify(withoutCachedCatalog(draft)) !== JSON.stringify(withoutCachedCatalog(initial)) ||
    typedSecret !== undefined ||
    defaultModelId !== savedDefault
  const unsaved = saved ? dirty : touched || typedSecret !== undefined
  const templates = templatesOf(draft.kind, catalog)
  const template = findTemplateIn(catalog, draft.template)
  const region = template ? regionOf(template, draft.baseUrl.trim()) : undefined
  const keysUrl = template ? keysUrlFor(template, draft.baseUrl.trim()) : undefined
  /** 从目录新建、模板没有预置模型：填入 Key（本机服务不用）后自动拉取模型列表。 */
  const autoFetch = !saved && template !== undefined && template.models.length === 0
  const enabledCount = draft.models.filter((model) => model.enabled !== false).length
  const rows = modelRowsOf(draft.models, draft.catalog)
  const filteredRows = rows.filter((row) => {
    const query = search.trim().toLowerCase()
    if (!query) return true
    return (
      row.id.toLowerCase().includes(query) || (row.displayName ?? '').toLowerCase().includes(query)
    )
  })
  const update = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setTouched(true)
    setSaveError(undefined)
    onResult(undefined)
  }

  const requestClose = () => {
    if (busy) return
    if (unsaved) setConfirmClose(true)
    else onCancel()
  }

  /** 兼容预设：只套用兼容参数，不改地址、名称和已有模型。 */
  const applyCompatPreset = (templateId: string | undefined) => {
    const next = findTemplateIn(catalog, templateId)
    update({
      template: next?.id,
      compat: next?.compat ? { ...next.compat } : undefined,
    })
  }

  const config = (): ProviderConfig => configOf(draft, id, saved?.credentialRef ?? id)

  /** 逐个测试给出的模型，每次并发 4 个。 */
  const runTests = async (modelIds: readonly string[]) => {
    if (modelIds.length === 0) return
    setTesting(true)
    setTestProgress({ done: 0, total: modelIds.length })
    const outcomes: TestOutcome[] = []
    // 每次并发 4 个，避免一次向提供方发太多请求。
    for (let start = 0; start < modelIds.length; start += 4) {
      const batch = modelIds.slice(start, start + 4)
      const tested = await Promise.all(
        batch.map(async (modelId) => ({
          modelId,
          result: await testProvider(config(), modelId, typedSecret),
        })),
      )
      for (const outcome of tested) {
        if (outcome.result) outcomes.push({ modelId: outcome.modelId, result: outcome.result })
      }
      setTestProgress({
        done: Math.min(start + batch.length, modelIds.length),
        total: modelIds.length,
      })
    }
    setTesting(false)
    setTestProgress(undefined)
    onResult(outcomes.length > 0 ? outcomes : undefined)
  }

  const testOne = () => {
    const target = testTargetOf(draft.models, defaultModelId)
    if (target !== undefined) void runTests([target])
  }

  const testAll = () => void runTests(enabledModelIdsOf(draft.models))

  const fetchList = async () => {
    setFetching(true)
    const next = await fetchModels(config(), typedSecret)
    setFetching(false)
    if (!next) return
    if (!next.ok) {
      setFetchFailure(next.error)
      setManual(true)
      return
    }
    setFetchFailure(undefined)
    setDraft((current) => {
      const withCatalog = { ...current, catalog: next.models }
      // 新建且还没有模型：启用模板建议的模型；本机服务没有建议时启用拉取到的前几个
      if (saved || current.models.length > 0 || !template) return withCatalog
      const ids = next.models.map((m) => m.id)
      const suggested = suggestedModelIds(template, ids)
      const picked =
        suggested.length > 0
          ? suggested
          : template.category === 'local'
            ? ids.slice(0, LOCAL_AUTO_ENABLE_LIMIT)
            : []
      const models = picked.flatMap((modelId) => {
        const remote = next.models.find((m) => m.id === modelId)
        return remote ? [profileFrom(remote, current.template, catalog)] : []
      })
      return { ...withCatalog, models }
    })
    // 已保存且地址没变的供应商：拉取结果立刻保存，下次打开不用重新拉取。
    if (saved && saved.baseUrl === draft.baseUrl.trim() && saved.kind === draft.kind) {
      void updateSettings({
        providers: providers.map((provider) =>
          provider.id === saved.id ? { ...provider, catalog: next.models } : provider,
        ),
      })
    }
  }

  const autoFetched = useRef<string | undefined>(undefined)
  const canAutoFetch =
    autoFetch &&
    !fetching &&
    draft.catalog === undefined &&
    problems.baseUrl === undefined &&
    (typedSecret !== undefined ||
      template?.requiresKey === false ||
      newKeyStatus?.configured === true)
  const autoFetchKey = `${draft.baseUrl.trim()}\u0000${typedSecret ?? ''}`
  useEffect(() => {
    if (!canAutoFetch || autoFetched.current === autoFetchKey) return
    // 粘贴 Key 后稍等再拉取，逐字输入时不会每个字都发请求
    const timer = setTimeout(
      () => {
        autoFetched.current = autoFetchKey
        void fetchList()
      },
      typedSecret === undefined ? 0 : 500,
    )
    return () => clearTimeout(timer)
    // fetchList 每次渲染都是新函数；触发条件只看这两个值
  }, [canAutoFetch, autoFetchKey])

  const remoteOf = (row: ModelRow): RemoteModel => ({
    id: row.id,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
  })

  const addModels = (models: readonly RemoteModel[]) => {
    const have = new Set(draft.models.map((m) => m.id))
    const added = models
      .filter((m) => !have.has(m.id))
      .map((m) => profileFrom(m, draft.template, catalog))
    update({ models: [...draft.models, ...added] })
  }

  const setModel = (modelId: string, patch: Partial<ModelProfile>) =>
    update({ models: draft.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) })

  /** 列表里的开关：打开就加入并启用，关掉就保留设置但不在模型选择中列出。 */
  const toggleRow = (row: ModelRow, enabled: boolean) => {
    if (enabled) {
      if (row.profile) setModel(row.id, { enabled: undefined })
      else addModels([remoteOf(row)])
    } else {
      setModel(row.id, { enabled: false })
    }
  }

  /** 点模型名展开或收起它的设置；还没加入的模型先加入。 */
  const expandRow = (row: ModelRow) => {
    if (row.profile) {
      setSelectedModelId((current) => (current === row.id ? undefined : row.id))
      return
    }
    addModels([remoteOf(row)])
    setSelectedModelId(row.id)
  }

  const removeModel = (modelId: string) => {
    update({
      models: draft.models.filter((m) => m.id !== modelId),
      ...(draft.catalog ? { catalog: draft.catalog.filter((m) => m.id !== modelId) } : {}),
    })
    if (selectedModelId === modelId) setSelectedModelId(undefined)
  }

  const save = async () => {
    const credentialRef = credentialRefFor(saved, id, template, typedSecret !== undefined)
    const next = configOf(draft, id, credentialRef)
    const cleaned: ProviderConfig = {
      ...next,
      models: next.models.map(({ enabled, ...m }) => (enabled === false ? { ...m, enabled } : m)),
    }
    const list = saved
      ? providers.map((p) => (p.id === saved.id ? cleaned : p))
      : [...providers, cleaned]
    const firstEnabled = cleaned.models.find((m) => m.enabled !== false)
    const chosen =
      defaultModelId !== undefined
        ? { providerId: id, modelId: defaultModelId }
        : settings?.defaultModel === undefined && firstEnabled
          ? { providerId: id, modelId: firstEnabled.id }
          : undefined
    setBusy(true)
    setSaveError(undefined)
    // 先写 Key：写入失败就不改设置，不会出现“已保存但没有 Key”
    let wroteNewKey = false
    if (typedSecret && credentialRef) {
      const hadKey = (saved ? keyStatus : newKeyStatus)?.configured === true
      if (!(await saveCredential(credentialRef, typedSecret))) {
        setBusy(false)
        setSaveError('key')
        return
      }
      wroteNewKey = !hadKey
    }
    const result = await updateSettings({
      providers: list,
      ...(chosen ? { defaultModel: chosen } : {}),
    })
    if (!result) {
      // 设置没写进去：撤回刚写入的新 Key；替换掉的旧 Key 无法恢复，如实说明
      if (wroteNewKey && credentialRef) await deleteCredential(credentialRef)
      setBusy(false)
      setSaveError(typedSecret && !wroteNewKey ? 'settingsKeyKept' : 'settings')
      return
    }
    setBusy(false)
    onSaved(id)
  }

  const remove = async () => {
    if (!saved) return
    const remaining = providers.filter((p) => p.id !== saved.id)
    const clearsDefault = settings?.defaultModel?.providerId === saved.id
    const result = await updateSettings({
      providers: remaining,
      ...(clearsDefault ? { defaultModel: null } : {}),
    })
    if (result) onSaved(undefined)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        className="flex max-h-[calc(100dvh-48px)] w-[min(760px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          const input = (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>(
            'input[data-autofocus]',
          )
          if (input && !input.disabled) {
            event.preventDefault()
            input.focus()
          }
        }}
      >
        <header className="flex shrink-0 items-start gap-3 px-6 pt-5 pb-4">
          <Logo
            name={draft.displayName || '?'}
            kind={draft.kind}
            template={draft.template}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[16px]">
              {saved ? t('providers.editProvider') : t('providers.new')}
            </DialogTitle>
            <p className="mt-0.5 text-note text-muted">
              {t(`providers.kind.${draft.kind}.name`)} ·{' '}
              {t(`providers.source.${sourceOf(draft, catalog)}`)}
            </p>
          </div>
          {saved && <DeleteProvider name={saved.displayName} onConfirm={() => void remove()} />}
          <IconButton label={tc('action.close')} size="icon-sm" onClick={requestClose}>
            <X />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Labeled label={t('providers.field.name')} labelFor={nameId}>
              <input
                id={nameId}
                className={inputClass}
                value={draft.displayName}
                aria-invalid={problems.displayName ? true : undefined}
                onChange={(e) => update({ displayName: e.target.value })}
              />
            </Labeled>
            <Labeled
              label={t('providers.field.baseUrl')}
              labelFor={urlId}
              hint={
                problems.baseUrl && draft.baseUrl.trim() !== '' ? (
                  <span className="text-danger">{t('providers.baseUrl.invalid')}</span>
                ) : (
                  t(`providers.baseUrl.hint.${draft.kind}`)
                )
              }
            >
              <input
                id={urlId}
                className={cn(inputClass, 'font-mono text-[13px]')}
                value={draft.baseUrl}
                spellCheck={false}
                placeholder={t('providers.baseUrl.placeholder')}
                aria-invalid={problems.baseUrl && draft.baseUrl.trim() !== '' ? true : undefined}
                onChange={(e) => update({ baseUrl: e.target.value, catalog: undefined })}
              />
            </Labeled>
            {template?.regions && (
              <div className="sm:col-span-2">
                <Labeled label={t('providers.field.region')} hint={t('providers.region.hint')}>
                  <SegmentedControl
                    label={t('providers.field.region')}
                    value={region?.id ?? ''}
                    options={template.regions.map((r) => ({
                      value: r.id,
                      label: t(`providers.region.${r.id}`),
                    }))}
                    onChange={(next) => {
                      const picked = template.regions?.find((r) => r.id === next)
                      if (picked) update({ baseUrl: picked.baseUrl, catalog: undefined })
                    }}
                    className="w-fit"
                  />
                </Labeled>
              </div>
            )}
            <div className="sm:col-span-2">
              <KeyField
                status={saved ? keyStatus : newKeyStatus}
                secret={secret}
                optional={template?.requiresKey === false}
                keysUrl={keysUrl}
                autoFocus={!saved && template !== undefined && template.requiresKey}
                onSecret={(s) => {
                  setSecret(s)
                  setTouched(true)
                  setSaveError(undefined)
                  onResult(undefined)
                }}
              />
            </div>
          </div>

          <div className="mt-3">
            <TestBar
              outcomes={result}
              testing={testing}
              progress={testProgress}
              disabled={!valid || enabledCount === 0}
              enabledCount={enabledCount}
              onTest={testOne}
              onTestAll={testAll}
            />
          </div>

          <section
            aria-label={t('providers.field.models')}
            className="mt-5 flex flex-col overflow-hidden rounded-card bg-paper shadow-[inset_0_0_0_0.5px_var(--hair2)]"
          >
            <div className="flex flex-wrap items-center gap-2 border-b px-2.5 py-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
                <input
                  aria-label={t('providers.model.search')}
                  placeholder={t('providers.model.search')}
                  value={search}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setSearch(event.target.value)}
                  className={cn(inputClass, 'h-8 pl-8 text-[12.5px]')}
                />
              </div>
              <span className="shrink-0 text-note text-muted tabular">
                {search.trim() !== ''
                  ? t('providers.model.matched', { count: filteredRows.length })
                  : t('providers.model.enabledCount', {
                      enabled: enabledCount,
                      total: rows.length,
                    })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                disabled={!valid || fetching}
                onClick={() => void fetchList()}
              >
                {fetching ? <Spinner /> : <RefreshCw />}
                {t('providers.fetch.button')}
              </Button>
            </div>

            {fetchFailure !== undefined && (
              <p role="alert" className="border-b bg-danger-soft px-3 py-1.5 text-note text-danger">
                {t('providers.fetch.failed', { reason: errorText(fetchFailure) })}
              </p>
            )}

            {rows.length === 0 ? (
              <p className="flex items-center justify-center gap-2 px-4 py-8 text-center text-note text-muted">
                {fetching ? (
                  <>
                    <Spinner />
                    {t('providers.model.loading')}
                  </>
                ) : autoFetch && fetchFailure === undefined ? (
                  template?.requiresKey === false ? (
                    t('providers.model.emptyLocal')
                  ) : (
                    t('providers.model.emptyAuto')
                  )
                ) : (
                  t('providers.model.empty')
                )}
              </p>
            ) : filteredRows.length === 0 ? (
              <p className="px-4 py-8 text-center text-note text-muted">
                {t('providers.model.noMatch')}
              </p>
            ) : (
              <ul className="max-h-[min(52vh,460px)] overflow-y-auto">
                {filteredRows.map((row) => {
                  const configured = row.profile !== undefined
                  const enabled = configured && row.profile?.enabled !== false
                  const isDefault = row.id === defaultModelId
                  const name = row.displayName ?? row.id
                  const expanded = configured && row.id === selectedModelId
                  return (
                    <li
                      key={row.id}
                      className={cn(
                        '[&+&]:shadow-[0_-0.5px_0_var(--hair)]',
                        expanded && 'bg-sunk/40',
                      )}
                    >
                      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors hover:bg-sunk">
                        <Switch
                          checked={enabled}
                          disabled={isDefault}
                          title={isDefault ? t('providers.model.defaultHint') : undefined}
                          aria-label={
                            configured
                              ? t('providers.model.enable', { name })
                              : t('providers.model.add', { name })
                          }
                          onCheckedChange={(next) => toggleRow(row, next)}
                          className={cn(isDefault && 'disabled:opacity-100')}
                        />
                        <button
                          type="button"
                          aria-expanded={configured ? expanded : undefined}
                          onClick={() => expandRow(row)}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        >
                          {configured ? (
                            <ChevronRight
                              className={cn(
                                'size-3 shrink-0 text-faint transition-transform',
                                expanded && 'rotate-90',
                              )}
                            />
                          ) : (
                            <span aria-hidden className="size-3 shrink-0" />
                          )}
                          <span className="min-w-0 flex-1">
                            <code
                              className={cn(
                                'block truncate font-mono text-[12.5px] [font-variant-ligatures:none]',
                                configured ? 'text-fg' : 'text-muted',
                              )}
                            >
                              {row.id}
                            </code>
                            {row.displayName && row.displayName !== row.id && (
                              <span className="block truncate text-[11px] text-muted">
                                {row.displayName}
                              </span>
                            )}
                          </span>
                        </button>
                        {isDefault && <Tag tone="ok">{t('providers.default')}</Tag>}
                        {row.contextWindow !== undefined && (
                          <span className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                            {formatTokens(row.contextWindow)}
                          </span>
                        )}
                      </div>
                      {expanded && row.profile && (
                        <ModelSettings
                          model={row.profile}
                          isDefault={isDefault}
                          onChange={(patch) => setModel(row.id, patch)}
                          onDefault={() => {
                            setModel(row.id, { enabled: undefined })
                            setDefaultModelId(row.id)
                          }}
                          onRemove={() => removeModel(row.id)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="border-t px-2.5 py-1.5">
              {manual ? (
                <ManualModel
                  defaultContext={
                    (template?.modelDefaults ?? { contextWindow: 128_000 }).contextWindow
                  }
                  onAdd={(m) => addModels([m])}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setManual(true)}
                  className="inline-flex items-center gap-1 text-note text-muted transition-colors hover:text-fg"
                >
                  <Plus className="size-3" />
                  {t('providers.manual.button')}
                </button>
              )}
            </div>
          </section>

          <div className="mt-4">
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-2 text-[13px] text-muted hover:text-fg [&_svg]:size-3.5"
            >
              <ChevronDown className={cn('transition-transform', advanced && 'rotate-180')} />
              {t('providers.advanced.title')}
            </button>
            {advanced && (
              <div className="mt-3">
                {draft.kind === 'openai' ? (
                  <div className="flex flex-col gap-3">
                    <Labeled
                      label={t('providers.compat.preset')}
                      hint={t('providers.compat.presetHint')}
                      className="max-w-72"
                    >
                      <select
                        aria-label={t('providers.compat.preset')}
                        className={selectClass}
                        value={template ? template.id : ''}
                        onChange={(e) => applyCompatPreset(e.target.value || undefined)}
                      >
                        <option value="">{t('providers.compat.auto')}</option>
                        {templates.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.displayName}
                          </option>
                        ))}
                      </select>
                    </Labeled>
                    <CompatOptions
                      compat={draft.compat}
                      onChange={(compat) => update({ compat })}
                    />
                  </div>
                ) : (
                  <p className="text-note text-muted">{t('providers.advanced.none')}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3">
          {saveError !== undefined && (
            <p role="alert" className="mr-auto min-w-0 text-note text-danger">
              {t(`providers.saveError.${saveError}`)}
            </p>
          )}
          <Button disabled={busy} onClick={requestClose}>
            {tc('action.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !valid || !dirty} onClick={() => void save()}>
            {busy && <Spinner />}
            {t('providers.save')}
          </Button>
        </footer>
      </DialogContent>

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent tone="danger" icon={<TriangleAlert />}>
          <DialogTitle>{t('providers.discard.title')}</DialogTitle>
          <DialogDescription>
            {typedSecret !== undefined
              ? t('providers.discard.descriptionKey')
              : t('providers.discard.description')}
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t('providers.discard.keep')}</Button>
            </DialogClose>
            <Button variant="danger" onClick={onCancel}>
              {t('providers.discard.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}

export function ProvidersSettings() {
  const { t, i18n } = useTranslation('settings')
  const settings = useSessionStore((s) => s.settings)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const providerPlugins = useSessionStore((s) => s.providerPlugins)
  const loadProviderPlugins = useSessionStore((s) => s.loadProviderPlugins)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const credentialStatus = useSessionStore((s) => s.credentialStatus)
  const providers = settings?.providers ?? []
  const [activeKind, setActiveKind] = useState<ProviderKind | undefined>()
  const [addOpen, setAddOpen] = useState(false)
  const [editor, setEditor] = useState<
    { readonly saved: ProviderConfig | undefined; readonly draft: ProviderDraft } | undefined
  >()
  const [results, setResults] = useState<Readonly<Record<string, TestSummary>>>({})
  const [keys, setKeys] = useState<Readonly<Record<string, KeyStatus>>>({})
  const [keysVersion, setKeysVersion] = useState(0)

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])

  useEffect(() => {
    void loadProviderPlugins()
  }, [loadProviderPlugins])
  const plugins = useMemo(() => providerPlugins?.plugins ?? [], [providerPlugins])
  const catalog = useMemo(() => catalogOf(plugins), [plugins])

  const refList = providers
    .flatMap((p) => (p.credentialRef ? [p.credentialRef] : []))
    .join('\u0000')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, KeyStatus> = {}
      for (const ref of refList === '' ? [] : refList.split('\u0000')) {
        const status = await credentialStatus(ref)
        if (status) next[ref] = status
      }
      if (!cancelled) setKeys(next)
    })()
    return () => {
      cancelled = true
    }
  }, [refList, credentialStatus, keysVersion])

  const kind = activeKind ?? providers[0]?.kind ?? 'openai'
  const counts = useMemo<Record<ProviderKind, number>>(
    () => ({
      anthropic: providers.filter((p) => p.kind === 'anthropic').length,
      openai: providers.filter((p) => p.kind === 'openai').length,
      gemini: providers.filter((p) => p.kind === 'gemini').length,
    }),
    [providers],
  )
  const visible = providers.filter((provider) => provider.kind === kind)

  const resultKey = editor?.saved?.id ?? (editor ? '\u0000new' : undefined)

  const openAdd = () => {
    void loadProviderPlugins()
    setAddOpen(true)
  }

  const addProvider = (choice: AddChoice) => {
    const template = findTemplateIn(catalog, choice.template)
    const draft = template
      ? newDraftForTemplate(template, providers, i18n.language)
      : genericDraftFor(choice.kind, t('providers.add.genericName'), providers)
    setActiveKind(choice.kind)
    setAddOpen(false)
    setEditor({ saved: undefined, draft })
  }

  const openEdit = (provider: ProviderConfig) =>
    setEditor({ saved: provider, draft: draftOf(provider) })

  const removeProvider = async (provider: ProviderConfig) => {
    const remaining = providers.filter((p) => p.id !== provider.id)
    const clearsDefault = settings?.defaultModel?.providerId === provider.id
    await updateSettings({
      providers: remaining,
      ...(clearsDefault ? { defaultModel: null } : {}),
    })
  }

  return (
    <>
      <SettingsHeader
        icon={<Cpu />}
        title={t('section.providers.title')}
        description={t('section.providers.description')}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <KindTabs value={kind} counts={counts} onChange={setActiveKind} />
        <Button variant="primary" onClick={openAdd}>
          <Plus />
          {t('providers.add')}
        </Button>
      </div>

      {visible.length === 0 ? (
        <SettingsCard className="items-center gap-3 py-10 text-center">
          <span className="text-muted">
            <Plus className="size-5" />
          </span>
          <p className="text-ui text-muted">{t('providers.emptyTab')}</p>
          <Button onClick={openAdd}>
            <Plus />
            {t('providers.add')}
          </Button>
        </SettingsCard>
      ) : (
        <ul aria-label={t('providers.list')} className="flex flex-col gap-2">
          {visible.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isDefault={settings?.defaultModel?.providerId === provider.id}
              keyStatus={provider.credentialRef ? keys[provider.credentialRef] : undefined}
              result={results[provider.id]}
              onEdit={() => openEdit(provider)}
              onDelete={() => void removeProvider(provider)}
            />
          ))}
        </ul>
      )}

      {editor && (
        <ProviderEditor
          key={editor.saved?.id ?? '\u0000new'}
          saved={editor.saved}
          initialDraft={editor.draft}
          providers={providers}
          catalog={catalog}
          keyStatus={editor.saved?.credentialRef ? keys[editor.saved.credentialRef] : undefined}
          result={resultKey ? results[resultKey] : undefined}
          onResult={(result) =>
            setResults((all) => {
              const next = { ...all }
              if (!resultKey) return all
              if (result) next[resultKey] = result
              else delete next[resultKey]
              return next
            })
          }
          onSaved={(providerId) => {
            setResults((all) => {
              const pending = all['\u0000new']
              if (!pending || !providerId) return all
              const { ['\u0000new']: _, ...rest } = all
              return { ...rest, [providerId]: pending }
            })
            setEditor(undefined)
            setKeysVersion((v) => v + 1)
            if (providerId) setActiveKind(editor.draft.kind)
          }}
          onCancel={() => setEditor(undefined)}
        />
      )}

      <AddProviderDialog
        open={addOpen}
        catalog={catalog}
        plugins={plugins}
        onPick={addProvider}
        onClose={() => setAddOpen(false)}
      />
    </>
  )
}
