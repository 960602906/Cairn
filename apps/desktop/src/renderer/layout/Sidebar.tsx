/**
 * 会话栏（01 枢纽）：铺在图标栏右侧的常驻会话列，也可以作为窄窗口的抽屉内容。
 *
 * 从上到下：标题与计数、新对话 / 收起、搜索框、按项目分组的会话列表、底部工作区信息。
 * 搜索、活动与设置入口由 `AppRail` 承担；这里只保留会话相关操作。
 */
import { Laptop, PanelLeftClose, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectSummary } from '@cairn/protocol'
import { SessionList } from '../SessionList.js'
import { useSessionStore } from '../store-context.js'
import { cn, IconButton, Kbd } from '../ui/index.js'
import { WorkspaceList } from '../WorkspaceList.js'
import { newChatShortcut, searchShortcut } from './shortcuts.js'

export function Sidebar({
  open = true,
  onNewChat,
  onClose,
  onSearch,
  onSelect,
  onConfigureProject,
  onBrowseProjectInFileTree,
  onNewConversationProject,
}: {
  readonly open?: boolean
  readonly onNewChat: () => void
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
          <button
            type="button"
            onClick={onNewChat}
            className="mt-1.5 flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-note text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <Plus className="size-3.5" />
            <span className="flex-1 text-left">{t('list.new')}</span>
            <Kbd aria-hidden>{newChatShortcut()}</Kbd>
          </button>
        </div>

        <div className="shrink-0 px-2">
          <WorkspaceList
            onConfigure={(project) => onConfigureProject?.(project)}
            onBrowseInFileTree={(project) => onBrowseProjectInFileTree?.(project)}
            onNewConversation={(project) => onNewConversationProject?.(project)}
          />
        </div>

        <nav aria-label={t('list.title')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <SessionList onSelect={onSelect} />
        </nav>

        <div className="mt-auto shrink-0 px-2.5 pt-2">
          <div className="flex items-center gap-2.5 rounded-[9px] bg-sunk/50 px-2.5 py-2 shadow-hair">
            <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-sunk2 text-fg2">
              <Laptop className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-note font-medium text-fg">
                {t('sidebar.workspaceName')}
              </span>
              <span className="block truncate text-[10.5px] text-faint">
                {t('sidebar.workspaceSub')}
              </span>
            </span>
            <span aria-hidden className="size-1.5 rounded-full bg-ok" />
          </div>
        </div>
      </div>
    </aside>
  )
}
