/**
 * 首次运行欢迎与说明（M5-09）：只出现一次，关闭后写入 `settings.onboardingSeen`。
 *
 * 文案覆盖用途、数据位置、API Key、模型请求、更新检查、诊断包与安全边界；没有配置模型供应商时
 * 提供直达设置页的主操作，但用户也可以先关闭并浏览已有数据。设置页的“关于”可以重新打开。
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderLock, KeyRound, RefreshCw, ShieldCheck, UserRoundX } from 'lucide-react'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../ui/index.js'

interface WelcomeItem {
  readonly icon: ReactNode
  readonly titleKey: string
  readonly bodyKey: string
}

const ITEMS: readonly WelcomeItem[] = [
  {
    icon: <UserRoundX />,
    titleKey: 'welcome.noAccount.title',
    bodyKey: 'welcome.noAccount.body',
  },
  {
    icon: <ShieldCheck />,
    titleKey: 'welcome.purpose.title',
    bodyKey: 'welcome.purpose.body',
  },
  {
    icon: <FolderLock />,
    titleKey: 'welcome.data.title',
    bodyKey: 'welcome.data.body',
  },
  {
    icon: <KeyRound />,
    titleKey: 'welcome.credentials.title',
    bodyKey: 'welcome.credentials.body',
  },
  {
    icon: <RefreshCw />,
    titleKey: 'welcome.update.title',
    bodyKey: 'welcome.update.body',
  },
]

export interface WelcomeDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** 没有模型供应商时的主操作；打开设置页的“模型供应商”。 */
  readonly onConfigure?: () => void
  /** 从设置页重新查看：只显示关闭按钮。 */
  readonly review?: boolean
}

export function WelcomeDialog({
  open,
  onOpenChange,
  onConfigure,
  review = false,
}: WelcomeDialogProps) {
  const { t } = useTranslation('onboarding')
  const noProvider = useSessionStore((s) => s.settings?.providers?.length === 0)
  const configure = noProvider && onConfigure !== undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        icon={<ShieldCheck />}
        className="flex max-h-[min(760px,calc(100vh-32px))] w-[min(720px,calc(100vw-32px))] flex-col"
      >
        <DialogTitle>{t('welcome.title')}</DialogTitle>
        <DialogDescription>{t('welcome.description')}</DialogDescription>
        <div data-testid="welcome-items" className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          <ul className="flex flex-col gap-1">
            {ITEMS.map(({ icon, titleKey, bodyKey }) => (
              <li
                key={titleKey}
                className="flex items-start gap-3 rounded-card bg-sunk/70 px-3 py-1.5"
              >
                <span
                  aria-hidden
                  className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-[7px] bg-raise text-fg2 shadow-hair [&_svg]:size-3.5"
                >
                  {icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-ui font-medium text-fg">{t(titleKey)}</span>
                  <span className="mt-0.5 block text-note leading-normal text-muted">
                    {t(bodyKey)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-2.5 flex items-start gap-2.5 rounded-card bg-sunk/70 px-3 py-1.5">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0">
            <p className="text-note font-medium text-fg">{t('welcome.limits.title')}</p>
            <p className="mt-0.5 text-note leading-normal text-muted">{t('welcome.limits.body')}</p>
          </div>
        </div>
        {noProvider && (
          <p className="mt-2.5 rounded-card bg-accent-soft px-3.5 py-1.5 text-note leading-normal text-fg2">
            {t('welcome.noProvider')}
          </p>
        )}
        {review ? (
          <div className="mt-6 flex justify-end">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('welcome.review')}
            </Button>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('welcome.later')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (configure) onConfigure()
                onOpenChange(false)
              }}
            >
              {t(configure ? 'welcome.configure' : 'welcome.start')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
