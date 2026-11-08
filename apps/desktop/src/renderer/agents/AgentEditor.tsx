/**
 * Agent 编辑器（M3-12，管理界面 §4）：左侧分区导航，右侧表单，顶部固定操作栏。
 *
 * - 只编辑草稿字段；保存走 `agent.saveDraft`，发布在草稿有校验错误时被阻止。
 * - 左侧导航显示未保存 / 警告 / 错误；离开时若有改动先确认。
 * - 内置 Agent 只读，只能“复制为新 Agent”。
 * - 指令区实时估算 token 与占上下文的比例（按主模型或固定模型的上下文窗口）。
 */
import { ArrowLeft, Check, Copy, Download, Save, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  type AgentDraftFields,
  type AgentDetail,
  type AgentSummary,
  type AgentValidationIssue,
  type AgentValidationResult,
  type DelegationPolicy,
  type LocalizedText,
} from '@cairn/protocol'
import { AGENT_COLOR_NAMES, AGENT_ICON_NAMES, AgentAvatar } from './AgentAvatar.js'
import {
  AGENT_SECTIONS,
  type AgentSection,
  defaultDraft,
  defaultDelegationPolicy,
  draftFieldsOf,
  issuesAt,
  localized,
  sectionChanged,
  sectionMarks,
} from './model.js'
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
  SegmentedControl,
  Switch,
} from '../ui/index.js'
import { inputClass } from '../settings/Field.js'
import { AgentVersions } from './AgentVersions.js'
import { AgentEffectiveConfig } from './AgentEffectiveConfig.js'

type View = 'edit' | 'versions' | 'effective'

const CATEGORIES = ['read', 'write', 'execute', 'network'] as const
const MODES = ['read-only', 'ask', 'auto'] as const

const estimateTokens = (text: string) => Math.ceil([...text].length / 4)

const update = <K extends keyof AgentDraftFields>(
  fields: AgentDraftFields,
  key: K,
  value: AgentDraftFields[K],
): AgentDraftFields => ({ ...fields, [key]: value })

const toggleInList = (list: readonly string[], value: string): string[] =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value]

function Issues({
  list,
  tone,
}: {
  readonly list: readonly AgentValidationIssue[]
  readonly tone: 'error' | 'warn'
}) {
  const { t } = useTranslation('agents')
  if (list.length === 0) return null
  return (
    <ul
      className={
        tone === 'error'
          ? 'flex flex-col gap-1 text-note text-danger'
          : 'flex flex-col gap-1 text-note text-warn'
      }
    >
      {list.map((issue, index) => {
        const key = `issue.${issue.code}` as unknown as Parameters<typeof t>[0]
        return <li key={`${issue.code}-${index}`}>{t(key, issue.params ?? {})}</li>
      })}
    </ul>
  )
}

function LocalizedFields({
  idPrefix,
  labelZh,
  labelEn,
  value,
  onChange,
}: {
  readonly idPrefix: string
  readonly labelZh: string
  readonly labelEn: string
  readonly value: LocalizedText
  readonly onChange: (next: LocalizedText) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="mb-1 block text-[13px] text-fg2">{labelZh}</span>
        <input
          id={`${idPrefix}-zh`}
          className={inputClass}
          value={value['zh-CN'] ?? ''}
          onChange={(e) => onChange({ ...value, 'zh-CN': e.target.value })}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[13px] text-fg2">{labelEn}</span>
        <input
          id={`${idPrefix}-en`}
          className={inputClass}
          value={value['en-US'] ?? ''}
          onChange={(e) => onChange({ ...value, 'en-US': e.target.value })}
        />
      </label>
    </div>
  )
}

function SectionNav({
  section,
  onSelect,
  baseline,
  fields,
  validation,
  view,
  onView,
}: {
  readonly section: AgentSection
  readonly onSelect: (section: AgentSection) => void
  readonly baseline: AgentDraftFields
  readonly fields: AgentDraftFields
  readonly validation: AgentValidationResult | undefined
  readonly view: View
  readonly onView: (view: View) => void
}) {
  const { t } = useTranslation('agents')
  const marks = sectionMarks(validation)
  return (
    <nav aria-label={t('page.title')} className="flex w-[176px] shrink-0 flex-col gap-0.5">
      {AGENT_SECTIONS.map((id) => {
        const current = view === 'edit' && id === section
        const changed = sectionChanged(baseline, fields, id)
        const mark = marks[id]
        return (
          <button
            key={id}
            type="button"
            aria-current={current ? 'page' : undefined}
            onClick={() => {
              onView('edit')
              onSelect(id)
            }}
            className={`flex h-8 items-center gap-2 rounded-item px-2.5 text-left text-ui transition-colors ${
              current ? 'bg-raise font-medium text-fg shadow-1' : 'text-fg2 hover:bg-hover'
            }`}
          >
            <span className="flex-1">{t(`section.${id}`)}</span>
            {mark.errors > 0 ? (
              <span
                aria-label={t('section.errors', { count: mark.errors })}
                className="size-1.5 rounded-full bg-danger"
              />
            ) : mark.warnings > 0 ? (
              <span
                aria-label={t('section.warnings', { count: mark.warnings })}
                className="size-1.5 rounded-full bg-warn"
              />
            ) : changed ? (
              <span aria-label={t('section.pending')} className="size-1.5 rounded-full bg-accent" />
            ) : null}
          </button>
        )
      })}
      <div className="my-1.5 h-px bg-hair" />
      <button
        type="button"
        aria-current={view === 'versions' ? 'page' : undefined}
        onClick={() => onView('versions')}
        className={`flex h-8 items-center rounded-item px-2.5 text-left text-ui ${
          view === 'versions' ? 'bg-raise font-medium text-fg shadow-1' : 'text-fg2 hover:bg-hover'
        }`}
      >
        {t('versions.title')}
      </button>
      <button
        type="button"
        aria-current={view === 'effective' ? 'page' : undefined}
        onClick={() => onView('effective')}
        className={`flex h-8 items-center rounded-item px-2.5 text-left text-ui ${
          view === 'effective' ? 'bg-raise font-medium text-fg shadow-1' : 'text-fg2 hover:bg-hover'
        }`}
      >
        {t('effective.title')}
      </button>
    </nav>
  )
}

function DelegationSection({
  fields,
  agents,
  validation,
  onChange,
}: {
  readonly fields: AgentDraftFields
  readonly agents: readonly AgentSummary[]
  readonly validation: AgentValidationResult | undefined
  readonly onChange: (next: AgentDraftFields) => void
}) {
  const { t, i18n } = useTranslation('agents')
  const policy = fields.delegation ?? defaultDelegationPolicy()
  const setPolicy = (patch: Partial<DelegationPolicy>) =>
    onChange(update(fields, 'delegation', { ...policy, ...patch }))
  const published = agents.filter((agent) => agent.status === 'published' && !agent.archived)
  const otherErrors = issuesAt(validation, 'delegation', 'errors').filter(
    (issue) => !issue.path.startsWith('delegation.allowedAgents'),
  )
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="block text-[13px] font-medium text-fg2">{t('delegation.enabled')}</span>
          <span className="mt-0.5 block text-note text-muted">{t('delegation.enabledHint')}</span>
        </div>
        <Switch
          aria-label={t('delegation.enabled')}
          checked={policy.enabled}
          onCheckedChange={(enabled) => setPolicy({ enabled })}
        />
      </div>

      {!policy.enabled ? (
        <p className="rounded-card bg-raise px-3.5 py-3 text-note text-muted">
          {t('delegation.disabledHint')}
        </p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] text-fg2">{t('delegation.allowed')}</legend>
            <p className="text-note text-muted">{t('delegation.allowedHint')}</p>
            {published.length === 0 ? (
              <p className="text-note text-faint">{t('delegation.noAgents')}</p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {published.map((agent) => {
                  const checked = policy.allowedAgents.includes(agent.agentId)
                  return (
                    <label
                      key={agent.agentId}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-item px-2.5 py-2 text-ui',
                        checked ? 'bg-accent-soft' : 'bg-raise',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setPolicy({
                            allowedAgents: toggleInList(policy.allowedAgents, agent.agentId),
                          })
                        }
                      />
                      <AgentAvatar
                        icon={agent.icon}
                        color={agent.color}
                        size={22}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {localized(agent.name, i18n.language, agent.agentId)}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <Issues
              list={issuesAt(validation, 'delegation.allowedAgents', 'errors')}
              tone="error"
            />
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['maxDepth', 'delegation.maxDepth', 0, 3],
                ['maxChildrenPerTurn', 'delegation.maxChildren', 1, 12],
                ['maxParallel', 'delegation.maxParallel', 1, 8],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-[13px] text-fg2">{t(label)}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  className={inputClass}
                  value={policy[key]}
                  onChange={(e) => setPolicy({ [key]: Number(e.target.value) })}
                />
              </label>
            ))}
            <label className="block">
              <span className="mb-1 block text-[13px] text-fg2">{t('delegation.budgetShare')}</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                className={inputClass}
                value={policy.childBudgetShare}
                onChange={(e) => setPolicy({ childBudgetShare: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[13px] text-fg2">{t('delegation.workspace')}</span>
              <select
                className={inputClass}
                value={policy.defaultWorkspace}
                onChange={(e) =>
                  setPolicy({
                    defaultWorkspace: e.target.value as DelegationPolicy['defaultWorkspace'],
                  })
                }
              >
                {(['auto', 'shared', 'isolated'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`delegation.workspace.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] text-fg2">{t('delegation.mergeReview')}</span>
              <select
                className={inputClass}
                value={policy.mergeReview}
                onChange={(e) =>
                  setPolicy({ mergeReview: e.target.value as DelegationPolicy['mergeReview'] })
                }
              >
                {(['user', 'parent-then-user'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`delegation.mergeReview.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Issues list={otherErrors} tone="error" />
          <Issues list={issuesAt(validation, 'delegation', 'warnings')} tone="warn" />
        </>
      )}
    </section>
  )
}

export interface AgentEditorProps {
  /** 打开时载入的 Agent；新草稿为 undefined。 */
  readonly agentId: string | undefined
  readonly initial?: AgentDetail | undefined
  readonly onBack: () => void
  /** 复制后打开新 Agent。 */
  readonly onOpenAgent?: (agentId: string) => void
  /** 已离开并保存后回调，用于刷新列表。 */
  readonly onChanged: () => void
}

export function AgentEditor({
  agentId,
  initial,
  onBack,
  onOpenAgent,
  onChanged,
}: AgentEditorProps) {
  const { t, i18n } = useTranslation('agents')
  const store = useSessionStore((s) => s)
  const settings = useSessionStore((s) => s.settings)
  const [currentId, setCurrentId] = useState<string | undefined>(agentId)
  const [detail, setDetail] = useState<AgentDetail | undefined>(initial)
  const [fields, setFields] = useState<AgentDraftFields | undefined>(undefined)
  const [baseline, setBaseline] = useState<AgentDraftFields | undefined>(undefined)
  const [validation, setValidation] = useState<AgentValidationResult | undefined>(undefined)
  const [section, setSection] = useState<AgentSection>('basic')
  const [view, setView] = useState<View>('edit')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [busy, setBusy] = useState(false)
  const dirty =
    fields !== undefined &&
    baseline !== undefined &&
    fields !== baseline &&
    JSON.stringify(fields) !== JSON.stringify(baseline)

  useEffect(() => {
    setCurrentId(agentId)
  }, [agentId])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const loaded = agentId ? await store.getAgent(agentId) : undefined
      if (cancelled) return
      setDetail(loaded)
      const next = loaded?.draft
        ? draftFieldsOf(loaded.draft)
        : loaded?.published
          ? draftFieldsOf(loaded.published)
          : defaultDraft()
      setFields(next)
      setBaseline(next)
      setValidation(loaded?.validation)
    }
    void load()
    return () => {
      cancelled = true
    }
    // store 是稳定的 API 集合，按 agentId 载入
  }, [agentId])

  const readonly = detail?.source === 'builtin' || detail?.archived === true
  const published = detail?.published
  const dirtySections = useMemo(() => {
    if (!fields || !baseline) return new Set<AgentSection>()
    return new Set(AGENT_SECTIONS.filter((id) => sectionChanged(baseline, fields, id)))
  }, [fields, baseline])

  const save = useCallback(async (): Promise<boolean> => {
    if (!fields || readonly || saving) return false
    setSaving(true)
    const next = await store.saveAgentDraft({ ...fields, ...(currentId ? { id: currentId } : {}) })
    setSaving(false)
    if (!next) return false
    setCurrentId(next.agentId)
    setDetail(next)
    const saved = next.draft ? draftFieldsOf(next.draft) : fields
    setFields(saved)
    setBaseline(saved)
    setValidation(next.validation)
    setSavedAt(true)
    onChanged()
    return true
  }, [currentId, fields, onChanged, readonly, saving, store])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const leave = async (saveFirst: boolean | 'discard') => {
    if (saveFirst === true) {
      const ok = await save()
      if (!ok) return
    }
    setConfirmLeave(false)
    onBack()
  }

  const back = () => {
    if (dirty) setConfirmLeave(true)
    else onBack()
  }

  const publish = async () => {
    const id = currentId ?? detail?.agentId
    if (!id) return
    setBusy(true)
    if (dirty) {
      const saved = fields ? await store.saveAgentDraft({ ...fields, id }) : undefined
      if (!saved) {
        setBusy(false)
        return
      }
      setCurrentId(saved.agentId)
      setDetail(saved)
      const savedFields = saved.draft ? draftFieldsOf(saved.draft) : fields!
      setFields(savedFields)
      setBaseline(savedFields)
    }
    const next = await store.publishAgent(id)
    setBusy(false)
    setConfirmPublish(false)
    if (!next) return
    setCurrentId(next.agentId)
    setDetail(next)
    const publishedFields = next.draft
      ? draftFieldsOf(next.draft)
      : next.published
        ? draftFieldsOf(next.published)
        : fields
    if (publishedFields) {
      setFields(publishedFields)
      setBaseline(publishedFields)
    }
    onChanged()
  }

  const duplicate = async () => {
    const id = currentId ?? detail?.agentId
    if (!id) return
    setBusy(true)
    const next = await store.duplicateAgent(id)
    setBusy(false)
    if (!next) return
    onChanged()
    if (onOpenAgent) onOpenAgent(next.agentId)
    else onBack()
  }

  const exportAgent = async () => {
    const id = currentId ?? detail?.agentId
    if (!id) return
    const markdown = await store.exportAgent(id)
    if (markdown === undefined) return
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${id.replace(/[^\w.-]+/g, '-')}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  const archive = async () => {
    const id = currentId ?? detail?.agentId
    if (!id) return
    setBusy(true)
    const next = await store.archiveAgent(id)
    setBusy(false)
    if (!next) return
    setDetail(next)
    onChanged()
    onBack()
  }

  const unarchive = async () => {
    const id = currentId ?? detail?.agentId
    if (!id) return
    setBusy(true)
    const next = await store.unarchiveAgent(id)
    setBusy(false)
    if (!next) return
    setDetail(next)
    onChanged()
  }

  if (!fields) {
    return (
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-8 pt-8">
        <p className="text-ui text-muted">{t('page.title')}</p>
      </div>
    )
  }

  const providers = settings?.providers ?? []
  const models = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      ref: { providerId: provider.id, modelId: model.id },
      label: `${provider.displayName} · ${model.displayName ?? model.id}`,
      contextWindow: model.contextWindow,
    })),
  )
  const tokenCount = estimateTokens(fields.instructions)
  const primary = fields.model.mode === 'fixed' ? fields.model.primary : undefined
  const contextWindow =
    models.find(
      (m) => m.ref.providerId === primary?.providerId && m.ref.modelId === primary?.modelId,
    )?.contextWindow ?? 128_000
  const percent = Math.min(100, Math.round((tokenCount / contextWindow) * 100))
  const nextVersion = (published?.version ?? 0) + 1
  const title =
    fields.name[i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US'] || t('editor.untitled')

  const modelSelect = (
    label: string,
    model: { providerId: string; modelId: string } | undefined,
    onSelect: (ref: { providerId: string; modelId: string } | undefined) => void,
  ) => (
    <label className="block">
      <span className="mb-1 block text-[13px] text-fg2">{label}</span>
      <select
        aria-label={label}
        className={inputClass}
        value={model ? `${model.providerId}/${model.modelId}` : ''}
        onChange={(e) => {
          const [providerId, modelId] = e.target.value.split('/')
          onSelect(providerId && modelId ? { providerId, modelId } : undefined)
        }}
      >
        <option value="">{t('model.none')}</option>
        {models.map((m) => (
          <option
            key={`${m.ref.providerId}/${m.ref.modelId}`}
            value={`${m.ref.providerId}/${m.ref.modelId}`}
          >
            {m.label}
          </option>
        ))}
      </select>
    </label>
  )

  const errorsAtBasic = issuesAt(validation, 'name', 'errors').concat(
    issuesAt(validation, 'description', 'errors'),
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b-[0.5px] border-hair px-8 py-3">
        <Button variant="ghost" size="sm" onClick={back}>
          <ArrowLeft />
          {t('action.back')}
        </Button>
        <AgentAvatar icon={fields.icon} color={fields.color} size={26} />
        <h2 className="min-w-0 truncate text-ui font-medium text-fg">{title}</h2>
        {published && (
          <span className="tabular rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
            {t('version', { version: published.version })}
          </span>
        )}
        {detail?.source && (
          <span className="rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
            {t(`source.${detail.source}`)}
          </span>
        )}
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11.5px]',
            published && !dirty && 'bg-ok-soft text-ok',
            !published && 'bg-warn-soft text-warn',
            dirty && 'bg-accent-soft text-accent',
          )}
        >
          {dirty ? t('status.dirty') : published ? t('status.published') : t('status.draft')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {savedAt && !dirty && <Check aria-label={t('editor.saved')} className="size-4 text-ok" />}
          {detail?.source === 'builtin' ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void duplicate()}>
              <Copy />
              {t('new.copy')}
            </Button>
          ) : detail?.archived ? (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void duplicate()}>
                <Copy />
                {t('editor.duplicate')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void exportAgent()}>
                <Download />
                {t('editor.export')}
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void unarchive()}>
                <Upload />
                {t('editor.unarchive')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                <Save />
                {t('editor.save')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || validation?.ok === false}
                onClick={() => setConfirmPublish(true)}
              >
                {t('editor.publishVersion', { version: nextVersion })}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void duplicate()}>
                <Copy />
                {t('editor.duplicate')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void exportAgent()}>
                <Download />
                {t('editor.export')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void archive()}>
                {t('editor.archive')}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="w-[196px] shrink-0 overflow-y-auto py-4 pl-3">
          <SectionNav
            section={section}
            onSelect={setSection}
            baseline={baseline ?? fields}
            fields={fields}
            validation={validation}
            view={view}
            onView={setView}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-6 py-5">
            {readonly && (
              <p className="rounded-card bg-sunk px-3.5 py-2.5 text-note text-muted">
                {t('editor.readonly')}
              </p>
            )}
            {view === 'versions' && detail && (
              <AgentVersions
                agentId={currentId ?? detail.agentId}
                onRestore={async (next) => {
                  setDetail(next)
                  setCurrentId(next.agentId)
                  const restored = next.draft ? draftFieldsOf(next.draft) : fields
                  setFields(restored)
                  setBaseline(restored)
                  setValidation(next.validation)
                  setView('edit')
                  onChanged()
                }}
              />
            )}
            {view === 'effective' && detail && (
              <AgentEffectiveConfig agentId={currentId ?? detail.agentId} />
            )}
            {view === 'edit' && section === 'basic' && (
              <section className="flex flex-col gap-4">
                <LocalizedFields
                  idPrefix="agent-name"
                  labelZh={t('basic.nameZh')}
                  labelEn={t('basic.nameEn')}
                  value={fields.name}
                  onChange={(name) => setFields(update(fields, 'name', name))}
                />
                <LocalizedFields
                  idPrefix="agent-description"
                  labelZh={t('basic.descriptionZh')}
                  labelEn={t('basic.descriptionEn')}
                  value={fields.description}
                  onChange={(description) => setFields(update(fields, 'description', description))}
                />
                <p className="text-note text-muted">{t('basic.languageHint')}</p>
                <Issues list={errorsAtBasic} tone="error" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[13px] text-fg2">{t('basic.icon')}</span>
                    <select
                      aria-label={t('basic.icon')}
                      className={inputClass}
                      value={fields.icon ?? ''}
                      onChange={(e) =>
                        setFields(update(fields, 'icon', e.target.value || undefined))
                      }
                    >
                      <option value="">—</option>
                      {AGENT_ICON_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[13px] text-fg2">{t('basic.color')}</span>
                    <select
                      aria-label={t('basic.color')}
                      className={inputClass}
                      value={fields.color ?? ''}
                      onChange={(e) =>
                        setFields(update(fields, 'color', e.target.value || undefined))
                      }
                    >
                      <option value="">—</option>
                      {AGENT_COLOR_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[13px] text-fg2">{t('basic.tags')}</span>
                  <input
                    className={inputClass}
                    value={(fields.tags ?? []).join(', ')}
                    onChange={(e) => {
                      const tags = e.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter((tag) => tag !== '')
                      setFields(update(fields, 'tags', tags.length > 0 ? tags : undefined))
                    }}
                  />
                  <span className="mt-1 block text-note text-muted">{t('basic.tagsHint')}</span>
                </label>
              </section>
            )}
            {view === 'edit' && section === 'instructions' && (
              <section className="flex flex-col gap-2">
                <label className="block">
                  <span className="mb-1 block text-[13px] text-fg2">{t('instructions.label')}</span>
                  <textarea
                    aria-label={t('instructions.label')}
                    className={`${inputClass} h-auto min-h-[320px] resize-y py-2.5 font-mono text-[12.5px] leading-relaxed`}
                    value={fields.instructions}
                    onChange={(e) => setFields(update(fields, 'instructions', e.target.value))}
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2 text-note text-muted">
                  <span className="tabular">
                    {t('instructions.tokens', { tokens: tokenCount, percent })}
                  </span>
                  <span className="tabular">
                    {fields.instructions.length.toLocaleString()} /{' '}
                    {AGENT_INSTRUCTIONS_MAX_CHARS.toLocaleString()}
                  </span>
                </div>
                {percent >= 25 && <p className="text-note text-warn">{t('instructions.long')}</p>}
                <p className="text-note text-muted">{t('instructions.hint')}</p>
                <Issues list={issuesAt(validation, 'instructions', 'errors')} tone="error" />
              </section>
            )}
            {view === 'edit' && section === 'model' && (
              <section className="flex flex-col gap-4">
                <div>
                  <span className="mb-1 block text-[13px] text-fg2">{t('model.mode')}</span>
                  <SegmentedControl
                    label={t('model.mode')}
                    value={fields.model.mode}
                    onChange={(mode) =>
                      setFields(
                        update(fields, 'model', {
                          ...fields.model,
                          mode,
                        }),
                      )
                    }
                    options={[
                      { value: 'fixed', label: t('model.fixed') },
                      { value: 'inherit', label: t('model.inherit') },
                    ]}
                  />
                </div>
                {fields.model.mode === 'fixed' &&
                  modelSelect(t('model.primary'), fields.model.primary, (primaryModel) =>
                    setFields(
                      update(fields, 'model', {
                        ...fields.model,
                        ...(primaryModel ? { primary: primaryModel } : {}),
                      }),
                    ),
                  )}
                {modelSelect(t('model.auxiliary'), fields.model.auxiliary, (auxiliary) =>
                  setFields(
                    update(fields, 'model', {
                      ...fields.model,
                      ...(auxiliary ? { auxiliary } : {}),
                    }),
                  ),
                )}
                <p className="text-note text-muted">{t('model.auxiliaryHint')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[13px] text-fg2">
                      {t('model.temperature')}
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      className={inputClass}
                      value={fields.model.params?.temperature ?? ''}
                      onChange={(e) =>
                        setFields(
                          update(fields, 'model', {
                            ...fields.model,
                            params: {
                              ...fields.model.params,
                              ...(e.target.value === ''
                                ? {}
                                : { temperature: Number(e.target.value) }),
                            },
                          }),
                        )
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[13px] text-fg2">{t('model.maxOutput')}</span>
                    <input
                      type="number"
                      min="1"
                      className={inputClass}
                      value={fields.model.params?.maxOutputTokens ?? ''}
                      onChange={(e) =>
                        setFields(
                          update(fields, 'model', {
                            ...fields.model,
                            params: {
                              ...fields.model.params,
                              ...(e.target.value === ''
                                ? {}
                                : { maxOutputTokens: Number(e.target.value) }),
                            },
                          }),
                        )
                      }
                    />
                  </label>
                </div>
                <Issues list={issuesAt(validation, 'model', 'errors')} tone="error" />
                <Issues list={issuesAt(validation, 'model', 'warnings')} tone="warn" />
              </section>
            )}
            {view === 'edit' && section === 'capabilities' && (
              <CapabilitiesSection fields={fields} onChange={setFields} validation={validation} />
            )}
            {view === 'edit' && section === 'permissions' && (
              <section className="flex flex-col gap-3">
                {MODES.map((mode) => (
                  <label
                    key={mode}
                    className={`flex cursor-pointer items-start gap-3 rounded-card px-3.5 py-3 shadow-[0_0_0_0.5px_var(--hair2)] ${
                      fields.permissions === mode ? 'bg-accent-soft' : 'bg-raise'
                    }`}
                  >
                    <input
                      type="radio"
                      name="agent-permissions"
                      className="mt-1"
                      checked={fields.permissions === mode}
                      onChange={() => setFields(update(fields, 'permissions', mode))}
                    />
                    <span>
                      <span className="block text-ui font-medium text-fg">
                        {t(`permissions.${mode}`)}
                      </span>
                      <span className="mt-0.5 block text-note text-muted">
                        {t(`permissions.${mode}.hint`)}
                      </span>
                    </span>
                  </label>
                ))}
              </section>
            )}
            {view === 'edit' && section === 'delegation' && (
              <DelegationSection
                fields={fields}
                agents={store.agents}
                validation={validation}
                onChange={setFields}
              />
            )}
            {view === 'edit' && section === 'limits' && (
              <section className="flex flex-col gap-3">
                <p className="text-note text-muted">{t('limits.intro')}</p>
                {(
                  [
                    ['maxStepsPerTurn', 'limits.steps', 1],
                    ['maxTurnDurationMs', 'limits.duration', 60_000],
                    ['maxTokensPerTurn', 'limits.tokens', 1],
                    ['maxConsecutiveToolErrors', 'limits.toolErrors', 1],
                  ] as const
                ).map(([key, label, scale]) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-[13px] text-fg2">{t(label)}</span>
                    <input
                      type="number"
                      min="1"
                      className={inputClass}
                      value={
                        fields.limits[key] === undefined
                          ? ''
                          : Math.round(fields.limits[key]! / scale)
                      }
                      onChange={(e) =>
                        setFields(
                          update(fields, 'limits', {
                            ...fields.limits,
                            [key]:
                              e.target.value === '' ? undefined : Number(e.target.value) * scale,
                          }),
                        )
                      }
                    />
                  </label>
                ))}
              </section>
            )}
            {view === 'edit' && section === 'context' && (
              <section className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[13px] text-fg2">{t('context.agentsMd')}</span>
                  <Switch
                    aria-label={t('context.agentsMd')}
                    checked={fields.context.includeProjectInstructions}
                    onCheckedChange={(on) =>
                      setFields(
                        update(fields, 'context', {
                          ...fields.context,
                          includeProjectInstructions: on,
                        }),
                      )
                    }
                  />
                </div>
                <div>
                  <span className="mb-1 block text-[13px] text-fg2">{t('context.compaction')}</span>
                  <SegmentedControl
                    label={t('context.compaction')}
                    value={fields.context.compaction}
                    onChange={(compaction) =>
                      setFields(update(fields, 'context', { ...fields.context, compaction }))
                    }
                    options={[
                      { value: 'auto', label: t('context.auto') },
                      { value: 'off', label: t('context.off') },
                    ]}
                  />
                </div>
                <label className="block">
                  <span className="mb-1 block text-[13px] text-fg2">{t('context.reserve')}</span>
                  <input
                    type="number"
                    min="1"
                    className={inputClass}
                    value={fields.context.reserveOutputTokens ?? ''}
                    onChange={(e) =>
                      setFields(
                        update(fields, 'context', {
                          ...fields.context,
                          ...(e.target.value === ''
                            ? { reserveOutputTokens: undefined }
                            : { reserveOutputTokens: Number(e.target.value) }),
                        }),
                      )
                    }
                  />
                </label>
              </section>
            )}
            {view === 'edit' && section === 'memory' && (
              <section className="flex flex-col gap-2">
                <span className="inline-flex w-fit rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
                  {t('memory.coming')}
                </span>
                <p className="text-note leading-relaxed text-muted">{t('memory.description')}</p>
              </section>
            )}
            {dirtySections.size > 0 && view === 'edit' && (
              <p className="sr-only">{t('section.pending')}</p>
            )}
          </div>
        </div>
      </div>

      <Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <DialogContent>
          <DialogTitle>{t('editor.leave.title')}</DialogTitle>
          <DialogDescription>{t('editor.leave.description')}</DialogDescription>
          <DialogFooter className="grid-cols-1">
            <Button variant="primary" onClick={() => void leave(true)}>
              {t('editor.leave.save')}
            </Button>
            <Button variant="secondary" onClick={() => void leave('discard')}>
              {t('editor.leave.discard')}
            </Button>
            <DialogClose asChild>
              <Button variant="ghost">{t('editor.leave.cancel')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <DialogContent>
          <DialogTitle>{t('publish.title')}</DialogTitle>
          <DialogDescription>
            {published
              ? t('publish.changes', {
                  version: published.version,
                  fields:
                    dirtySections.size > 0
                      ? [...dirtySections].map((id) => t(`section.${id}`)).join('、')
                      : t('publish.noChanges'),
                })
              : t('publish.first')}
          </DialogDescription>
          {(validation?.warnings.length ?? 0) > 0 && (
            <div className="mt-3">
              <p className="text-note font-medium text-warn">{t('publish.warnings')}</p>
              <Issues list={validation!.warnings} tone="warn" />
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('editor.leave.cancel')}</Button>
            </DialogClose>
            <Button variant="primary" disabled={busy} onClick={() => void publish()}>
              {t('publish.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CapabilitiesSection({
  fields,
  onChange,
  validation,
}: {
  readonly fields: AgentDraftFields
  readonly onChange: (fields: AgentDraftFields) => void
  readonly validation: AgentValidationResult | undefined
}) {
  const { t } = useTranslation('agents')
  const listSkills = useSessionStore((s) => s.listSkills)
  const listMcpServers = useSessionStore((s) => s.listMcpServers)
  const [skills, setSkills] = useState<readonly { name: string }[]>([])
  const [servers, setServers] = useState<readonly { serverId: string; name: string }[]>([])

  useEffect(() => {
    let cancelled = false
    void listSkills().then((list) => {
      if (!cancelled && list) setSkills(list.map((skill) => ({ name: skill.name })))
    })
    void listMcpServers().then((list) => {
      if (!cancelled && list)
        setServers(list.map((server) => ({ serverId: server.serverId, name: server.name })))
    })
    return () => {
      cancelled = true
    }
  }, [listSkills, listMcpServers])

  const allTools = fields.tools.allow.includes('*')
  const mcpSelectors = fields.tools.allow.filter((item) => item.startsWith('mcp:'))
  const allSkills = fields.skills.allow.includes('*')
  return (
    <section className="flex flex-col gap-6">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-fg">{t('capabilities.tools')}</span>
          <label className="flex items-center gap-2 text-note text-fg2">
            {t('capabilities.allTools')}
            <Switch
              aria-label={t('capabilities.allTools')}
              checked={allTools}
              onCheckedChange={(on) =>
                onChange(
                  update(fields, 'tools', {
                    ...fields.tools,
                    allow: on ? ['*'] : [],
                  }),
                )
              }
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CATEGORIES.map((category) => (
            <label
              key={category}
              className="flex items-center gap-2 rounded-item bg-raise px-3 py-2 text-ui text-fg2 shadow-hair2"
            >
              <input
                type="checkbox"
                checked={fields.tools.allow.includes(category)}
                disabled={allTools}
                onChange={() =>
                  onChange(
                    update(fields, 'tools', {
                      ...fields.tools,
                      allow: toggleInList(fields.tools.allow, category),
                    }),
                  )
                }
              />
              {t(`capabilities.category.${category}`)}
            </label>
          ))}
        </div>
        <Issues list={issuesAt(validation, 'tools', 'errors')} tone="error" />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-fg">{t('capabilities.skills')}</span>
          <label className="flex items-center gap-2 text-note text-fg2">
            {t('capabilities.allSkills')}
            <Switch
              aria-label={t('capabilities.allSkills')}
              checked={allSkills}
              onCheckedChange={(on) =>
                onChange(
                  update(fields, 'skills', {
                    ...fields.skills,
                    allow: on ? ['*'] : [],
                  }),
                )
              }
            />
          </label>
        </div>
        {skills.length === 0 ? (
          <p className="text-note text-muted">{t('capabilities.noSkills')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {skills.map((skill) => (
              <label key={skill.name} className="flex items-center gap-2 text-ui text-fg2">
                <input
                  type="checkbox"
                  checked={allSkills || fields.skills.allow.includes(skill.name)}
                  disabled={allSkills}
                  onChange={() =>
                    onChange(
                      update(fields, 'skills', {
                        ...fields.skills,
                        allow: toggleInList(fields.skills.allow, skill.name),
                      }),
                    )
                  }
                />
                <code className="font-mono text-[12.5px]">{skill.name}</code>
              </label>
            ))}
          </div>
        )}
        <Issues list={issuesAt(validation, 'skills', 'errors')} tone="error" />
      </div>

      <div>
        <span className="mb-2 block text-[13px] font-medium text-fg">{t('capabilities.mcp')}</span>
        {servers.length === 0 ? (
          <p className="text-note text-muted">{t('capabilities.noMcp')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {servers.map((server) => {
              const selector = `mcp:${server.serverId}`
              return (
                <label key={server.serverId} className="flex items-center gap-2 text-ui text-fg2">
                  <input
                    type="checkbox"
                    checked={mcpSelectors.includes(selector)}
                    onChange={() =>
                      onChange(
                        update(fields, 'tools', {
                          ...fields.tools,
                          allow: toggleInList(fields.tools.allow, selector),
                        }),
                      )
                    }
                  />
                  {server.name}
                </label>
              )
            })}
          </div>
        )}
        <p className="mt-1 text-note text-muted">{t('capabilities.mcpHint')}</p>
      </div>
    </section>
  )
}
