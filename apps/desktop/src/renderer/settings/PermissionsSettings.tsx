/**
 * 设置页“权限与审批”（M2-11，视觉规范 §8）。
 *
 * - 权限模式：只读 / 询问 / 自动三张卡片，选择后立即保存（与输入框下方的切换相同）。
 * - 规则：当前模式的预设（内置，不能删除），再是保存的全局与项目规则（手动添加或在审批卡片中“始终允许”），
 *   每行是效果、规则（工具与路径或命令）、来源与范围，可以删除。同时匹配多条规则时取最严格的结果（拒绝 >
 *   询问 > 允许，权限引擎 M1-10a），顺序不影响结果，因此不提供调整顺序。
 * - 添加规则：效果、工具（或不限工具）、路径或命令模式、范围（全局或某个项目）。
 * - 底部说明哪些操作无论规则如何都会再次询问（强制拦截，M1-10b）。
 *
 * 增删规则后，运行中的会话立即改用新规则（主进程通知宿主）。
 */
import type { PermissionMode, PermissionRule, PermissionRuleEntry } from '@cairn/protocol'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store-context.js'
import { Button, cn, IconButton, SegmentedControl } from '../ui/index.js'
import { Field, inputClass, SettingsCard } from './Field.js'
import {
  GLOBAL_SCOPE,
  newRuleDraft,
  presetRows,
  RULE_EFFECTS,
  RULE_TOOLS,
  ruleDraftProblem,
  ruleFromDraft,
  ruleRows,
  ruleText,
  targetOf,
  type RuleDraft,
  type RuleRow,
  type RuleTool,
} from './permissions-model.js'
import { SettingsHeader } from './SettingsPage.js'

const MODES: readonly PermissionMode[] = ['read-only', 'ask', 'auto']
const DEFAULT_MODE: PermissionMode = 'ask'

function ModeCards() {
  const { t } = useTranslation('settings')
  const mode = useSessionStore((s) => s.settings?.permissionMode) ?? DEFAULT_MODE
  const updateSettings = useSessionStore((s) => s.updateSettings)
  return (
    <div
      role="radiogroup"
      aria-label={t('permissions.mode.label')}
      className="grid grid-cols-3 gap-2 max-[640px]:grid-cols-1"
    >
      {MODES.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === mode}
          onClick={() => option !== mode && void updateSettings({ permissionMode: option })}
          className={cn(
            'flex flex-col gap-0.5 rounded-[10px] bg-paper px-3 py-2.5 text-left shadow-[inset_0_0_0_0.5px_var(--hair2)] transition-colors',
            option === mode && 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]',
          )}
        >
          <span className="text-ui font-medium text-fg">
            {t(`permissions.mode.${option}.name`)}
          </span>
          <span className="text-[11.5px] text-muted">{t(`permissions.mode.${option}.hint`)}</span>
        </button>
      ))}
    </div>
  )
}

const EFFECT_TONES = {
  allow: 'bg-ok-soft text-ok',
  ask: 'bg-warn-soft text-warn',
  deny: 'bg-danger-soft text-danger',
} as const

/** 规则的文字，例如 `run_command: npm test`；只按类别匹配时是类别名称。 */
function useRuleLabel() {
  const { t } = useTranslation('settings')
  return (rule: PermissionRule) => {
    const { tools, categories, patterns } = ruleText(rule)
    const subject =
      tools.length > 0
        ? tools.join(', ')
        : categories.length > 0
          ? categories.map((c) => t(`permissions.category.${c}`)).join(t('permissions.separator'))
          : t('permissions.anyTool')
    return patterns.length > 0
      ? t('permissions.rule.text', { subject, patterns: patterns.join(', ') })
      : subject
  }
}

function RuleItem({
  row,
  projectName,
  mode,
  onDelete,
}: {
  readonly row: RuleRow
  readonly projectName: (projectId: string) => string
  readonly mode: PermissionMode
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const label = useRuleLabel()(row.rule)
  const { rule } = row
  const source =
    rule.source === 'preset'
      ? t('permissions.source.preset', { mode: t(`permissions.mode.${mode}.name`) })
      : t('permissions.source.saved', {
          source: t(`permissions.source.${rule.source}`),
          scope:
            row.projectId !== undefined
              ? projectName(row.projectId)
              : t('permissions.scope.global'),
        })
  return (
    <li className="grid grid-cols-[62px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2.5 text-ui [&+li]:shadow-[0_-0.5px_0_var(--hair)]">
      <span
        className={cn(
          'rounded-[5px] py-px text-center text-[11.5px] font-medium',
          EFFECT_TONES[rule.effect],
        )}
      >
        {t(`permissions.effect.${rule.effect}`)}
      </span>
      <code className="truncate font-mono text-[12.5px] text-fg" title={label}>
        {label}
      </code>
      <span className="flex items-center gap-1 text-[11.5px] whitespace-nowrap text-muted">
        {source}
        {row.removable ? (
          <IconButton
            label={t('permissions.delete', { rule: label })}
            size="icon-sm"
            onClick={onDelete}
          >
            <Trash2 />
          </IconButton>
        ) : (
          // 与删除按钮同宽，各行的来源对齐
          <span aria-hidden className="inline-block size-7" />
        )}
      </span>
    </li>
  )
}

function RuleForm({
  onAdded,
  onCancel,
}: {
  readonly onAdded: (entry: PermissionRuleEntry) => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const projects = useSessionStore((s) => s.projects)
  const addPermissionRule = useSessionStore((s) => s.addPermissionRule)
  const [draft, setDraft] = useState<RuleDraft>(newRuleDraft)
  const [busy, setBusy] = useState(false)
  const toolId = useId()
  const patternId = useId()
  const scopeId = useId()
  const target = targetOf(draft.tool)
  const problem = ruleDraftProblem(draft)
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const selectClass = cn(inputClass, 'w-64')

  const submit = async () => {
    const built = ruleFromDraft(draft, `user.${globalThis.crypto.randomUUID()}`)
    if (!built) return
    setBusy(true)
    const entry = await addPermissionRule(built.rule, built.projectId)
    setBusy(false)
    if (entry) onAdded(entry)
  }

  return (
    <SettingsCard aria-label={t('permissions.form.title')}>
      <h3 className="text-[15px] font-semibold text-fg">{t('permissions.form.title')}</h3>
      <Field label={t('permissions.form.effect')}>
        <SegmentedControl
          label={t('permissions.form.effect')}
          value={draft.effect}
          options={RULE_EFFECTS.map((value) => ({
            value,
            label: t(`permissions.effect.${value}`),
          }))}
          onChange={(effect) => set({ effect })}
        />
      </Field>
      <Field label={t('permissions.form.tool')} labelFor={toolId}>
        <select
          id={toolId}
          className={selectClass}
          value={draft.tool}
          onChange={(e) => set({ tool: e.target.value as RuleTool })}
        >
          {RULE_TOOLS.map(({ name }) => (
            <option key={name} value={name}>
              {t('permissions.form.toolOption', { name, label: t(`permissions.tool.${name}`) })}
            </option>
          ))}
          <option value="*">{t('permissions.anyTool')}</option>
        </select>
      </Field>
      <Field
        label={t(`permissions.form.${target}`)}
        labelFor={patternId}
        hint={problem ? undefined : t(`permissions.form.${target}Hint`)}
      >
        <input
          id={patternId}
          className={cn(inputClass, 'font-mono text-[13px]')}
          value={draft.pattern}
          placeholder={t(`permissions.form.${target}Placeholder`)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${patternId}-problem` : undefined}
          onChange={(e) => set({ pattern: e.target.value })}
        />
        {problem && (
          <p id={`${patternId}-problem`} className="mt-1.5 text-note text-danger">
            {t('permissions.form.empty')}
          </p>
        )}
      </Field>
      <Field label={t('permissions.form.scope')} labelFor={scopeId}>
        <select
          id={scopeId}
          className={selectClass}
          value={draft.scope}
          onChange={(e) => set({ scope: e.target.value })}
        >
          <option value={GLOBAL_SCOPE}>{t('permissions.scope.global')}</option>
          {projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {t('permissions.scope.project', { name: p.name })}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex justify-end gap-2 pt-3.5 shadow-[0_-0.5px_0_var(--hair)]">
        <Button onClick={onCancel}>{tc('action.cancel')}</Button>
        <Button variant="primary" disabled={busy || problem !== undefined} onClick={submit}>
          {t('permissions.form.add')}
        </Button>
      </div>
    </SettingsCard>
  )
}

export function PermissionsSettings() {
  const { t } = useTranslation('settings')
  const mode = useSessionStore((s) => s.settings?.permissionMode) ?? DEFAULT_MODE
  const projects = useSessionStore((s) => s.projects)
  const permissionRules = useSessionStore((s) => s.permissionRules)
  const deletePermissionRule = useSessionStore((s) => s.deletePermissionRule)
  const refreshProjects = useSessionStore((s) => s.refreshProjects)
  const [entries, setEntries] = useState<readonly PermissionRuleEntry[] | undefined>()
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let active = true
    void refreshProjects()
    void permissionRules().then((rules) => {
      if (active) setEntries(rules ?? [])
    })
    return () => {
      active = false
    }
  }, [permissionRules, refreshProjects])

  const projectName = (projectId: string) =>
    projects.find((p) => p.projectId === projectId)?.name ?? t('permissions.scope.unknown')
  const rows = ruleRows(presetRows(mode), entries ?? [])

  const remove = async (ruleId: string) => {
    if (await deletePermissionRule(ruleId)) {
      setEntries((list) => list?.filter((e) => e.rule.id !== ruleId))
    }
  }

  return (
    <>
      <SettingsHeader
        title={t('section.permissions.title')}
        description={t('section.permissions.description')}
      />
      <ModeCards />
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-medium text-muted">{t('permissions.rules.title')}</h3>
          <p className="text-note text-faint">{t('permissions.rules.order')}</p>
        </div>
        {!adding && (
          <Button onClick={() => setAdding(true)}>
            <Plus />
            {t('permissions.rules.add')}
          </Button>
        )}
      </div>
      {adding && (
        <RuleForm
          onCancel={() => setAdding(false)}
          onAdded={(entry) => {
            setEntries((list) => [...(list ?? []), entry])
            setAdding(false)
          }}
        />
      )}
      <section
        aria-label={t('permissions.rules.title')}
        className="overflow-hidden rounded-card bg-raise shadow-[0_0_0_0.5px_var(--hair2),0_1px_2px_rgba(20,22,30,0.03)]"
      >
        {entries !== undefined && rows.length === 0 ? (
          <p className="px-3.5 py-4 text-ui text-muted">{t('permissions.rules.empty')}</p>
        ) : (
          <ul aria-label={t('permissions.rules.list')}>
            {rows.map((row) => (
              <RuleItem
                key={row.rule.id}
                row={row}
                mode={mode}
                projectName={projectName}
                onDelete={() => void remove(row.rule.id)}
              />
            ))}
          </ul>
        )}
      </section>
      <div className="flex items-start gap-2.5 rounded-[12px] bg-sunk px-3.5 py-3 text-[12.5px] text-fg2 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted">
        <ShieldCheck />
        <div className="flex flex-col gap-1">
          <p>{t('permissions.guard.ask')}</p>
          <p className="text-muted">{t('permissions.guard.deny')}</p>
        </div>
      </div>
    </>
  )
}
