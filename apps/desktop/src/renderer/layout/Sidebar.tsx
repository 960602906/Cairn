/**
 * 侧栏（M2-02，视觉规范 §2）：铺在窗口底色上，没有自己的背景和边框。
 * 从上到下：标题区（macOS 的红绿灯在这里，可拖动窗口）与收起按钮、新对话、按项目分组的会话列表、
 * 底部的模型供应商卡片与“设置”（M2-09，⌘, / Ctrl+,；界面语言移到设置页）。搜索、活动、Agents 入口在之后的
 * 任务中加入。
 */
import { PanelLeft, Settings, SquarePen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProviderCard } from '../ProviderCard.js'
import { SessionList } from '../SessionList.js'
import { IconButton, Kbd } from '../ui/index.js'
import { newChatShortcut, settingsShortcut } from './shortcuts.js'

export function Sidebar({
  onNewChat,
  onCollapse,
  onSelect,
  onSettings,
}: {
  readonly onNewChat: () => void
  readonly onCollapse: () => void
  readonly onSelect: () => void
  readonly onSettings: () => void
}) {
  const { t } = useTranslation('session')
  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col">
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

      <div className="px-2 pb-3">
        <button
          type="button"
          onClick={onNewChat}
          className="flex h-8 w-full items-center gap-2 rounded-item px-2.5 text-ui text-fg2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4 [&_svg]:text-muted"
        >
          <SquarePen />
          <span className="flex-1 text-left">{t('list.new')}</span>
          <Kbd aria-hidden>{newChatShortcut()}</Kbd>
        </button>
      </div>

      <nav aria-label={t('list.title')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SessionList onSelect={onSelect} />
      </nav>

      <div className="flex flex-col gap-2 p-2">
        <ProviderCard />
        <button
          type="button"
          onClick={onSettings}
          className="flex h-8 w-full items-center gap-2 rounded-item px-2.5 text-ui text-fg2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4 [&_svg]:text-muted"
        >
          <Settings />
          <span className="flex-1 text-left">{t('sidebar.settings')}</span>
          <Kbd aria-hidden>{settingsShortcut()}</Kbd>
        </button>
      </div>
    </aside>
  )
}
