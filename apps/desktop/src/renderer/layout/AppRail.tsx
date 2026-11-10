/**
 * 全局图标栏：展开会话、搜索、活动与设置。
 *
 * 图标栏常驻（窗口最窄 880px 时仍然保留），本身不承载会话列表，宽度固定 60px。
 */
import { Activity, PanelLeftOpen, Search, Settings, SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CairnMark, cn, Kbd, Tooltip } from '../ui/index.js'
import { newChatShortcut, searchShortcut, settingsShortcut } from './shortcuts.js'

function RailButton({
  label,
  active = false,
  onClick,
  badge = 0,
  hint,
  children,
}: {
  readonly label: string
  readonly active?: boolean
  readonly onClick: () => void
  readonly badge?: number
  readonly hint?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <Tooltip content={hint ?? label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={cn(
          'relative flex size-9 items-center justify-center rounded-[9px] transition-colors [&_svg]:size-[18px]',
          active ? 'bg-sunk2 text-fg shadow-1' : 'text-faint hover:bg-hover hover:text-fg2',
        )}
      >
        {children}
        {badge > 0 && (
          <span
            aria-hidden
            className="tabular absolute top-0.5 right-0.5 min-w-[15px] rounded-full bg-accent px-1 text-center text-[9px] leading-[15px] font-semibold text-ink-fg"
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

export function AppRail({
  onNewChat,
  onSessions,
  sessionsOpen = true,
  showSessions = true,
  onSearch,
  onActivity,
  onSettings,
  activityActive = false,
  activityBadge = 0,
}: {
  readonly onNewChat: () => void
  readonly onSessions: () => void
  /** 会话栏已展开时不显示入口；收起后提供恢复入口。 */
  readonly sessionsOpen?: boolean
  /** 设置页与活动页不展示会话列，也不提供展开入口。 */
  readonly showSessions?: boolean
  readonly onSearch: () => void
  readonly onActivity: () => void
  readonly onSettings: () => void
  readonly activityActive?: boolean
  readonly activityBadge?: number
}) {
  const { t } = useTranslation('session')

  return (
    <nav
      aria-label={t('rail.nav')}
      className="drag flex h-full w-[60px] shrink-0 flex-col items-center gap-1 border-r-[0.5px] border-hair bg-chrome pt-3 pb-2.5"
    >
      <span
        aria-hidden
        className="mb-2 grid size-9 place-items-center rounded-[10px] bg-raise text-accent shadow-hair"
      >
        <CairnMark size={24} />
      </span>
      <div className="no-drag flex flex-col items-center gap-1">
        <RailButton
          label={t('list.new')}
          onClick={onNewChat}
          hint={
            <span className="flex items-center gap-1.5">
              {t('list.new')}
              <Kbd>{newChatShortcut()}</Kbd>
            </span>
          }
        >
          <SquarePen />
        </RailButton>
        {showSessions && !sessionsOpen && (
          <RailButton label={t('sidebar.expand')} onClick={onSessions}>
            <PanelLeftOpen />
          </RailButton>
        )}
        <RailButton
          label={t('search.open')}
          onClick={onSearch}
          hint={
            <span className="flex items-center gap-1.5">
              {t('search.open')}
              <Kbd>{searchShortcut()}</Kbd>
            </span>
          }
        >
          <Search />
        </RailButton>
        <RailButton
          label={
            activityBadge > 0
              ? t('sidebar.activityWithBadge', { count: activityBadge })
              : t('sidebar.activity')
          }
          active={activityActive}
          badge={activityBadge}
          onClick={onActivity}
        >
          <Activity />
        </RailButton>
      </div>

      <div className="no-drag mt-auto flex flex-col items-center gap-1">
        <RailButton
          label={t('sidebar.settings')}
          onClick={onSettings}
          hint={
            <span className="flex items-center gap-1.5">
              {t('sidebar.settings')}
              <Kbd>{settingsShortcut()}</Kbd>
            </span>
          }
        >
          <Settings />
        </RailButton>
      </div>
    </nav>
  )
}
