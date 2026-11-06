/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 *
 * M2-02 起按视觉规范 §2 布局：窗口底色上左边是侧栏（新对话、会话列表、模型供应商），右边是纸面
 * （当前会话或新对话表单）。窗口宽度小于 880px 时侧栏收起，可以从顶栏展开。⌘N / Ctrl+N 新对话。
 * 主题跟随设置（M2-01，`ThemeSync`）；开发模式下纸面底部是事件查看器（M0-15d）。
 * 没有 store（preload 未加载，如在普通浏览器中打开）时只显示应用名称与语言切换。
 */
import { PanelLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@cairn/i18n'
import { ChatPanel, TopBar } from './ChatPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { EventViewer } from './EventViewer.js'
import { LanguageSwitcher } from './LanguageSwitcher.js'
import { isNewChatKey } from './layout/shortcuts.js'
import { Sidebar } from './layout/Sidebar.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { NewSession } from './NewSession.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider, useSessionStore } from './store-context.js'
import { ThemeSync } from './ThemeSync.js'
import { IconButton, TooltipProvider } from './ui/index.js'

export interface AppProps {
  readonly i18n: I18nInstance
  readonly store?: SessionStore
  /** 显示开发工具（事件查看器）；store 需开启事件记录。 */
  readonly devTools?: boolean
}

/** 窗口宽度小于这个值时侧栏收起（视觉规范 §2）。 */
const NARROW_QUERY = '(max-width: 879px)'

function Workspace({ devTools }: { readonly devTools: boolean }) {
  const { t } = useTranslation('session')
  const narrow = useMediaQuery(NARROW_QUERY)
  const [sidebarOpen, setSidebarOpen] = useState(!narrow)
  const [composing, setComposing] = useState(false)
  // 还没有会话时直接显示新对话表单；已选中的会话（即使不在列表中）仍显示会话
  const showNew = useSessionStore((s) => s.sessions.length === 0 && s.activeSessionId === undefined)

  // 窗口变窄时收起、变宽时展开；之后用户仍可手动切换
  useEffect(() => setSidebarOpen(!narrow), [narrow])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNewChatKey(event)) return
      event.preventDefault()
      setComposing(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const expand = sidebarOpen ? undefined : (
    <IconButton
      label={t('sidebar.expand')}
      size="icon-sm"
      className="no-drag"
      onClick={() => setSidebarOpen(true)}
    >
      <PanelLeft />
    </IconButton>
  )

  return (
    <div className="flex h-full bg-chrome text-fg">
      {sidebarOpen && (
        <Sidebar
          onNewChat={() => {
            setComposing(true)
            if (narrow) setSidebarOpen(false)
          }}
          onCollapse={() => setSidebarOpen(false)}
          onSelect={() => {
            setComposing(false)
            if (narrow) setSidebarOpen(false)
          }}
        />
      )}
      <main
        className={`relative my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-paper bg-paper shadow-1 ${sidebarOpen ? '' : 'ml-2'}`}
      >
        <ErrorBanner />
        {composing || showNew ? (
          <>
            <TopBar>{expand}</TopBar>
            <NewSession onDone={() => setComposing(false)} />
          </>
        ) : (
          <ChatPanel leading={expand} />
        )}
        {devTools && (
          <div className="max-h-[35%] shrink-0 overflow-y-auto border-t-[0.5px] border-hair p-3 text-note">
            <EventViewer />
          </div>
        )}
      </main>
    </div>
  )
}

function Shell({ store, devTools }: Omit<AppProps, 'i18n'>) {
  const { t } = useTranslation()
  if (!store) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 bg-chrome">
        <h1 className="text-page">{t('app.name')}</h1>
        <LanguageSwitcher />
      </main>
    )
  }
  return (
    <SessionStoreProvider store={store}>
      <ThemeSync />
      <Workspace devTools={devTools ?? false} />
    </SessionStoreProvider>
  )
}

export function App({ i18n, store, devTools = false }: AppProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <Shell {...(store ? { store } : {})} devTools={devTools} />
      </TooltipProvider>
    </I18nextProvider>
  )
}
