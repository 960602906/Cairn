/**
 * 团队模板编辑器（M7-09，多 Agent 协作 §15）：基本信息、主控与成员、协作模式、校验、发布与试运行。
 *
 * 校验在本地用 `validateAgentTeam` 实时计算，与主进程保存 / 发布同一套规则；引用的 Agent 定义
 * 按需读取（只读已发布版本，与主进程一致）。新建模板第一次保存前没有 id，试运行会先保存。
 */
import {
  AlertCircle,
  ArrowLeft,
  Check,
  FileText,
  Play,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
  UsersRound,
  Workflow,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TEAM_MAX_MEMBERS,
  TEAM_MAX_PIPELINE_STAGES,
  TEAM_MAX_REVIEW_ROUNDS,
  type AgentDefinition,
  type AgentTeamDetail,
  type TeamDraftFields,
  type TeamValidationIssue,
} from '@cairn/protocol'
import { agentName, localized } from '../agents/model.js'
import { inputClass, SettingsCard, SettingsGroup } from '../settings/Field.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  SegmentedControl,
  cn,
} from '../ui/index.js'
import { TeamTrial } from './TeamTrial.js'
import {
  appendStage,
  coordinatorCandidates,
  defaultTeamDraft,
  memberCandidates,
  normalizeTeamFields,
  referencedAgents,
  removeStage,
  sameTeamFields,
  seedPipeline,
  setStageDependencies,
  stageDependencyOptions,
  teamFieldsOf,
  teamIssues,
  TEAM_PATTERNS,
  toggleMember,
  validateTeamFields,
  type TeamSection,
} from './model.js'

/** 校验问题列表：错误与警告分别用红色 / 黄色显示，消息按 code 翻译。 */
function IssueList({
  issues,
  tone,
}: {
  readonly issues: readonly TeamValidationIssue[]
  readonly tone: 'error' | 'warn'
}) {
  const { t } = useTranslation('teams')
  if (issues.length === 0) return null
  return (
    <ul
      aria-label={t(tone === 'error' ? 'issues.errors' : 'issues.warnings')}
      className={cn(
        'flex flex-col gap-1.5 rounded-card px-3.5 py-2.5 text-note',
        tone === 'error' ? 'bg-warn-soft text-warn' : 'bg-sunk text-muted',
      )}
    >
      {issues.map((issue, index) => {
        const key = `issue.${issue.code}` as unknown as Parameters<typeof t>[0]
        return (
          <li key={`${issue.path}-${issue.code}-${index}`} className="flex items-start gap-1.5">
            {tone === 'error' ? (
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>{t(key, issue.params ?? {})}</span>
          </li>
        )
      })}
    </ul>
  )
}

export function TeamEditor({
  teamId,
  onBack,
  onChanged,
}: {
  /** 已有模板的 id；新建时为 undefined。 */
  readonly teamId: string | undefined
  readonly onBack: () => void
  readonly onChanged: () => void
}) {
  const { t, i18n } = useTranslation('teams')
  const agents = useSessionStore((s) => s.agents)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  const getTeam = useSessionStore((s) => s.getTeam)
  const saveTeamDraft = useSessionStore((s) => s.saveTeamDraft)
  const publishTeam = useSessionStore((s) => s.publishTeam)
  const getAgent = useSessionStore((s) => s.getAgent)

  // 新建草稿只初始化一次；已有模板等 `getTeam` 读取后再填。
  const [initialFields] = useState<TeamDraftFields | undefined>(() =>
    teamId === undefined ? defaultTeamDraft(agents) : undefined,
  )
  const [currentId, setCurrentId] = useState<string | undefined>(teamId)
  const [detail, setDetail] = useState<AgentTeamDetail | undefined>()
  const [fields, setFields] = useState<TeamDraftFields | undefined>(initialFields)
  const [baseline, setBaseline] = useState<TeamDraftFields | undefined>(initialFields)
  const [loading, setLoading] = useState(teamId !== undefined)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [trialOpen, setTrialOpen] = useState(false)
  const [definitions, setDefinitions] = useState<Readonly<Record<string, AgentDefinition>>>({})
  const [pendingAgents, setPendingAgents] = useState(0)
  const requestedAgents = useRef(new Set<string>())

  useEffect(() => {
    void refreshAgents({ includeArchived: true })
  }, [refreshAgents])

  useEffect(() => {
    if (teamId === undefined) return
    let cancelled = false
    setLoading(true)
    void getTeam(teamId).then((next) => {
      if (cancelled) return
      setLoading(false)
      if (!next) return
      const restored = teamFieldsOf(next)
      if (!restored) return
      setDetail(next)
      setCurrentId(next.teamId)
      setFields(restored)
      setBaseline(restored)
    })
    return () => {
      cancelled = true
    }
  }, [getTeam, teamId])

  // 引用到的 Agent 定义按需读取一次；只取已发布版本，与主进程的校验上下文一致。
  const refsKey = fields ? referencedAgents(fields).join('\n') : ''
  useEffect(() => {
    const ids = (refsKey === '' ? [] : refsKey.split('\n')).filter(
      (agentId) => !requestedAgents.current.has(agentId),
    )
    if (ids.length === 0) return
    for (const agentId of ids) requestedAgents.current.add(agentId)
    setPendingAgents((count) => count + ids.length)
    void Promise.all(ids.map(async (agentId) => ({ agentId, detail: await getAgent(agentId) })))
      .then((entries) => {
        setDefinitions((previous) => {
          const next = { ...previous }
          for (const entry of entries) {
            if (entry.detail?.published) next[entry.agentId] = entry.detail.published
          }
          return next
        })
      })
      .finally(() => setPendingAgents((count) => Math.max(0, count - ids.length)))
  }, [getAgent, refsKey])

  const localValidation = useMemo(
    () => (fields ? validateTeamFields(fields, definitions) : undefined),
    [definitions, fields],
  )
  const validation = pendingAgents === 0 ? localValidation : detail?.validation
  const dirty = fields !== undefined && baseline !== undefined && !sameTeamFields(fields, baseline)
  const published = detail?.published
  const status = dirty ? 'dirty' : published ? 'published' : 'draft'
  const nextVersion = (published?.version ?? 0) + 1
  const title =
    fields === undefined
      ? t('editor.untitled')
      : localized(fields.name, i18n.language, t('editor.untitled'))

  const change = useCallback((patch: Partial<TeamDraftFields>) => {
    setFields((current) =>
      current === undefined ? current : normalizeTeamFields({ ...current, ...patch }),
    )
  }, [])

  const save = useCallback(async (): Promise<string | undefined> => {
    if (!fields || saving) return undefined
    setSaving(true)
    const next = await saveTeamDraft({
      ...fields,
      ...(currentId === undefined ? {} : { id: currentId }),
    })
    setSaving(false)
    if (!next) return undefined
    setCurrentId(next.teamId)
    setDetail(next)
    const saved = teamFieldsOf(next) ?? fields
    setFields(saved)
    setBaseline(saved)
    setSavedAt(true)
    onChanged()
    return next.teamId
  }, [currentId, fields, onChanged, saveTeamDraft, saving])

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
      const id = await save()
      if (id === undefined) return
    }
    setConfirmLeave(false)
    onBack()
  }

  const back = () => {
    if (dirty) setConfirmLeave(true)
    else onBack()
  }

  // 编辑器里的 Esc 先回到列表（并走未保存确认），不冒泡给设置页的 Esc 返回对话。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
        )
      )
        return
      event.preventDefault()
      event.stopPropagation()
      back()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  /** 试运行读取已保存的草稿：新建、有改动或发布后草稿被清空时都先保存。 */
  const openTrial = async () => {
    if (currentId === undefined || dirty || detail?.draft === undefined) {
      const saved = await save()
      if (saved === undefined) return
    }
    setTrialOpen(true)
  }

  const publish = async () => {
    setBusy(true)
    let id = currentId
    // 发布读的是草稿；刚发布过的模板没有草稿，需要先用当前内容建一份。
    if (id === undefined || dirty || detail?.draft === undefined) {
      const saved = fields
        ? await saveTeamDraft({ ...fields, ...(id === undefined ? {} : { id }) })
        : undefined
      if (!saved) {
        setBusy(false)
        return
      }
      id = saved.teamId
      setCurrentId(id)
      setDetail(saved)
      const nextFields = teamFieldsOf(saved) ?? fields
      if (nextFields) {
        setFields(nextFields)
        setBaseline(nextFields)
      }
    }
    if (id === undefined) {
      setBusy(false)
      return
    }
    const next = await publishTeam(id)
    setBusy(false)
    setConfirmPublish(false)
    if (!next) return
    setCurrentId(next.teamId)
    setDetail(next)
    const publishedFields = teamFieldsOf(next)
    if (publishedFields) {
      setFields(publishedFields)
      setBaseline(publishedFields)
    }
    setSavedAt(true)
    onChanged()
  }

  if (loading || fields === undefined) {
    return (
      <div className="flex w-full flex-col gap-5">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft />
            {t('editor.back')}
          </Button>
        </div>
        <p className="text-ui text-muted">
          {loading ? t('editor.loading') : t('editor.loadFailed')}
        </p>
      </div>
    )
  }

  const coordinatorOptions = coordinatorCandidates(agents)
  const coordinator =
    fields.coordinator === ''
      ? undefined
      : agents.find((agent) => agent.agentId === fields.coordinator)
  const members = memberCandidates(agents, fields.coordinator)
  const nameOf = (agentId: string): string => {
    const agent = agents.find((candidate) => candidate.agentId === agentId)
    return agent ? agentName(agent, i18n.language) : agentId
  }
  const referenced = referencedAgents(fields)
  const reviewLoop = fields.reviewLoop
  const stages = fields.pipeline ?? []
  const validationIssues = (section: TeamSection, kind: 'errors' | 'warnings') =>
    teamIssues(validation, section, kind)
  const invalid = validation?.ok === false || pendingAgents > 0
  const canTrial =
    !busy && !saving && fields.coordinator !== '' && invalid === false && agents.length > 0

  const updateName = (language: 'zh-CN' | 'en-US', value: string) =>
    change({ name: { ...fields.name, [language]: value } })
  const updateDescription = (language: 'zh-CN' | 'en-US', value: string) =>
    change({ description: { ...fields.description, [language]: value } })

  const changeCoordinator = (agentId: string) => {
    change({
      coordinator: agentId,
      members: fields.members.filter((member) => member !== agentId),
    })
  }

  const changePattern = (pattern: TeamDraftFields['pattern']) => {
    change({ pattern })
  }

  const changeReview = (patch: Partial<NonNullable<TeamDraftFields['reviewLoop']>>) => {
    if (reviewLoop === undefined) return
    change({ reviewLoop: { ...reviewLoop, ...patch } })
  }

  const selectReviewAgent = (role: 'maker' | 'checker', agentId: string) => {
    if (agentId === '') return
    if (reviewLoop === undefined) {
      const other = referenced.find((agent) => agent !== agentId) ?? agentId
      change({
        reviewLoop: {
          maker: role === 'maker' ? agentId : other,
          checker: role === 'checker' ? agentId : other,
          maxRounds: 3,
        },
      })
      return
    }
    changeReview({ [role]: agentId })
  }

  const changeStageAgent = (stageId: string, agentId: string) => {
    change({
      pipeline: stages.map((stage) =>
        stage.stage === stageId ? { ...stage, agent: agentId } : stage,
      ),
    })
  }

  const addStage = () => {
    const agent = fields.coordinator !== '' ? fields.coordinator : (fields.members[0] ?? '')
    if (agent === '' || stages.length >= TEAM_MAX_PIPELINE_STAGES) return
    change({ pipeline: appendStage(stages, agent) })
  }

  return (
    <div className="flex w-full flex-col gap-5">
      <header className="flex flex-wrap items-center gap-2 border-b-[0.5px] border-hair pb-3">
        <Button variant="ghost" size="sm" className="shrink-0" onClick={back}>
          <ArrowLeft />
          {t('editor.back')}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent shadow-hair [&_svg]:size-4"
          >
            <UsersRound />
          </span>
          <h2 className="min-w-0 truncate text-ui font-medium text-fg">{title}</h2>
          {published && (
            <span className="tabular shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[11.5px] text-muted">
              {t('version', { version: published.version })}
            </span>
          )}
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[11.5px]',
              status === 'published' && 'bg-ok-soft text-ok',
              status === 'draft' && 'bg-warn-soft text-warn',
              status === 'dirty' && 'bg-accent-soft text-accent',
            )}
          >
            {t(`status.${status}`)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {savedAt && !dirty && <Check aria-label={t('editor.saved')} className="size-4 text-ok" />}
          <Button
            variant="ghost"
            size="sm"
            disabled={!canTrial}
            title={invalid ? t('editor.fixBeforeTrial') : undefined}
            onClick={() => void openTrial()}
          >
            <Play />
            {t('editor.trial')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving || fields.coordinator === '' || (currentId !== undefined && !dirty)}
            onClick={() => void save()}
          >
            <Save />
            {t('editor.save')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || saving || invalid || fields.coordinator === ''}
            onClick={() => setConfirmPublish(true)}
          >
            {t('editor.publish', { version: nextVersion })}
          </Button>
        </div>
      </header>

      {validationIssues('basic', 'errors').length === 0 &&
        validationIssues('members', 'errors').length === 0 &&
        validationIssues('pattern', 'errors').length === 0 &&
        !dirty &&
        published && <p className="text-note text-muted">{t('editor.noChanges')}</p>}

      <SettingsGroup
        icon={<FileText />}
        title={t('editor.basic.title')}
        description={t('editor.basic.description')}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[13px] text-fg2">{t('editor.basic.nameZh')}</span>
            <input
              className={inputClass}
              maxLength={200}
              value={fields.name['zh-CN'] ?? ''}
              onChange={(e) => updateName('zh-CN', e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] text-fg2">{t('editor.basic.nameEn')}</span>
            <input
              className={inputClass}
              maxLength={200}
              value={fields.name['en-US'] ?? ''}
              onChange={(e) => updateName('en-US', e.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[13px] text-fg2">
              {t('editor.basic.descriptionZh')}
            </span>
            <textarea
              className={`${inputClass} min-h-20 resize-none py-2`}
              maxLength={200}
              value={fields.description['zh-CN'] ?? ''}
              onChange={(e) => updateDescription('zh-CN', e.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[13px] text-fg2">
              {t('editor.basic.descriptionEn')}
            </span>
            <textarea
              className={`${inputClass} min-h-20 resize-none py-2`}
              maxLength={200}
              value={fields.description['en-US'] ?? ''}
              onChange={(e) => updateDescription('en-US', e.target.value)}
            />
          </label>
        </div>
        <p className="text-note text-muted">{t('editor.basic.languageHint')}</p>
        <IssueList issues={validationIssues('basic', 'errors')} tone="error" />
        <IssueList issues={validationIssues('basic', 'warnings')} tone="warn" />
      </SettingsGroup>

      <SettingsGroup
        icon={<UsersRound />}
        title={t('editor.members.title')}
        description={t('editor.members.description')}
      >
        <label className="block">
          <span className="mb-1 block text-[13px] text-fg2">{t('editor.members.coordinator')}</span>
          <select
            aria-label={t('editor.members.coordinator')}
            className={inputClass}
            value={fields.coordinator}
            onChange={(e) => changeCoordinator(e.target.value)}
          >
            <option value="">{t('editor.members.chooseCoordinator')}</option>
            {fields.coordinator !== '' &&
              !coordinatorOptions.some((agent) => agent.agentId === fields.coordinator) && (
                <option value={fields.coordinator}>{nameOf(fields.coordinator)}</option>
              )}
            {coordinatorOptions.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                {agentName(agent, i18n.language)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-note text-muted">{t('editor.members.coordinatorHint')}</p>
        {coordinator === undefined && agents.length > 0 && (
          <p className="text-note text-muted">{t('editor.members.noCoordinator')}</p>
        )}
        {agents.length === 0 && (
          <p className="text-note text-warn">{t('editor.members.noAgents')}</p>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[13px] text-fg2">{t('editor.members.members')}</span>
            <span className="tabular text-note text-faint">
              {t('editor.members.count', { count: fields.members.length })}
            </span>
          </div>
          {members.length === 0 ? (
            <p className="text-note text-muted">{t('editor.members.noMembers')}</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {members.map((agent) => {
                const checked = fields.members.includes(agent.agentId)
                return (
                  <label
                    key={agent.agentId}
                    className="flex items-center gap-2 rounded-item px-1.5 py-1 text-ui text-fg2 hover:bg-sunk"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && fields.members.length >= TEAM_MAX_MEMBERS}
                      onChange={() =>
                        change({ members: toggleMember(fields.members, agent.agentId) })
                      }
                    />
                    <span className="truncate">{agentName(agent, i18n.language)}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <IssueList issues={validationIssues('members', 'errors')} tone="error" />
        <IssueList issues={validationIssues('members', 'warnings')} tone="warn" />
      </SettingsGroup>

      <SettingsGroup
        icon={<Workflow />}
        title={t('editor.pattern.title')}
        description={t('editor.pattern.description')}
      >
        <SegmentedControl
          label={t('editor.pattern.label')}
          value={fields.pattern}
          onChange={changePattern}
          options={TEAM_PATTERNS.map((value) => ({ value, label: t(`pattern.${value}`) }))}
        />
        <p className="text-note text-muted">{t(`editor.pattern.hint.${fields.pattern}`)}</p>

        {fields.pattern === 'review-loop' && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[13px] text-fg2">{t('editor.pattern.maker')}</span>
                <select
                  aria-label={t('editor.pattern.maker')}
                  className={inputClass}
                  value={reviewLoop?.maker ?? ''}
                  disabled={referenced.length === 0}
                  onChange={(e) => selectReviewAgent('maker', e.target.value)}
                >
                  <option value="">{t('editor.pattern.chooseAgent')}</option>
                  {reviewLoop !== undefined &&
                    !referenced.includes(reviewLoop.maker) &&
                    reviewLoop.maker !== '' && (
                      <option value={reviewLoop.maker}>{nameOf(reviewLoop.maker)}</option>
                    )}
                  {referenced.map((agentId) => (
                    <option key={agentId} value={agentId}>
                      {nameOf(agentId)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] text-fg2">
                  {t('editor.pattern.checker')}
                </span>
                <select
                  aria-label={t('editor.pattern.checker')}
                  className={inputClass}
                  value={reviewLoop?.checker ?? ''}
                  disabled={referenced.length === 0}
                  onChange={(e) => selectReviewAgent('checker', e.target.value)}
                >
                  <option value="">{t('editor.pattern.chooseAgent')}</option>
                  {reviewLoop !== undefined &&
                    !referenced.includes(reviewLoop.checker) &&
                    reviewLoop.checker !== '' && (
                      <option value={reviewLoop.checker}>{nameOf(reviewLoop.checker)}</option>
                    )}
                  {referenced.map((agentId) => (
                    <option key={agentId} value={agentId}>
                      {nameOf(agentId)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block max-w-[220px]">
              <span className="mb-1 block text-[13px] text-fg2">
                {t('editor.pattern.maxRounds')}
              </span>
              <input
                type="number"
                min="1"
                max={TEAM_MAX_REVIEW_ROUNDS}
                className={inputClass}
                value={reviewLoop?.maxRounds ?? 3}
                disabled={reviewLoop === undefined}
                onChange={(e) => {
                  const value = Math.round(Number(e.target.value))
                  if (!Number.isFinite(value)) return
                  changeReview({
                    maxRounds: Math.min(TEAM_MAX_REVIEW_ROUNDS, Math.max(1, value)),
                  })
                }}
              />
            </label>
            <p className="text-note text-muted">{t('editor.pattern.reviewHint')}</p>
          </div>
        )}

        {fields.pattern === 'pipeline' && (
          <div className="flex flex-col gap-3">
            {stages.length === 0 ? (
              <p className="text-note text-muted">{t('editor.pattern.pipelineEmpty')}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {stages.map((stage, index) => {
                  const dependencies = stage.dependsOn ?? []
                  return (
                    <li
                      key={stage.stage}
                      className="flex flex-col gap-2.5 rounded-card bg-paper px-3.5 py-3 shadow-hair2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="tabular text-note text-faint">
                          {t('editor.pattern.stage', { number: index + 1 })}
                        </span>
                        <IconButton
                          label={t('editor.pattern.removeStage', { number: index + 1 })}
                          size="icon-sm"
                          className="ml-auto"
                          onClick={() => change({ pipeline: removeStage(stages, stage.stage) })}
                        >
                          <Trash2 />
                        </IconButton>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span className="mb-1 block text-[13px] text-fg2">
                            {t('editor.pattern.stageAgent')}
                          </span>
                          <select
                            aria-label={t('editor.pattern.stageAgent')}
                            className={inputClass}
                            value={stage.agent}
                            onChange={(e) => changeStageAgent(stage.stage, e.target.value)}
                          >
                            {!referenced.includes(stage.agent) && (
                              <option value={stage.agent}>{nameOf(stage.agent)}</option>
                            )}
                            {referenced.map((agentId) => (
                              <option key={agentId} value={agentId}>
                                {nameOf(agentId)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div>
                          <span className="mb-1 block text-[13px] text-fg2">
                            {t('editor.pattern.dependsOn')}
                          </span>
                          {stageDependencyOptions(stages, stage.stage).length === 0 ? (
                            <p className="pt-1.5 text-note text-faint">
                              {t('editor.pattern.noDependencies')}
                            </p>
                          ) : (
                            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
                              {stageDependencyOptions(stages, stage.stage).map((option) => {
                                const number =
                                  stages.findIndex(
                                    (candidate) => candidate.stage === option.stage,
                                  ) + 1
                                return (
                                  <label
                                    key={option.stage}
                                    className="flex items-center gap-1.5 text-ui text-fg2"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={dependencies.includes(option.stage)}
                                      onChange={() =>
                                        change({
                                          pipeline: setStageDependencies(
                                            stages,
                                            stage.stage,
                                            dependencies.includes(option.stage)
                                              ? dependencies.filter(
                                                  (dependency) => dependency !== option.stage,
                                                )
                                              : [...dependencies, option.stage],
                                          ),
                                        })
                                      }
                                    />
                                    {t('editor.pattern.stageDependency', { number })}
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={stages.length >= TEAM_MAX_PIPELINE_STAGES || referenced.length === 0}
                onClick={addStage}
              >
                <Plus />
                {t('editor.pattern.addStage')}
              </Button>
              {stages.length > 0 && stages.length < referenced.length && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => change({ pipeline: seedPipeline(referenced) })}
                >
                  {t('editor.pattern.fillStages')}
                </Button>
              )}
            </div>
            <p className="text-note text-muted">{t('editor.pattern.pipelineHint')}</p>
          </div>
        )}

        <IssueList issues={validationIssues('pattern', 'errors')} tone="error" />
        <IssueList issues={validationIssues('pattern', 'warnings')} tone="warn" />
        {validationIssues('pattern', 'warnings').length > 0 && fields.pattern === 'delegate' && (
          <p className="text-note text-muted">{t('editor.pattern.ignoredHint')}</p>
        )}
      </SettingsGroup>

      <SettingsCard className="gap-2 bg-sunk/60 py-4">
        <p className="text-note leading-relaxed text-muted">{t('editor.footer')}</p>
      </SettingsCard>

      <Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <DialogContent>
          <DialogTitle>{t('editor.leave.title')}</DialogTitle>
          <DialogDescription>{t('editor.leave.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('editor.leave.cancel')}</Button>
            </DialogClose>
            <Button variant="ghost" onClick={() => void leave('discard')}>
              {t('editor.leave.discard')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void leave(true)}>
              {t('editor.leave.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <DialogContent>
          <DialogTitle>{t('editor.publishConfirm.title', { version: nextVersion })}</DialogTitle>
          <DialogDescription>
            {t('editor.publishConfirm.description', { count: fields.members.length + 1 })}
          </DialogDescription>
          {validation && validation.warnings.length > 0 && (
            <div className="mt-3">
              <p className="text-note font-medium text-warn">
                {t('editor.publishConfirm.warnings')}
              </p>
              <IssueList issues={validation.warnings} tone="warn" />
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('editor.leave.cancel')}</Button>
            </DialogClose>
            <Button variant="primary" disabled={busy} onClick={() => void publish()}>
              {t('editor.publishConfirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {currentId !== undefined && (
        <TeamTrial
          teamId={currentId}
          configKey={JSON.stringify(fields)}
          open={trialOpen}
          onOpenChange={setTrialOpen}
        />
      )}
    </div>
  )
}
