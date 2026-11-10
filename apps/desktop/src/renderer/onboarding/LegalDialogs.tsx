/**
 * 隐私说明与 GPL 源码获取方式（M5-09）。
 *
 * 两段文本都随界面提供中英文版本，不发起网络请求；GPL 地址交给系统浏览器打开。完整文件仍保存在
 * 仓库根目录与安装包的第三方声明中。
 */
import { useTranslation } from 'react-i18next'
import { ExternalLink, ScrollText } from 'lucide-react'
import { CopyButton } from '../CopyButton.js'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/index.js'

const PRIVACY_SECTIONS = [
  'noAccount',
  'data',
  'models',
  'credentials',
  'updates',
  'diagnostics',
  'integrations',
  'retention',
  'changes',
] as const

/** 随包 MinGit 的版本与源码地址；与 `scripts/bundled-binaries.json` 的登记保持一致。 */
export const MINGIT_VERSION = '2.56.0.4'
export const GPL_SOURCE_URL =
  'https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4'

export function PrivacyDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('onboarding')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        icon={<ScrollText />}
        className="flex max-h-[min(720px,calc(100vh-48px))] w-[min(680px,calc(100vw-32px))] flex-col"
      >
        <DialogTitle>{t('privacy.title')}</DialogTitle>
        <DialogDescription>{t('privacy.description')}</DialogDescription>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex flex-col gap-4">
            {PRIVACY_SECTIONS.map((section) => (
              <section key={section}>
                <h3 className="text-ui font-medium text-fg">{t(`privacy.${section}.title`)}</h3>
                <p className="mt-1 text-note leading-relaxed text-fg2">
                  {t(`privacy.${section}.body`)}
                </p>
              </section>
            ))}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('privacy.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function GplSourceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('onboarding')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        icon={<ScrollText />}
        className="flex max-h-[min(680px,calc(100vh-48px))] w-[min(620px,calc(100vw-32px))] flex-col"
      >
        <DialogTitle>{t('gpl.title')}</DialogTitle>
        <DialogDescription>{t('gpl.description')}</DialogDescription>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <p className="text-note leading-relaxed text-fg2">
            {t('gpl.version', { version: MINGIT_VERSION })}
          </p>
          <p className="mt-3 text-note leading-relaxed text-fg2">{t('gpl.body')}</p>
          <div className="mt-4 rounded-card bg-sunk/70 px-3.5 py-3">
            <span className="block text-note font-medium text-fg">{t('gpl.source')}</span>
            <span className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed [font-variant-ligatures:none] break-all text-fg2">
                {GPL_SOURCE_URL}
              </code>
              <CopyButton text={GPL_SOURCE_URL} className="text-fg2 hover:bg-hover" />
            </span>
          </div>
          <p className="mt-3 text-note leading-relaxed text-muted">{t('gpl.license')}</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('gpl.close')}
          </Button>
          <Button variant="secondary" asChild>
            <a href={GPL_SOURCE_URL} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t('gpl.open')}
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
