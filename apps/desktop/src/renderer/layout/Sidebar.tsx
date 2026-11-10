/**
 * 会话栏（01 枢纽）：铺在图标栏右侧的常驻会话列，也可以作为窄窗口的抽屉内容。
 *
 * 从上到下：标题与收起、搜索框、按项目分组的会话列表。
 * 搜索、活动与设置入口由 `AppRail` 承担；这里只保留会话相关操作。
 */
import { PanelLeftClose, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary } from '@cairn/protocol'
import { SessionList } from '../SessionList.js'
import { useSessionStore } from '../store-context.js'
import { cn, IconButton, Kbd } from '../ui/index.js'
import { WorkspaceList } from '../WorkspaceList.js'
import { searchShortcut } from './shortcuts.js'

export function Sidebar({
  open = true,
  onClose,
  onSearch,
  onSelect,
  onConfigureProject,
  onBrowseProjectInFileTree,
  onNewConversationProject,
}: {
  readonly open?: boolean
  /** 收起常驻列，或关闭窄窗口里的抽屉。 */
  readonly onClose: () => void
  /** 打开“搜索对话”（M2-12）。 */
  readonly onSearch: () => void
  readonly onSelect: () => void
  readonly onConfigureProject?: (project: ProjectSummary) => void
  readonly onBrowseProjectInFileTree?: (project: ProjectSummary) => void
  readonly onNewConversationProject?: (project: ProjectSummary) => void
}) {
  const { t } = useTranslation('session')
  const count = useSessionStore((s) => s.sessions.length)
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
          'flex h-full w-[252px] flex-col border-r-[0.5px] border-hair bg-chrome pb-2 transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-3',
        )}
      >
        <div className="drag flex h-[52px] shrink-0 items-center gap-1.5 pr-2 pl-4">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">
            {t('list.title')}
          </span>
          <span className="tabular text-[10px] text-faint">{count}</span>
          <div className="no-drag ml-auto flex items-center gap-0.5">
            <IconButton label={t('sidebar.collapse')} size="icon-sm" onClick={onClose}>
              <PanelLeftClose />
            </IconButton>
          </div>
        </div>

        <div className="shrink-0 px-2.5 pb-2">
          <button
            type="button"
            onClick={onSearch}
            className="flex h-[30px] w-full items-center gap-2 rounded-[8px] bg-sunk/60 px-2.5 text-note text-muted shadow-hair transition-colors hover:bg-sunk hover:text-fg2"
          >
            <Search className="size-3.5 shrink-0 text-faint" />
            <span className="flex-1 truncate text-left">{t('search.title')}</span>
            <Kbd aria-hidden>{searchShortcut()}</Kbd>
          </button>
        </div>

        <nav aria-label={t('list.title')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <WorkspaceList
            onConfigure={(project) => onConfigureProject?.(project)}
            onBrowseInFileTree={(project) => onBrowseProjectInFileTree?.(project)}
            onNewConversation={(project) => onNewConversationProject?.(project)}
            onSelectSession={onSelect}
          />
          <SessionList onSelect={onSelect} />
        </nav>
      </div>
    </aside>
  )
}
