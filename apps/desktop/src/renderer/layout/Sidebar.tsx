/**
 * 左侧栏：应用标志、活动图标、收起按钮、新对话 / 搜索入口、工作空间与会话列表，底部是设置。
 *
 * 三栏布局里它是唯一的左栏，原来 60px 的图标栏已经并进来。宽窗口常驻，可以收成 0 宽
 * （收起后由顶栏的按钮展开）；窄窗口由 App 放进抽屉。
 */
import { Activity, Bot, PanelLeftClose, Search, Settings, SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary } from '@cairn/protocol'
import { SessionList } from '../SessionList.js'
import { CairnMark, cn, IconButton, Kbd } from '../ui/index.js'
import { WorkspaceList } from '../WorkspaceList.js'
import { ResizeHandle, useResizableWidth } from './resize.js'
import { newChatShortcut, searchShortcut, settingsShortcut } from './shortcuts.js'

/** 左栏默认宽度；可以拖动右边缘调整。 */
export const SIDEBAR_WIDTH = 252
const SIDEBAR_MIN = 208
const SIDEBAR_MAX = 420

function NavRow({
  icon,
  label,
  trailing,
  active = false,
  onClick,
}: {
  readonly icon: ReactNode
  /** 显示的文字。 */
  readonly label: string
  readonly trailing?: ReactNode
  /** 当前页面，左侧栏里高亮。 */
  readonly active?: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-item px-2.5 text-ui outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-press text-fg' : 'text-fg2 hover:bg-hover hover:text-fg',
      )}
    >
      <span aria-hidden className="text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </button>
  )
}

function ActivityIconButton({
  active,
  badge,
  onClick,
}: {
  readonly active: boolean
  readonly badge: number
  readonly onClick: () => void
}) {
  const { t } = useTranslation('session')
  const label = badge > 0 ? t('sidebar.activityWithBadge', { count: badge }) : t('sidebar.activity')
  return (
    <IconButton
      label={label}
      size="icon-sm"
      aria-current={active ? 'page' : undefined}
      className={cn('relative', active && 'bg-press text-fg')}
      onClick={onClick}
    >
      <Activity />
      {badge > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-1 -right-1 min-w-[15px] rounded-full bg-accent px-1 text-center text-[9px] leading-[15px] font-semibold text-ink-fg"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </IconButton>
  )
}

export function Sidebar({
  open,
  onClose,
  onSearch,
  onSelect,
  onNewChat,
  onActivity,
  onAgents,
  onSettings,
  activityActive = false,
  agentsActive = false,
  activityBadge = 0,
  onNewConversationProject,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly onSearch: () => void
  readonly onSelect: () => void
  readonly onNewChat?: () => void
  readonly onActivity?: () => void
  readonly onAgents?: () => void
  readonly onSettings?: () => void
  readonly activityActive?: boolean
  readonly agentsActive?: boolean
  readonly activityBadge?: number
  readonly onNewConversationProject?: (project: ProjectSummary) => void
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  // macOS 的红绿灯压在左上角，标题行给它让出位置。
  const mac = window.cairn?.windowControls?.platform === 'darwin'
  const { width, dragging, handleProps } = useResizableWidth({
    storageKey: 'cairn.sidebarWidth',
    initial: SIDEBAR_WIDTH,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    edge: 'right',
  })
  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      style={{ width: open ? width : 0 }}
      className={cn(
        'relative h-full shrink-0',
        // 拖动时不要过渡，宽度要跟手。
        !dragging &&
          'transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none',
        open ? 'opacity-100' : 'pointer-events-none overflow-hidden opacity-0',
      )}
    >
      {open && <ResizeHandle label={t('sidebar.resize')} {...handleProps} />}
      <div
        style={{ width }}
        className={cn(
          'flex h-full flex-col overflow-hidden bg-chrome transition-transform duration-200 ease-out motion-reduce:transition-none',
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
            {onActivity && (
              <ActivityIconButton
                active={activityActive}
                badge={activityBadge}
                onClick={onActivity}
              />
            )}
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
          {onAgents && (
            <NavRow
              icon={<Bot />}
              label={t('sidebar.agents')}
              active={agentsActive}
              onClick={onAgents}
            />
          )}
        </div>

        <nav aria-label={t('list.title')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <WorkspaceList
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
