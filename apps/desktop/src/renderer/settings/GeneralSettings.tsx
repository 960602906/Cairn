/**
 * 设置页“通用与外观”（M2-09，视觉规范 §8）：主题、界面语言、默认 Shell、全局指令。
 *
 * - 主题与语言选择后立即生效并保存（语言先切换界面，再保存；保存失败时界面保持新语言，错误由 store 显示）。
 * - 默认 Shell：显示自动选择会用哪个 shell（主进程探测）；Windows 上可以改为 cmd。宿主启动时按设置选择，
 *   已在运行的会话不受影响。
 * - 全局指令（`Settings.instructions`）：加入每个会话的系统提示词；改动后点“保存”，可以还原。
 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LOCALES, type Locale } from '@cairn/i18n'
import { INSTRUCTIONS_MAX_LENGTH, type ShellPreference, type Theme } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { Button, cn, SegmentedControl } from '../ui/index.js'
import { Field, inputClass, SettingsCard } from './Field.js'
import { SettingsHeader } from './SettingsPage.js'

const THEMES: readonly Theme[] = ['system', 'light', 'dark']

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
        className={cn(inputClass, 'h-auto min-h-24 resize-y py-2 text-[13px] leading-relaxed')}
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

export function GeneralSettings() {
  const { t, i18n } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const theme = useSessionStore((s) => s.settings?.theme ?? 'system')
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
        title={t('section.general.title')}
        description={t('section.general.description')}
      />
      <SettingsCard>
        <Field label={t('general.theme.label')}>
          <SegmentedControl
            label={t('general.theme.label')}
            value={theme}
            options={THEMES.map((value) => ({ value, label: t(`general.theme.${value}`) }))}
            onChange={(next) => void updateSettings({ theme: next })}
          />
        </Field>
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
        <InstructionsField />
      </SettingsCard>
    </>
  )
}
