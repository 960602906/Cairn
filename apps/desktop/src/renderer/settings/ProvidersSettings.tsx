/**
 * 设置页“模型供应商”（M2-10，视觉规范 §8）。
 *
 * - 列表：图标、名称、来源（官方 / 第三方中转）、接口格式与模型数（没保存 Key 时提示）、默认、连接状态
 *   （本次打开设置页后测试的结果）。点击一行在下面编辑；“添加供应商”新建草稿（默认 DeepSeek 官方）。
 * - 编辑区：接口格式（三选一卡片）、来源与服务（选官方自动填写地址和兼容参数；中转选“兼容哪家”套用它的
 *   兼容参数）、名称、Base URL、API Key（显示末 4 位和“已保存到系统钥匙串”，可以更换）、测试连接、模型列表
 *   （开关、默认、上下文长度、能力；拉取模型列表或手动添加）、高级选项（兼容参数，只对 OpenAI 格式）。
 * - 改动在“保存”时一起提交：配置经 `settings.update`，新填的 Key 经 `credentials.set`。测试连接与拉取模型
 *   用当前的草稿和新填的 Key，不需要先保存。
 * - 不显示单价与任何金额（规范 §10）。
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
import { Check, ChevronRight, Plus, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react'
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
import { Field, inputClass, SettingsCard } from './Field.js'
import {
  configOf,
  draftOf,
  formatTokens,
  initials,
  logoColor,
  newDraft,
  problemsOf,
  profileFrom,
  slugId,
  sourceOf,
  templatesOf,
  testModelOf,
  uniqueProviderId,
  type ProviderDraft,
  type ProviderSource,
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

/** 错误码的说明（errors 命名空间）。 */
function useErrorText() {
  const { i18n } = useTranslation()
  return (error: ErrorInfo) => translateError(i18n, error)
}

function Logo({
  name,
  template,
  size = 32,
}: {
  readonly name: string
  readonly template?: string | undefined
  readonly size?: number
}) {
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-[9px] text-[11px] font-bold text-white"
      style={{ width: size, height: size, background: logoColor(template) }}
    >
      {initials(name)}
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

function ProviderRow({
  provider,
  selected,
  isDefault,
  keyStatus,
  result,
  onSelect,
}: {
  readonly provider: ProviderConfig
  readonly selected: boolean
  readonly isDefault: boolean
  readonly keyStatus: KeyStatus | undefined
  readonly result: TestResult | undefined
  readonly onSelect: () => void
}) {
  const { t } = useTranslation('settings')
  const source = sourceOf(provider)
  const missingKey = provider.credentialRef !== undefined && keyStatus?.configured === false
  const status = result ? (
    result.ok ? (
      <Status tone="ok">{t('providers.status.ok')}</Status>
    ) : (
      <Status tone="danger">{t('providers.status.failed')}</Status>
    )
  ) : missingKey ? (
    <Status tone="idle">{t('providers.status.noKey')}</Status>
  ) : (
    <Status tone="idle">{t('providers.status.untested')}</Status>
  )
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors',
          selected ? 'bg-accent-soft' : 'hover:bg-hover',
        )}
      >
        <Logo name={provider.displayName} template={provider.template} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-fg">
            {provider.displayName}
          </span>
          <span className="flex items-center gap-1.5 text-note text-muted">
            <Tag tone={source === 'official' ? 'accent' : 'warn'}>
              {t(`providers.source.${source}`)}
            </Tag>
            <span className="truncate">
              {t('providers.summary', {
                kind: t(`providers.kind.${provider.kind}.name`),
                count: provider.models.length,
              })}
              {missingKey && ` · ${t('providers.noKey')}`}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3.5 text-note text-muted">
          {isDefault && <Tag tone="ok">{t('providers.default')}</Tag>}
          {status}
        </span>
      </button>
    </li>
  )
}

function KindCards({
  value,
  onChange,
}: {
  readonly value: ProviderKind
  readonly onChange: (kind: ProviderKind) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div
      role="radiogroup"
      aria-label={t('providers.field.kind')}
      className="grid grid-cols-3 gap-2 max-[640px]:grid-cols-1"
    >
      {KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="radio"
          aria-checked={kind === value}
          onClick={() => onChange(kind)}
          className={cn(
            'flex flex-col gap-0.5 rounded-[10px] bg-paper px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--hair2)] transition-colors',
            kind === value && 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]',
          )}
        >
          <span className="text-ui font-medium text-fg">{t(`providers.kind.${kind}.name`)}</span>
          <span className="text-[11.5px] text-muted">{t(`providers.kind.${kind}.api`)}</span>
        </button>
      ))}
    </div>
  )
}

/** API Key：已保存时显示末 4 位和“已保存到系统钥匙串”，可以更换；否则是输入框。 */
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
      <Field label={t('providers.field.key')}>
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
      </Field>
    )
  }
  return (
    <Field
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
    </Field>
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

function ModelRow({
  model,
  isDefault,
  onToggle,
  onDefault,
  onRemove,
}: {
  readonly model: ModelProfile
  readonly isDefault: boolean
  readonly onToggle: (enabled: boolean) => void
  readonly onDefault: () => void
  readonly onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const enabled = model.enabled !== false
  const name = model.displayName ?? model.id
  const meta = [
    t('providers.model.context', { size: formatTokens(model.contextWindow) }),
    ...(model.supportsReasoning ? [t('providers.model.reasoning')] : []),
    ...(model.supportsTools ? [] : [t('providers.model.noTools')]),
  ].join(' · ')
  return (
    <li className="group flex min-h-10 items-center gap-2.5 px-3 py-1.5 text-[13px] [&+&]:shadow-[0_-0.5px_0_var(--hair)]">
      <Switch
        checked={enabled}
        disabled={isDefault}
        aria-label={t('providers.model.enable', { name })}
        onCheckedChange={onToggle}
      />
      <span className="min-w-0">
        <code className="block truncate font-mono text-[12.5px] [font-variant-ligatures:none] text-fg">
          {model.id}
        </code>
        {model.displayName && model.displayName !== model.id && (
          <span className="block truncate text-[11.5px] text-muted">{model.displayName}</span>
        )}
      </span>
      {isDefault ? (
        <Tag tone="ok">{t('providers.default')}</Tag>
      ) : (
        enabled && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-note opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            onClick={onDefault}
          >
            {t('providers.model.setDefault')}
          </Button>
        )
      )}
      <span className="flex-1" />
      <span className="shrink-0 text-[11.5px] whitespace-nowrap text-muted">{meta}</span>
      <IconButton
        label={t('providers.model.remove', { name })}
        size="icon-sm"
        disabled={isDefault}
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </li>
  )
}

/** 拉取到的模型中还没添加的，逐个添加或全部添加。 */
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
    <div className="mt-2 rounded-[10px] bg-sunk p-2">
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
          className="max-h-56 overflow-y-auto rounded-[8px] bg-paper shadow-hair2"
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
    <div className="mt-2 flex items-center gap-2">
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
        className={cn(inputClass, 'h-8 w-28 font-mono text-[12.5px]')}
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
  const selectClass = cn(inputClass, 'h-8 w-56 text-[13px]')
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('providers.compat.thinkingFormat')}>
        <select
          aria-label={t('providers.compat.thinkingFormat')}
          className={selectClass}
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
      </Field>
      <Field label={t('providers.compat.maxTokensField')}>
        <select
          aria-label={t('providers.compat.maxTokensField')}
          className={selectClass}
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
      </Field>
      {(
        [
          'requiresReasoningContentOnAssistantMessages',
          'supportsDeveloperRole',
          'supportsUsageInStreaming',
        ] as const
      ).map((key) => (
        <Field key={key} label={t(`providers.compat.${key}`)}>
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
        </Field>
      ))}
    </div>
  )
}

function DeleteProvider({
  name,
  onConfirm,
}: {
  readonly name: string
  readonly onConfirm: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger">
          {t('providers.delete.button')}
        </Button>
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

function ProviderEditor({
  saved,
  providers,
  keyStatus,
  result,
  onResult,
  onSaved,
  onCancel,
}: {
  /** 正在编辑的已保存供应商；新建时为 undefined。 */
  readonly saved: ProviderConfig | undefined
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
  const nameId = useId()
  const urlId = useId()

  const initial = useMemo(() => (saved ? draftOf(saved) : newDraft()), [saved])
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
  const [defaultModelId, setDefaultModelId] = useState<string | undefined>(() =>
    saved && settings?.defaultModel?.providerId === saved.id
      ? settings.defaultModel.modelId
      : undefined,
  )

  // 新供应商：查询它将使用的凭据引用，得到系统加密是否可用（也可能已有保存过的 Key）
  const credentialStatus = useSessionStore((s) => s.credentialStatus)
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
  const source: ProviderSource = sourceOf(draft)
  const templates = templatesOf(draft.kind)
  const template = draft.template ? findTemplate(draft.template) : undefined

  const update = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    onResult(undefined)
  }

  /** 选择服务（模板）：套用兼容参数；官方时填写地址；新建时换成它的模型。 */
  const applyTemplate = (templateId: string | undefined, nextSource: ProviderSource) => {
    const next = templateId ? findTemplate(templateId) : undefined
    update({
      template: next?.id,
      compat: next?.compat ? { ...next.compat } : undefined,
      ...(nextSource === 'official' && next ? { baseUrl: next.baseUrl } : {}),
      ...(nextSource === 'relay' && next && draft.baseUrl === next.baseUrl ? { baseUrl: '' } : {}),
      ...(saved === undefined && next
        ? {
            models: next.models.map((m) => ({ ...m })),
            ...(draft.displayName === template?.displayName || draft.displayName === ''
              ? { displayName: next.displayName }
              : {}),
          }
        : {}),
    })
  }

  const changeKind = (kind: ProviderKind) => {
    if (kind === draft.kind) return
    const first = templatesOf(kind)[0]
    // 新建时换成这种格式的第一个服务的模型
    setDraft((d) => ({
      ...d,
      kind,
      ...(saved === undefined && first ? { models: first.models.map((m) => ({ ...m })) } : {}),
    }))
    // 官方：换成这种格式的第一个服务；中转：通用（没有兼容参数）
    applyTemplate(source === 'official' ? first?.id : undefined, source)
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
    if (remote && 'models' in remote) {
      const ids = new Set(added.map((m) => m.id))
      setRemote({ models: remote.models.filter((m) => !ids.has(m.id)) })
    }
  }

  const setModel = (modelId: string, patch: Partial<ModelProfile>) =>
    update({ models: draft.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) })

  const save = async () => {
    const next = config()
    // 启用开关：显式写 false，启用时去掉字段
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
    const result = await updateSettings({ providers: providers.filter((p) => p.id !== saved.id) })
    if (result) onSaved(undefined)
  }

  const enabledCount = draft.models.filter((m) => m.enabled !== false).length

  return (
    <SettingsCard aria-label={saved ? saved.displayName : t('providers.new')}>
      <div className="flex items-center gap-3">
        <Logo name={draft.displayName || '?'} template={draft.template} />
        <h3 className="min-w-0 flex-1 truncate text-heading text-fg">
          {saved ? draft.displayName || saved.displayName : t('providers.new')}
        </h3>
        {saved && <DeleteProvider name={saved.displayName} onConfirm={() => void remove()} />}
      </div>

      <Field label={t('providers.field.kind')}>
        <KindCards value={draft.kind} onChange={changeKind} />
      </Field>

      <Field
        label={t('providers.field.source')}
        hint={
          source === 'official'
            ? t('providers.source.officialHint')
            : t('providers.source.relayHint')
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label={t('providers.field.source')}
            value={source}
            options={[
              { value: 'official', label: t('providers.source.official') },
              { value: 'relay', label: t('providers.source.relay') },
            ]}
            onChange={(next) => applyTemplate(draft.template ?? templates[0]?.id, next)}
          />
          <select
            aria-label={t('providers.field.service')}
            className={cn(inputClass, 'h-7 w-auto min-w-40 text-[12.5px]')}
            value={draft.template && template?.kind === draft.kind ? draft.template : ''}
            onChange={(e) =>
              applyTemplate(e.target.value || undefined, e.target.value ? source : 'relay')
            }
          >
            {source === 'relay' && <option value="">{t('providers.source.generic')}</option>}
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {source === 'relay'
                  ? t('providers.source.compatibleWith', { name: tpl.displayName })
                  : tpl.displayName}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <Field label={t('providers.field.name')} labelFor={nameId}>
        <input
          id={nameId}
          className={inputClass}
          value={draft.displayName}
          aria-invalid={problems.displayName ? true : undefined}
          onChange={(e) => update({ displayName: e.target.value })}
        />
      </Field>

      <Field
        label={t('providers.field.baseUrl')}
        labelFor={urlId}
        hint={
          problems.baseUrl && draft.baseUrl.trim() !== '' ? (
            <span className="text-danger">{t('providers.baseUrl.invalid')}</span>
          ) : source === 'relay' ? (
            t(`providers.baseUrl.hint.${draft.kind}`)
          ) : undefined
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
      </Field>

      <KeyField
        status={saved ? keyStatus : newKeyStatus}
        secret={secret}
        onSecret={(s) => {
          setSecret(s)
          onResult(undefined)
        }}
      />

      <TestBar
        result={result}
        testing={testing}
        disabled={!valid || enabledCount === 0}
        onTest={() => void test()}
      />

      <Field label={t('providers.field.models')}>
        {draft.models.length === 0 ? (
          <p className="pt-1 text-note text-muted">{t('providers.model.empty')}</p>
        ) : (
          <ul
            aria-label={t('providers.field.models')}
            className="rounded-[10px] shadow-[inset_0_0_0_1px_var(--hair2)]"
          >
            {draft.models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                isDefault={m.id === defaultModelId}
                onToggle={(enabled) => setModel(m.id, { enabled })}
                onDefault={() => setDefaultModelId(m.id)}
                onRemove={() => update({ models: draft.models.filter((x) => x.id !== m.id) })}
              />
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!valid || fetching}
            onClick={() => void fetchList()}
          >
            {fetching ? <Spinner /> : <RefreshCw />}
            {t('providers.fetch.button')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setManual((v) => !v)}>
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
              className="mt-2 rounded-[8px] bg-danger-soft px-2.5 py-1.5 text-note text-danger"
            >
              {t('providers.fetch.failed', { reason: errorText(remote.error) })}
            </p>
          ))}
        {manual && (
          <ManualModel
            defaultContext={(template?.modelDefaults ?? { contextWindow: 128_000 }).contextWindow}
            onAdd={(m) => addModels([m])}
          />
        )}
      </Field>

      <div>
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
          className="flex items-center gap-2 text-[13px] text-muted hover:text-fg [&_svg]:size-3.5"
        >
          <ChevronRight className={cn('transition-transform', advanced && 'rotate-90')} />
          {t('providers.advanced.title')}
        </button>
        {advanced && (
          <div className="mt-3">
            {draft.kind === 'openai' ? (
              <CompatOptions compat={draft.compat} onChange={(compat) => update({ compat })} />
            ) : (
              <p className="text-note text-muted">{t('providers.advanced.none')}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-3.5 shadow-[0_-0.5px_0_var(--hair)]">
        <Button
          disabled={busy || (!dirty && saved !== undefined)}
          onClick={() => {
            if (saved) {
              setDraft(initial)
              setSecret(undefined)
              setDefaultModelId(savedDefault)
              setRemote(undefined)
            } else {
              onCancel()
            }
          }}
        >
          {tc('action.cancel')}
        </Button>
        <Button variant="primary" disabled={busy || !valid || !dirty} onClick={() => void save()}>
          {t('providers.save')}
        </Button>
      </div>
    </SettingsCard>
  )
}

export function ProvidersSettings() {
  const { t } = useTranslation('settings')
  const settings = useSessionStore((s) => s.settings)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const credentialStatus = useSessionStore((s) => s.credentialStatus)
  const providers = settings?.providers ?? []
  const [selected, setSelected] = useState<string | 'new' | undefined>(undefined)
  const [results, setResults] = useState<Readonly<Record<string, TestResult>>>({})
  const [keys, setKeys] = useState<Readonly<Record<string, KeyStatus>>>({})
  const [keysVersion, setKeysVersion] = useState(0)

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])

  // 每个需要 Key 的供应商查询一次状态（保存后重新查询）
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

  const current =
    selected === 'new'
      ? undefined
      : (providers.find((p) => p.id === selected) ??
        (selected === undefined ? providers[0] : undefined))
  const editing = selected === 'new' || current !== undefined
  const resultKey = selected === 'new' ? '\u0000new' : current?.id

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <SettingsHeader
            title={t('section.providers.title')}
            description={t('section.providers.description')}
          />
        </div>
        <Button variant="primary" onClick={() => setSelected('new')}>
          <Plus />
          {t('providers.add')}
        </Button>
      </div>

      {providers.length === 0 && selected !== 'new' ? (
        <SettingsCard className="items-start">
          <p className="text-ui text-muted">{t('providers.empty')}</p>
          <Button onClick={() => setSelected('new')}>
            <Plus />
            {t('providers.add')}
          </Button>
        </SettingsCard>
      ) : (
        providers.length > 0 && (
          <ul
            aria-label={t('providers.list')}
            className="overflow-hidden rounded-approval bg-raise shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)] [&>li+li]:shadow-[0_-0.5px_0_var(--hair)]"
          >
            {providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                selected={selected !== 'new' && current?.id === p.id}
                isDefault={settings?.defaultModel?.providerId === p.id}
                keyStatus={p.credentialRef ? keys[p.credentialRef] : undefined}
                result={results[p.id]}
                onSelect={() => setSelected(p.id)}
              />
            ))}
          </ul>
        )
      )}

      {editing && (
        <ProviderEditor
          key={selected === 'new' ? '\u0000new' : current?.id}
          saved={current}
          providers={providers}
          keyStatus={current?.credentialRef ? keys[current.credentialRef] : undefined}
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
            setSelected(providerId)
            setKeysVersion((v) => v + 1)
          }}
          onCancel={() => setSelected(undefined)}
        />
      )}
    </>
  )
}
