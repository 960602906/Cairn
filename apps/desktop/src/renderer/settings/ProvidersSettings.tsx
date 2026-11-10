/**
 * 设置页“模型供应商”（M2-10）。交互参考 LiveAgent：
 *
 * - 顶部按接口格式分标签（Anthropic / OpenAI / Gemini），标签右侧“添加供应商”。
 * - 每个标签下是供应商卡片；点名称或编辑按钮打开弹窗，删除也在卡片上。
 * - 添加时只选接口格式；地址与 Key 在编辑弹窗里填写，不再区分“官方 / 中转”。
 * - 弹窗里：名称、服务、Base URL、Key、测试连接；模型列表（搜索、拉取、手动添加、
 *   批量启停、逐个开关）与右侧模型详情（上下文、输出上限、能力、默认模型）双栏。
 * - 高级兼容参数收在编辑弹窗底部的折叠区，不再让用户先理解“来源/兼容哪家”。
 */
import { findTemplate } from '@cairn/core'
import type {
  ErrorInfo,
  ModelCompat,
  ModelProfile,
  ProviderConfig,
  ProviderKind,
  RemoteModel,
  ThinkingFormat,
} from '@cairn/protocol'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Plus,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { translateError } from '@cairn/i18n'
import { useTranslation } from 'react-i18next'
import type { ProviderTestResult } from '../session-store.js'
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
import { inputClass, SettingsCard } from './Field.js'
import { DeepseekIcon, ProviderBrandIcon } from './ProviderBrandIcon.js'
import {
  configOf,
  draftOf,
  formatTokens,
  genericDraftFor,
  problemsOf,
  profileFrom,
  slugId,
  templatesOf,
  testModelOf,
  uniqueProviderId,
  uniqueDisplayName,
  type ProviderDraft,
} from './providers-model.js'
import { SettingsHeader } from './SettingsPage.js'

type KeyStatus = {
  readonly configured: boolean
  readonly available: boolean
  readonly last4?: string
}
type TestResult = ProviderTestResult

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
      ) : (
        <ProviderBrandIcon kind={kind} className="size-[58%]" />
      )}
    </span>
  )
}

function Tag({ tone, children }: { tone?: 'accent' | 'warn' | 'ok'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] font-medium whitespace-nowrap',
        tone === 'accent'
          ? 'bg-accent-soft text-accent'
          : tone === 'warn'
            ? 'bg-warn-soft text-warn'
            : tone === 'ok'
              ? 'bg-ok-soft text-ok'
              : 'bg-sunk2 text-fg2',
      )}
    >
      {children}
    </span>
  )
}

function Status({ tone, children }: { tone: 'ok' | 'danger' | 'idle'; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        className={cn(
          'size-1.5 rounded-full',
          tone === 'ok' ? 'bg-ok' : tone === 'danger' ? 'bg-danger' : 'bg-faint',
        )}
      />
      {children}
    </span>
  )
}

function Labeled({
  label,
  labelFor,
  hint,
  className,
  children,
}: {
  readonly label: string
  readonly labelFor?: string
  readonly hint?: ReactNode
  readonly className?: string
  readonly children: ReactNode
}) {
  const text = <span className="text-[12.5px] font-medium text-fg2">{label}</span>
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {labelFor ? (
        <label htmlFor={labelFor} className="contents">
          {text}
        </label>
      ) : (
        text
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
  readonly result: TestResult | undefined
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const enabled = provider.models.filter((model) => model.enabled !== false).length
  const missingKey = provider.credentialRef !== undefined && keyStatus?.configured === false
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
        {result ? (
          result.ok ? (
            <Status tone="ok">{t('providers.status.ok')}</Status>
          ) : (
            <Status tone="danger">{t('providers.status.failed')}</Status>
          )
        ) : (
          !missingKey && <Status tone="idle">{t('providers.status.untested')}</Status>
        )}
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
  return (
    <div
      role="tablist"
      aria-label={t('providers.field.kind')}
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

function KeyField({
  status,
  secret,
  onSecret,
}: {
  readonly status: KeyStatus | undefined
  readonly secret: string | undefined
  readonly onSecret: (secret: string | undefined) => void
}) {
  const { t } = useTranslation('settings')
  const id = useId()
  const unavailable = status?.available === false
  if (status?.configured && secret === undefined) {
    return (
      <Labeled label={t('providers.field.key')}>
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
      hint={unavailable ? t('providers.key.unavailable') : t('providers.key.hint')}
    >
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={unavailable}
          value={secret ?? ''}
          placeholder={t('providers.key.placeholder')}
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

function TestBar({
  result,
  testing,
  disabled,
  onTest,
}: {
  readonly result: TestResult | undefined
  readonly testing: boolean
  readonly disabled: boolean
  readonly onTest: () => void
}) {
  const { t } = useTranslation('settings')
  const errorText = useErrorText()
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] text-fg2',
        result === undefined || testing ? 'bg-sunk' : result.ok ? 'bg-ok-soft' : 'bg-danger-soft',
      )}
    >
      {testing ? (
        <>
          <Spinner />
          <span>{t('providers.test.running')}</span>
        </>
      ) : result === undefined ? (
        <span className="text-muted">{t('providers.test.idle')}</span>
      ) : result.ok ? (
        <>
          <Check className="size-3.5 text-ok" strokeWidth={2.2} />
          <span>
            <b className="font-medium text-ok">{t('providers.test.ok')}</b>
            {' · '}
            {t('providers.test.latency', { ms: result.latencyMs })}
          </span>
        </>
      ) : (
        <>
          <TriangleAlert className="size-3.5 shrink-0 text-danger" />
          <span className="min-w-0">
            <b className="font-medium text-danger">{t('providers.test.failed')}</b>
            {' · '}
            {errorText(result.error)}
          </span>
        </>
      )}
      <span className="flex-1" />
      <Button variant="ghost" size="sm" disabled={disabled || testing} onClick={onTest}>
        {result === undefined ? t('providers.test.run') : t('providers.test.again')}
      </Button>
    </div>
  )
}

function CreateProviderDialog({
  open,
  kind,
  onKind,
  onCreate,
  onClose,
}: {
  readonly open: boolean
  readonly kind: ProviderKind
  readonly onKind: (kind: ProviderKind) => void
  readonly onCreate: (kind: ProviderKind) => void
  readonly onClose: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(600px,calc(100vw-32px))]">
        <DialogTitle>{t('providers.add.pickKind')}</DialogTitle>
        <DialogDescription>{t('providers.add.pickKindHint')}</DialogDescription>
        <div className="mt-5 flex flex-col gap-4">
          <div role="radiogroup" aria-label={t('providers.field.kind')} className="grid gap-2">
            {KINDS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === kind}
                onClick={() => onKind(value)}
                onDoubleClick={() => onCreate(value)}
                className={cn(
                  'flex items-center gap-3 rounded-[10px] bg-sunk px-3 py-2.5 text-left transition-colors hover:bg-hover',
                  value === kind && 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]',
                )}
              >
                <span
                  aria-hidden
                  className="inline-grid size-7 shrink-0 place-items-center rounded-[8px] bg-paper text-fg shadow-[inset_0_0_0_0.5px_var(--hair2)]"
                >
                  <ProviderBrandIcon kind={value} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-fg">
                    {t(`providers.kind.${value}.name`)}
                  </span>
                  <span className="block text-[11.5px] text-muted">
                    {t(`providers.kind.${value}.api`)}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint" />
              </button>
            ))}
          </div>
          <Button variant="primary" onClick={() => onCreate(kind)}>
            {t('providers.add.next')}
          </Button>
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

function ModelDetail({
  model,
  isDefault,
  onChange,
  onDefault,
  onRemove,
}: {
  readonly model: ModelProfile | undefined
  readonly isDefault: boolean
  readonly onChange: (patch: Partial<ModelProfile>) => void
  readonly onDefault: () => void
  readonly onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  if (!model) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center">
        <span className="text-[13px] font-medium text-fg2">{t('providers.model.detail')}</span>
        <p className="max-w-56 text-note leading-relaxed text-muted">
          {t('providers.model.detailHint')}
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="truncate text-[13.5px] font-medium text-fg">
            {model.displayName ?? model.id}
          </h4>
          {isDefault && <Tag tone="ok">{t('providers.default')}</Tag>}
        </div>
        <p className="truncate font-mono text-[11.5px] text-muted">{model.id}</p>
      </div>
      <Labeled label={t('providers.model.displayName')}>
        <input
          aria-label={t('providers.model.displayName')}
          value={model.displayName ?? ''}
          placeholder={model.id}
          onChange={(event) => onChange({ displayName: event.target.value })}
          className={inputClass}
        />
      </Labeled>
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
      </div>
      <div className="flex items-center gap-1.5">
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
    <div className="flex items-center gap-2 px-2 pt-2">
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

function RemoteModels({
  models,
  onAdd,
  onClose,
}: {
  readonly models: readonly RemoteModel[]
  readonly onAdd: (models: readonly RemoteModel[]) => void
  readonly onClose: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="border-b bg-sunk/70 px-2 py-2">
      <div className="flex items-center gap-2 px-1 pb-1.5 text-note text-muted">
        <span className="flex-1">{t('providers.fetch.found', { count: models.length })}</span>
        {models.length > 1 && (
          <Button variant="ghost" size="sm" className="h-6" onClick={() => onAdd(models)}>
            {t('providers.fetch.addAll')}
          </Button>
        )}
        <IconButton label={t('providers.fetch.close')} size="icon-sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {models.length > 0 && (
        <ul
          aria-label={t('providers.fetch.list')}
          className="max-h-44 overflow-y-auto rounded-[8px] bg-paper shadow-hair2"
        >
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] [&+&]:shadow-[0_-0.5px_0_var(--hair)]"
            >
              <code className="min-w-0 flex-1 truncate font-mono [font-variant-ligatures:none]">
                {m.id}
              </code>
              {m.contextWindow && (
                <span className="text-[11.5px] text-muted">
                  {t('providers.model.context', { size: formatTokens(m.contextWindow) })}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6"
                aria-label={t('providers.fetch.add', { name: m.id })}
                onClick={() => onAdd([m])}
              >
                <Plus />
              </Button>
            </li>
          ))}
        </ul>
      )}
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
          className={cn(inputClass, 'h-8 text-[13px]')}
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
          className={cn(inputClass, 'h-8 text-[13px]')}
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
  keyStatus,
  result,
  onResult,
  onSaved,
  onCancel,
}: {
  readonly saved: ProviderConfig | undefined
  readonly initialDraft: ProviderDraft
  readonly providers: readonly ProviderConfig[]
  readonly keyStatus: KeyStatus | undefined
  readonly result: TestResult | undefined
  readonly onResult: (result: TestResult | undefined) => void
  readonly onSaved: (providerId: string | undefined) => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const errorText = useErrorText()
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const saveCredential = useSessionStore((s) => s.saveCredential)
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
  const [fetching, setFetching] = useState(false)
  const [remote, setRemote] = useState<
    { readonly models: readonly RemoteModel[] } | { readonly error: ErrorInfo } | undefined
  >()
  const [manual, setManual] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(initial.models[0]?.id)
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
  const dirty =
    saved === undefined ||
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    typedSecret !== undefined ||
    defaultModelId !== savedDefault
  const templates = templatesOf(draft.kind)
  const template = draft.template ? findTemplate(draft.template) : undefined
  const enabledCount = draft.models.filter((model) => model.enabled !== false).length
  const selectedModel = draft.models.find((model) => model.id === selectedModelId)
  const filteredModels = draft.models.filter((model) => {
    const query = search.trim().toLowerCase()
    if (!query) return true
    return (
      model.id.toLowerCase().includes(query) ||
      (model.displayName ?? '').toLowerCase().includes(query)
    )
  })
  const allVisibleEnabled =
    filteredModels.length > 0 && filteredModels.every((model) => model.enabled !== false)

  useEffect(() => {
    if (draft.models.some((model) => model.id === selectedModelId)) return
    setSelectedModelId(draft.models[0]?.id)
  }, [draft.models, selectedModelId])

  const update = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    onResult(undefined)
  }

  /** 兼容预设：只套用兼容参数，不改地址、名称和已有模型。 */
  const applyCompatPreset = (templateId: string | undefined) => {
    const next = templateId ? findTemplate(templateId) : undefined
    update({
      template: next?.id,
      compat: next?.compat ? { ...next.compat } : undefined,
    })
  }

  const config = (): ProviderConfig => configOf(draft, id, saved?.credentialRef ?? id)

  const test = async () => {
    const modelId = testModelOf(
      id,
      draft.models,
      defaultModelId ? { providerId: id, modelId: defaultModelId } : undefined,
    )
    if (!modelId) return
    setTesting(true)
    const next = await testProvider(config(), modelId, typedSecret)
    setTesting(false)
    onResult(next)
  }

  const fetchList = async () => {
    setFetching(true)
    const next = await fetchModels(config(), typedSecret)
    setFetching(false)
    if (!next) return
    if (next.ok) {
      const have = new Set(draft.models.map((m) => m.id))
      setRemote({ models: next.models.filter((m) => !have.has(m.id)) })
    } else {
      setRemote({ error: next.error })
      setManual(true)
    }
  }

  const addModels = (models: readonly RemoteModel[]) => {
    const have = new Set(draft.models.map((m) => m.id))
    const added = models.filter((m) => !have.has(m.id)).map((m) => profileFrom(m, draft.template))
    update({ models: [...draft.models, ...added] })
    if (added[0] && selectedModelId === undefined) setSelectedModelId(added[0].id)
    if (remote && 'models' in remote) {
      const ids = new Set(added.map((m) => m.id))
      setRemote({ models: remote.models.filter((m) => !ids.has(m.id)) })
    }
  }

  const setModel = (modelId: string, patch: Partial<ModelProfile>) =>
    update({ models: draft.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) })

  const removeModel = (modelId: string) => {
    update({ models: draft.models.filter((m) => m.id !== modelId) })
    if (selectedModelId === modelId) {
      setSelectedModelId(draft.models.find((m) => m.id !== modelId)?.id)
    }
  }

  const toggleVisible = (enabled: boolean) => {
    const ids = new Set(filteredModels.map((model) => model.id))
    update({
      models: draft.models.map((model) =>
        ids.has(model.id) && model.id !== defaultModelId
          ? { ...model, enabled: enabled ? undefined : false }
          : model,
      ),
    })
  }

  const save = async () => {
    const next = config()
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
    const result = await updateSettings({
      providers: list,
      ...(chosen ? { defaultModel: chosen } : {}),
    })
    if (result && typedSecret && cleaned.credentialRef) {
      await saveCredential(cleaned.credentialRef, typedSecret)
    }
    setBusy(false)
    if (result) onSaved(id)
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
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[calc(100dvh-48px)] w-[min(1040px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0">
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
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-note text-muted">
              <span>
                {t(`providers.kind.${draft.kind}.name`)} · {t('providers.compatible')}
              </span>
              {draft.displayName && <span className="truncate">· {draft.displayName}</span>}
            </p>
          </div>
          {saved && <DeleteProvider name={saved.displayName} onConfirm={() => void remove()} />}
          <IconButton label={tc('action.close')} size="icon-sm" onClick={onCancel}>
            <X />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          <div className="grid gap-3 sm:grid-cols-2">
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
              className="sm:col-span-2"
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
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
            </Labeled>
            <div className="sm:col-span-2">
              <KeyField
                status={saved ? keyStatus : newKeyStatus}
                secret={secret}
                onSecret={(s) => {
                  setSecret(s)
                  onResult(undefined)
                }}
              />
            </div>
          </div>

          <div className="mt-3">
            <TestBar
              result={result}
              testing={testing}
              disabled={!valid || enabledCount === 0}
              onTest={() => void test()}
            />
          </div>

          <section
            aria-label={t('providers.field.models')}
            className="mt-5 grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_340px]"
          >
            <div className="flex min-h-[340px] flex-col overflow-hidden rounded-card bg-paper shadow-[inset_0_0_0_0.5px_var(--hair2)]">
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => setManual((v) => !v)}
                >
                  <Plus />
                  {t('providers.manual.button')}
                </Button>
              </div>

              {remote !== undefined &&
                ('models' in remote ? (
                  <RemoteModels
                    models={remote.models}
                    onAdd={addModels}
                    onClose={() => setRemote(undefined)}
                  />
                ) : (
                  <p
                    role="alert"
                    className="border-b bg-danger-soft px-3 py-1.5 text-note text-danger"
                  >
                    {t('providers.fetch.failed', { reason: errorText(remote.error) })}
                  </p>
                ))}

              {manual && (
                <ManualModel
                  defaultContext={
                    (template?.modelDefaults ?? { contextWindow: 128_000 }).contextWindow
                  }
                  onAdd={(m) => addModels([m])}
                />
              )}

              <div className="flex items-center gap-2 border-b bg-sunk/50 px-3 py-1.5">
                <Switch
                  checked={allVisibleEnabled}
                  aria-label={t('providers.model.enableAll')}
                  onCheckedChange={toggleVisible}
                />
                <span className="text-note text-muted">
                  {t('providers.model.enabledCount', {
                    enabled: enabledCount,
                    total: draft.models.length,
                  })}
                </span>
                <span className="flex-1" />
                {search.trim() !== '' && (
                  <span className="text-note text-faint">
                    {t('providers.model.matched', { count: filteredModels.length })}
                  </span>
                )}
              </div>

              {draft.models.length === 0 ? (
                <p className="flex flex-1 items-center justify-center px-4 text-center text-note text-muted">
                  {t('providers.model.empty')}
                </p>
              ) : filteredModels.length === 0 ? (
                <p className="flex flex-1 items-center justify-center px-4 text-center text-note text-muted">
                  {t('providers.model.noMatch')}
                </p>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {filteredModels.map((model) => {
                    const enabled = model.enabled !== false
                    const isDefault = model.id === defaultModelId
                    const name = model.displayName ?? model.id
                    return (
                      <li
                        key={model.id}
                        className={cn(
                          'flex items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors [&+&]:shadow-[0_-0.5px_0_var(--hair)]',
                          model.id === selectedModel?.id ? 'bg-accent-soft' : 'hover:bg-sunk',
                        )}
                      >
                        <Switch
                          checked={enabled}
                          disabled={isDefault}
                          aria-label={t('providers.model.enable', { name })}
                          onCheckedChange={(next) =>
                            setModel(model.id, { enabled: next ? undefined : false })
                          }
                        />
                        <button
                          type="button"
                          onClick={() => setSelectedModelId(model.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <code className="block truncate font-mono text-[12.5px] text-fg [font-variant-ligatures:none]">
                            {model.id}
                          </code>
                          {model.displayName && model.displayName !== model.id && (
                            <span className="block truncate text-[11px] text-muted">
                              {model.displayName}
                            </span>
                          )}
                        </button>
                        {isDefault && <Tag tone="ok">{t('providers.default')}</Tag>}
                        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted">
                          {formatTokens(model.contextWindow)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <aside
              aria-label={t('providers.model.detail')}
              className="rounded-card bg-sunk px-4 py-3.5 shadow-[inset_0_0_0_0.5px_var(--hair2)]"
            >
              <ModelDetail
                model={selectedModel}
                isDefault={selectedModel !== undefined && selectedModel.id === defaultModelId}
                onChange={(patch) => selectedModel && setModel(selectedModel.id, patch)}
                onDefault={() => selectedModel && setDefaultModelId(selectedModel.id)}
                onRemove={() => selectedModel && removeModel(selectedModel.id)}
              />
            </aside>
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
                        className={inputClass}
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
          <Button disabled={busy} onClick={onCancel}>
            {tc('action.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !valid || !dirty} onClick={() => void save()}>
            {t('providers.save')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

export function ProvidersSettings() {
  const { t } = useTranslation('settings')
  const settings = useSessionStore((s) => s.settings)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const credentialStatus = useSessionStore((s) => s.credentialStatus)
  const providers = settings?.providers ?? []
  const [activeKind, setActiveKind] = useState<ProviderKind | undefined>()
  const [picker, setPicker] = useState<ProviderKind | undefined>()
  const [editor, setEditor] = useState<
    { readonly saved: ProviderConfig | undefined; readonly draft: ProviderDraft } | undefined
  >()
  const [results, setResults] = useState<Readonly<Record<string, TestResult>>>({})
  const [keys, setKeys] = useState<Readonly<Record<string, KeyStatus>>>({})
  const [keysVersion, setKeysVersion] = useState(0)

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])

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

  const openAdd = () => setPicker(kind)

  const createProvider = (nextKind: ProviderKind) => {
    const draft = genericDraftFor(
      nextKind,
      uniqueDisplayName(t('providers.add.genericName'), providers),
      providers,
    )
    setActiveKind(nextKind)
    setPicker(undefined)
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

      <CreateProviderDialog
        open={picker !== undefined}
        kind={picker ?? kind}
        onKind={(next) => setPicker(next)}
        onCreate={createProvider}
        onClose={() => setPicker(undefined)}
      />
    </>
  )
}
