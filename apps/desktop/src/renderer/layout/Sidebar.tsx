/**
 * 侧栏（M2-02，视觉规范 §2）：铺在窗口底色上，没有自己的背景和边框。
 * 从上到下：标题区（macOS 的红绿灯在这里，可拖动窗口）与收起按钮、新对话、搜索（M2-12，⌘K / Ctrl+K）、
 * 按项目分组的会话列表与底部的“设置”（M2-09，⌘, / Ctrl+,；界面语言移到设置页）。Agents 入口
 * 在 M3-12 加入；活动入口仍隐藏。
 */
import { Bot, PanelLeft, Search, Settings, SquarePen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SessionList } from '../SessionList.js'
import { CairnMark, cn, IconButton, Kbd } from '../ui/index.js'
import { newChatShortcut, searchShortcut, settingsShortcut } from './shortcuts.js'

export function Sidebar({
  open = true,
  onNewChat,
  onCollapse,
  onSearch,
  onSelect,
  onSettings,
  onAgents,
  agentsActive = false,
}: {
  readonly open?: boolean
  readonly onNewChat: () => void
  readonly onCollapse: () => void
  /** 打开“搜索对话”（M2-12）。 */
  readonly onSearch: () => void
  readonly onSelect: () => void
  /** 打开设置页；`providers` 时直接到“模型供应商”。 */
  readonly onSettings: (section?: 'providers') => void
  /** 打开 Agents 页面（M3-12）。 */
  readonly onAgents?: () => void
  readonly agentsActive?: boolean
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
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
          'flex h-full w-[252px] flex-col transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-3',
        )}
      >
        <div className="drag flex h-10 shrink-0 items-center justify-end px-2">
          <IconButton
            label={t('sidebar.collapse')}
            size="icon-sm"
            className="no-drag"
            onClick={onCollapse}
          >
            <PanelLeft />
          </IconButton>
        </div>

        <div className="drag flex h-9 shrink-0 items-center gap-2 px-2.5 pb-1">
          <CairnMark size={22} className="text-fg" />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">
            {tc('app.name')}
          </span>
        </div>

        <div className="px-2 pb-3">
          <button
            type="button"
            onClick={onNewChat}
            className="flex h-9 w-full items-center gap-2 rounded-item bg-raise px-2 text-ui font-medium text-fg shadow-hair2 transition-colors hover:bg-sunk"
          >
            <span className="inline-flex size-6 items-center justify-center rounded-[7px] bg-accent-soft text-accent [&_svg]:size-3.5">
              <SquarePen />
            </span>
            <span className="flex-1 text-left">{t('list.new')}</span>
            <Kbd aria-hidden>{newChatShortcut()}</Kbd>
          </button>
          <button
            type="button"
            onClick={onSearch}
            className="mt-1 flex h-8 w-full items-center gap-2 rounded-item px-2.5 text-ui text-fg2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4 [&_svg]:text-muted"
          >
            <Search />
            <span className="flex-1 text-left">{t('search.open')}</span>
            <Kbd aria-hidden>{searchShortcut()}</Kbd>
          </button>
          {onAgents && (
            <button
              type="button"
              aria-current={agentsActive ? 'page' : undefined}
              onClick={onAgents}
              className={cn(
                'mt-1 flex h-8 w-full items-center gap-2 rounded-item px-2.5 text-ui transition-colors [&_svg]:size-4 [&_svg]:text-muted',
                agentsActive
                  ? 'bg-raise font-medium text-fg shadow-1'
                  : 'text-fg2 hover:bg-hover hover:text-fg',
              )}
            >
              <Bot />
              <span className="flex-1 text-left">{t('sidebar.agents')}</span>
            </button>
          )}
        </div>

        <nav aria-label={t('list.title')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <SessionList onSelect={onSelect} />
        </nav>

        <div className="p-2">
          <button
            type="button"
            onClick={() => onSettings()}
            className="flex h-8 w-full items-center gap-2 rounded-item px-2.5 text-ui text-fg2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4 [&_svg]:text-muted"
          >
            <Settings />
            <span className="flex-1 text-left">{t('sidebar.settings')}</span>
            <Kbd aria-hidden>{settingsShortcut()}</Kbd>
          </button>
        </div>
      </div>
    </aside>
  )
}
