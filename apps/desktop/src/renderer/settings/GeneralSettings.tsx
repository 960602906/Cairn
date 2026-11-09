/**
 * 设置页“通用与外观”（M2-09）：主题、界面语言、默认 Shell、全局指令。
 *
 * - 主题与语言选择后立即生效并保存（语言先切换界面，再保存；保存失败时界面保持新语言，错误由 store 显示）。
 * - 默认 Shell：显示自动选择会用哪个 shell（主进程探测）；Windows 上可以改为 cmd。
 * - 全局指令（`Settings.instructions`）：加入每个会话的系统提示词；改动后点“保存”，可以还原。
 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Languages, MessageSquareText, Monitor, Palette } from 'lucide-react'
import { DiagnosticsExportDialog } from './DiagnosticsExportDialog.js'
import { SUPPORTED_LOCALES, type Locale } from '@cairn/i18n'
import { INSTRUCTIONS_MAX_LENGTH, type ShellPreference } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { THEME_CHOICES, THEME_SWATCHES } from '../theme.js'
import { Button, cn, SegmentedControl, Switch } from '../ui/index.js'
import { Field, inputClass, SettingsGroup, ToggleRow } from './Field.js'
import { SandboxSettings } from './SandboxSettings.js'
import { SettingsHeader } from './SettingsPage.js'

function ShellField() {
  const { t } = useTranslation('settings')
  const shellOptions = useSessionStore((s) => s.shellOptions)
  const preference = useSessionStore((s) => s.settings?.shell ?? 'auto')
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const [info, setInfo] = useState<
    { detected: string; options: readonly ShellPreference[] } | 'loading' | 'failed'
  >('loading')

  useEffect(() => {
    let cancelled = false
    void shellOptions().then((result) => {
      if (!cancelled) setInfo(result ?? 'failed')
    })
    return () => {
      cancelled = true
    }
  }, [shellOptions])

  const detected =
    info === 'loading'
      ? t('general.shell.detecting')
      : info === 'failed'
        ? t('general.shell.unknown')
        : info.detected
  const options = typeof info === 'object' ? info.options : (['auto'] as const)

  return (
    <Field
      label={t('general.shell.label')}
      hint={t(options.includes('cmd') ? 'general.shell.hintWindows' : 'general.shell.hint')}
    >
      {options.length > 1 ? (
        <SegmentedControl
          label={t('general.shell.label')}
          value={preference}
          options={options.map((value) => ({
            value,
            label:
              value === 'auto'
                ? t('general.shell.auto', { shell: detected })
                : t('general.shell.cmd'),
          }))}
          onChange={(shell) => void updateSettings({ shell })}
        />
      ) : (
        <p className="pt-1 font-mono text-[13px] [font-variant-ligatures:none] text-fg">
          {t('general.shell.auto', { shell: detected })}
        </p>
      )}
    </Field>
  )
}

function InstructionsField() {
  const { t } = useTranslation('settings')
  const id = useId()
  const saved = useSessionStore((s) => s.settings?.instructions ?? '')
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const dirty = draft !== saved

  // 设置从别处更新（或第一次读到）时，没有未保存的修改就跟着变
  const [base, setBase] = useState(saved)
  if (base !== saved) {
    setBase(saved)
    if (draft === base) setDraft(saved)
  }

  const save = async () => {
    setBusy(true)
    const next = await updateSettings({ instructions: draft.trim() === '' ? null : draft })
    setBusy(false)
    // 只有空白时保存为清除
    if (next) setDraft(next.instructions ?? '')
  }

  return (
    <Field
      label={t('general.instructions.label')}
      labelFor={id}
      hint={t('general.instructions.hint')}
    >
      <textarea
        id={id}
        value={draft}
        maxLength={INSTRUCTIONS_MAX_LENGTH}
        rows={5}
        placeholder={t('general.instructions.placeholder')}
        onChange={(e) => setDraft(e.target.value)}
        className={cn(inputClass, 'h-auto min-h-28 resize-y py-2 text-[13px] leading-relaxed')}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="tabular text-note text-faint">
          {t('general.instructions.count', {
            count: draft.length,
            max: INSTRUCTIONS_MAX_LENGTH,
          })}
        </span>
        <span className="flex-1" />
        {dirty && (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(saved)}>
              {t('general.instructions.reset')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {t('general.instructions.save')}
            </Button>
          </>
        )}
      </div>
    </Field>
  )
}

function ThemeGrid() {
  const { t } = useTranslation('settings')
  const theme = useSessionStore((s) => s.settings?.theme ?? 'slate')
  const updateSettings = useSessionStore((s) => s.updateSettings)
  return (
    <div
      role="radiogroup"
      aria-label={t('general.theme.label')}
      className="grid grid-cols-2 gap-2 min-[860px]:grid-cols-3"
    >
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'system'}
        onClick={() => void updateSettings({ theme: 'system' })}
        className={cn(
          'flex items-center gap-2.5 rounded-card bg-paper px-3 py-2.5 text-left shadow-hair transition-colors hover:bg-hover',
          theme === 'system' &&
            'bg-accent-soft shadow-[0_0_0_1.5px_var(--accent)] hover:bg-accent-soft',
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-sunk2 text-muted">
          <Monitor className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-fg">
            {t('general.theme.system')}
          </span>
          <span className="block truncate text-note text-muted">
            {t('general.theme.system.hint')}
          </span>
        </span>
        {theme === 'system' && <Check className="size-4 shrink-0 text-accent" />}
      </button>
      {THEME_CHOICES.map(({ value, label }) => {
        const swatch = THEME_SWATCHES[value]
        const active = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => void updateSettings({ theme: value })}
            className={cn(
              'flex items-center gap-2.5 rounded-card bg-paper px-3 py-2.5 text-left shadow-hair transition-colors hover:bg-hover',
              active && 'bg-accent-soft shadow-[0_0_0_1.5px_var(--accent)] hover:bg-accent-soft',
            )}
          >
            <span
              aria-hidden
              className="flex size-8 shrink-0 flex-col justify-end gap-0.5 rounded-[7px] p-1 shadow-hair"
              style={{ background: swatch.canvas }}
            >
              <span className="h-1 w-full rounded-[2px]" style={{ background: swatch.paper }} />
              <span className="h-1 w-2/3 rounded-[2px]" style={{ background: swatch.accent }} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium text-fg">{t(label)}</span>
              <span className="block truncate text-note text-muted">{t(`${label}.hint`)}</span>
            </span>
            {active && <Check className="size-4 shrink-0 text-accent" />}
          </button>
        )
      })}
    </div>
  )
}

export function GeneralSettings() {
  const [exportOpen, setExportOpen] = useState(false)
  const { t, i18n } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const sessionBrief = useSessionStore((s) => s.settings?.sessionBrief !== false)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const loadSettings = useSessionStore((s) => s.loadSettings)
  const loaded = useSessionStore((s) => s.settings !== undefined)

  useEffect(() => {
    if (!loaded) void loadSettings()
  }, [loaded, loadSettings])

  const changeLocale = (locale: Locale) => {
    void i18n.changeLanguage(locale)
    void updateSettings({ locale })
  }

  return (
    <>
      <SettingsHeader
        icon={<Palette />}
        title={t('section.general.title')}
        description={t('section.general.description')}
      />
      <SettingsGroup
        icon={<Palette />}
        title={t('general.appearance.title')}
        description={t('general.appearance.description')}
      >
        <ThemeGrid />
      </SettingsGroup>
      <SettingsGroup
        icon={<Languages />}
        title={t('general.language.title')}
        description={t('general.language.description')}
      >
        <Field label={t('general.language.label')}>
          <SegmentedControl
            label={t('general.language.label')}
            value={i18n.language as Locale}
            options={SUPPORTED_LOCALES.map((value) => ({
              value,
              label: <span lang={value}>{tc(`language.${value}`)}</span>,
            }))}
            onChange={changeLocale}
          />
        </Field>
        <ShellField />
      </SettingsGroup>
      <SettingsGroup
        icon={<MessageSquareText />}
        title={t('general.behavior.title')}
        description={t('general.behavior.description')}
      >
        <ToggleRow title={t('general.sessionBrief.label')} hint={t('general.sessionBrief.hint')}>
          <Switch
            checked={sessionBrief}
            aria-label={t('general.sessionBrief.label')}
            onCheckedChange={(checked) => void updateSettings({ sessionBrief: checked })}
          />
        </ToggleRow>
        <InstructionsField />
      </SettingsGroup>
      <SandboxSettings />
      <SettingsGroup
        icon={<Download />}
        title={t('general.diagnostics.title')}
        description={t('general.diagnostics.description')}
      >
        <div>
          <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)}>
            <Download />
            {t('general.diagnostics.export')}
          </Button>
        </div>
      </SettingsGroup>
      <DiagnosticsExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </>
  )
}
