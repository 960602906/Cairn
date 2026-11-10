/**
 * 关于页（M5-01）：展示产品身份、版本、更新通道、提交与构建工具链版本。
 *
 * 数据只来自主进程的 `app.info`；不显示用户目录、凭据或项目内容。读取失败时由 store 的统一错误条
 * 提示，页面保持可用的“未知”占位。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Info, ScrollText, ShieldCheck } from 'lucide-react'
import type { AppInfo } from '@cairn/protocol'
import { useSessionStore } from '../store-context.js'
import { GplSourceDialog, PrivacyDialog } from '../onboarding/LegalDialogs.js'
import { WelcomeDialog } from '../onboarding/WelcomeDialog.js'
import { Button } from '../ui/index.js'
import { DiagnosticsExportDialog } from './DiagnosticsExportDialog.js'
import { Field, SettingsGroup } from './Field.js'
import { LicensesDialog } from './LicensesDialog.js'
import { SettingsHeader } from './SettingsPage.js'

function shortCommit(commit: string): string | undefined {
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : undefined
}

function formatBuildTime(value: string, locale: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString(locale)
}

function Mono({ children }: { readonly children: string }) {
  return (
    <span className="font-mono text-[13px] [font-variant-ligatures:none] break-all text-fg">
      {children}
    </span>
  )
}

export function AboutSettings() {
  const { t, i18n } = useTranslation('settings')
  const info = useSessionStore((s) => s.appInfo)
  const loadAppInfo = useSessionStore((s) => s.loadAppInfo)
  const update = useSessionStore((s) => s.updateStatus)
  const loadUpdateStatus = useSessionStore((s) => s.loadUpdateStatus)
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [gplOpen, setGplOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  useEffect(() => {
    if (!info) void loadAppInfo()
  }, [info, loadAppInfo])

  useEffect(() => {
    if (!update) void loadUpdateStatus()
  }, [update, loadUpdateStatus])

  return (
    <>
      <SettingsHeader
        icon={<Info />}
        title={t('section.about.title')}
        description={t('section.about.description')}
      />
      <SettingsGroup
        icon={<Info />}
        title={t('about.build.title')}
        description={t('about.build.description')}
      >
        {info ? (
          <BuildRows info={info} locale={i18n.language} />
        ) : (
          <p className="text-ui text-muted">{t('about.loading')}</p>
        )}
      </SettingsGroup>
      <SettingsGroup
        icon={<ScrollText />}
        title={t('about.update.title')}
        description={t('about.update.description')}
      >
        <Field label={t('about.update.source')}>
          <Mono>{update?.source ?? t('about.unknown')}</Mono>
        </Field>
        <Field label={t('about.licenses.label')}>
          <Button size="sm" variant="secondary" onClick={() => setLicensesOpen(true)}>
            <ScrollText aria-hidden />
            {t('about.licenses.open')}
          </Button>
        </Field>
        <p className="text-note leading-relaxed text-muted">{t('about.licenses.hint')}</p>
      </SettingsGroup>
      <SettingsGroup
        icon={<ShieldCheck />}
        title={t('about.legal.title')}
        description={t('about.legal.description')}
      >
        <Field label={t('about.legal.welcome')}>
          <Button size="sm" variant="secondary" onClick={() => setWelcomeOpen(true)}>
            <ShieldCheck aria-hidden />
            {t('about.legal.welcomeOpen')}
          </Button>
        </Field>
        <Field label={t('about.legal.privacy')}>
          <Button size="sm" variant="secondary" onClick={() => setPrivacyOpen(true)}>
            <ScrollText aria-hidden />
            {t('about.legal.privacyOpen')}
          </Button>
        </Field>
        <Field label={t('about.legal.gpl')}>
          <Button size="sm" variant="secondary" onClick={() => setGplOpen(true)}>
            <ScrollText aria-hidden />
            {t('about.legal.gplOpen')}
          </Button>
        </Field>
        <Field label={t('about.legal.diagnostics')}>
          <Button size="sm" variant="secondary" onClick={() => setDiagnosticsOpen(true)}>
            <Download aria-hidden />
            {t('about.legal.diagnosticsOpen')}
          </Button>
        </Field>
      </SettingsGroup>
      <SettingsGroup title={t('about.localData.title')}>
        <p className="text-ui leading-relaxed text-fg2">{t('about.localData.description')}</p>
        {info && <p className="text-note text-muted">{info.copyright}</p>}
      </SettingsGroup>
      <LicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />
      <WelcomeDialog open={welcomeOpen} onOpenChange={setWelcomeOpen} review />
      <PrivacyDialog open={privacyOpen} onOpenChange={setPrivacyOpen} />
      <GplSourceDialog open={gplOpen} onOpenChange={setGplOpen} />
      <DiagnosticsExportDialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} />
    </>
  )
}

function BuildRows({ info, locale }: { readonly info: AppInfo; readonly locale: string }) {
  const { t } = useTranslation('settings')
  const commit = shortCommit(info.commit)
  const buildTime = formatBuildTime(info.buildTime, locale)
  const git = info.git
  const gitLabel = git
    ? `${t(`about.git.${git.source}`)}${git.version ? ` · ${git.version}` : ''}`
    : t('about.unknown')
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('about.version')}>
        <Mono>{info.version}</Mono>
      </Field>
      <Field label={t('about.channel')}>
        <span className="text-ui text-fg">{t(`about.channel.${info.channel}`)}</span>
      </Field>
      <Field label={t('about.commit')}>
        <Mono>{commit ?? t('about.unknown')}</Mono>
      </Field>
      <Field label={t('about.buildTime')}>
        <span className="text-ui text-fg">{buildTime ?? t('about.unknown')}</span>
      </Field>
      <Field label={t('about.electron')}>
        <Mono>{info.electronVersion || t('about.unknown')}</Mono>
      </Field>
      <Field label={t('about.node')}>
        <Mono>{info.nodeVersion || t('about.unknown')}</Mono>
      </Field>
      <Field label={t('about.database')}>
        <Mono>{String(info.databaseSchemaVersion)}</Mono>
      </Field>
      <Field label={t('about.git')}>
        <span className="text-ui text-fg">{gitLabel}</span>
      </Field>
      <Field label={t('about.mode')}>
        <span className="text-ui text-fg">
          {t(info.packaged ? 'about.mode.packaged' : 'about.mode.dev')}
        </span>
      </Field>
    </div>
  )
}
