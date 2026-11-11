/**
 * 左侧栏：应用标志、全局入口（新对话 / 搜索 / 活动）、工作空间与会话列表，底部是设置。
 *
 * 三栏布局里它是唯一的左栏，原来 60px 的图标栏已经并进来。宽窗口常驻，可以收成 0 宽
 * （收起后由顶栏的按钮展开）；窄窗口由 App 放进抽屉。
 */
import { Activity, PanelLeftClose, Search, Settings, SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary } from '@cairn/protocol'
import { SessionList } from '../SessionList.js'
import { CairnMark, cn, IconButton, Kbd } from '../ui/index.js'
import { WorkspaceList } from '../WorkspaceList.js'
import { newChatShortcut, searchShortcut, settingsShortcut } from './shortcuts.js'

/** 左栏宽度；设置导航沿用同一宽度，切换时主区不跳动。 */
export const SIDEBAR_WIDTH = 252

function NavRow({
  icon,
  label,
  name,
  active = false,
  trailing,
  onClick,
}: {
  readonly icon: ReactNode
  /** 显示的文字。 */
  readonly label: string
  /** 无障碍名称，默认与文字相同。 */
  readonly name?: string
  readonly active?: boolean
  readonly trailing?: ReactNode
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={name ?? label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-item px-2.5 text-ui outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-press text-fg' : 'text-fg2 hover:bg-hover hover:text-fg',
      )}
    >
      <span aria-hidden className={active ? 'text-fg' : 'text-muted'}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </button>
  )
}

export function Sidebar({
  open,
  onClose,
  onSearch,
  onSelect,
  onNewChat,
  onActivity,
  onSettings,
  activityActive = false,
  activityBadge = 0,
  onBrowseProjectInFileTree,
  onNewConversationProject,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly onSearch: () => void
  readonly onSelect: () => void
  readonly onNewChat?: () => void
  readonly onActivity?: () => void
  readonly onSettings?: () => void
  readonly activityActive?: boolean
  readonly activityBadge?: number
  readonly onBrowseProjectInFileTree?: (project: ProjectSummary) => void
  readonly onNewConversationProject?: (project: ProjectSummary) => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  // macOS 的红绿灯压在左上角，标题行给它让出位置。
  const mac = window.cairn?.windowControls?.platform === 'darwin'
  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none',
        open ? 'w-[252px] opacity-100' : 'pointer-events-none w-0 opacity-0',
      )}
    >
      <div
        className={cn(
          'flex h-full w-[252px] flex-col bg-chrome transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-3',
        )}
      >
        <div
          className={cn(
            'drag flex h-12 shrink-0 items-center gap-2 pr-2',
            mac ? 'justify-end pl-[84px]' : 'pl-4',
          )}
        >
          {!mac && (
            <>
              <CairnMark size={20} className="shrink-0 text-accent" />
              <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">
                {tc('app.name')}
              </span>
            </>
          )}
          <div className="no-drag ml-auto flex items-center gap-0.5">
            <IconButton label={t('sidebar.collapse')} size="icon-sm" onClick={onClose}>
              <PanelLeftClose />
            </IconButton>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-2">
          {onNewChat && (
            <NavRow
              icon={<SquarePen />}
              label={t('list.new')}
              trailing={<Kbd aria-hidden>{newChatShortcut()}</Kbd>}
              onClick={onNewChat}
            />
          )}
          <NavRow
            icon={<Search />}
            label={t('search.title')}
            trailing={<Kbd aria-hidden>{searchShortcut()}</Kbd>}
            onClick={onSearch}
          />
          {onActivity && (
            <NavRow
              icon={<Activity />}
              label={t('sidebar.activity')}
              name={
                activityBadge > 0
                  ? t('sidebar.activityWithBadge', { count: activityBadge })
                  : t('sidebar.activity')
              }
              active={activityActive}
              trailing={
                activityBadge > 0 ? (
                  <span
                    aria-hidden
                    className="tabular min-w-[18px] rounded-full bg-accent px-1.5 text-center text-[10.5px] leading-[18px] font-semibold text-ink-fg"
                  >
                    {activityBadge > 99 ? '99+' : activityBadge}
                  </span>
                ) : undefined
              }
              onClick={onActivity}
            />
          )}
        </div>

        <nav aria-label={t('list.title')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <WorkspaceList
            onBrowseInFileTree={(project) => onBrowseProjectInFileTree?.(project)}
            onNewConversation={(project) => onNewConversationProject?.(project)}
            onSelectSession={onSelect}
          />
          <SessionList onSelect={onSelect} />
        </nav>

        {onSettings && (
          <div className="shrink-0 px-2 pt-1 pb-2">
            <NavRow
              icon={<Settings />}
              label={t('sidebar.settings')}
              trailing={<Kbd aria-hidden>{settingsShortcut()}</Kbd>}
              onClick={onSettings}
            />
          </div>
        )}
      </div>
    </aside>
  )
}
