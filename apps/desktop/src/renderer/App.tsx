/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 *
 * M2-02 起按视觉规范 §2 布局：窗口底色上左边是侧栏（新对话、会话列表、模型供应商），右边是纸面
 * （当前会话或新对话表单）。窗口宽度小于 880px 时侧栏收起，可以从顶栏展开。⌘N / Ctrl+N 新对话。
 * 主题跟随设置（M2-01，`ThemeSync`）。
 * M2-09：设置页（侧栏底部“设置”或 ⌘, / Ctrl+,）换掉侧栏与纸面内容，Esc 或“返回对话”回到原来的页面。
 * M2-12：⌘K / Ctrl+K 搜索对话（在设置页中也可以），选中后回到对话页。
 * 没有 store（preload 未加载，如在普通浏览器中打开）时只显示应用名称与语言切换。
 */
import { PanelLeft } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@cairn/i18n'
import { ChatPanel, TopBar } from './ChatPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { LanguageSwitcher } from './LanguageSwitcher.js'
import { isNewChatKey, isSearchKey, isSettingsKey } from './layout/shortcuts.js'
import { Sidebar } from './layout/Sidebar.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { AgentsView } from './agents/AgentsView.js'
import { NewSession } from './NewSession.js'
import type { SessionStore } from './session-store.js'
import { SessionSearch } from './SessionSearch.js'
import { SettingsContent, SettingsNav, type SettingsSection } from './settings/SettingsPage.js'
import { SessionStoreProvider, useSessionStore } from './store-context.js'
import { ThemeSync } from './ThemeSync.js'
import { CairnMark, IconButton, TooltipProvider } from './ui/index.js'

export interface AppProps {
  readonly i18n: I18nInstance
  readonly store?: SessionStore
}

/** 窗口宽度小于这个值时侧栏收起（视觉规范 §2）。 */
const NARROW_QUERY = '(max-width: 879px)'

function Workspace() {
  const { t } = useTranslation('session')
  const narrow = useMediaQuery(NARROW_QUERY)
  const [sidebarOpen, setSidebarOpen] = useState(!narrow)
  const [composing, setComposing] = useState(false)
  const [settings, setSettings] = useState<SettingsSection | undefined>(undefined)
  const [agents, setAgents] = useState(false)
  const [searching, setSearching] = useState(false)
  // 还没有会话时直接显示新对话表单；已选中的会话（即使不在列表中）仍显示会话
  const showNew = useSessionStore((s) => s.sessions.length === 0 && s.activeSessionId === undefined)

  // 窗口变窄时收起、变宽时展开；之后用户仍可手动切换
  useEffect(() => setSidebarOpen(!narrow), [narrow])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSearchKey(event)) {
        event.preventDefault()
        setSearching(true)
        return
      }
      if (isSettingsKey(event)) {
        event.preventDefault()
        setSettings((current) => current ?? 'general')
        return
      }
      if (!isNewChatKey(event)) return
      event.preventDefault()
      setSettings(undefined)
      setAgents(false)
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

  const closeSettings = useCallback(() => setSettings(undefined), [])

  const showAgents = agents
  const openAgents = useCallback(() => {
    setSettings(undefined)
    setComposing(false)
    setAgents(true)
  }, [])

  const search = (
    <SessionSearch
      open={searching}
      onOpenChange={setSearching}
      onSelect={() => {
        setSettings(undefined)
        setAgents(false)
        setComposing(false)
        if (narrow) setSidebarOpen(false)
      }}
    />
  )

  if (settings) {
    return (
      <div className="flex h-full bg-chrome text-fg">
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
        <SettingsNav
          open={sidebarOpen}
          section={settings}
          onSelect={(section) => {
            setSettings(section)
            if (narrow) setSidebarOpen(false)
          }}
          onBack={closeSettings}
          onCollapse={() => setSidebarOpen(false)}
        />
        <main
          className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper ${sidebarOpen ? 'border-l-[0.5px] border-hair' : ''}`}
        >
          <ErrorBanner />
          <SettingsContent section={settings} leading={expand} onBack={closeSettings} />
        </main>
        {search}
      </div>
    )
  }

  if (showAgents) {
    return (
      <div className="flex h-full bg-chrome text-fg">
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
        <Sidebar
          open={sidebarOpen}
          onNewChat={() => {
            setAgents(false)
            setComposing(true)
            if (narrow) setSidebarOpen(false)
          }}
          onCollapse={() => setSidebarOpen(false)}
          onSearch={() => setSearching(true)}
          onSelect={() => {
            setAgents(false)
            setComposing(false)
            if (narrow) setSidebarOpen(false)
          }}
          onAgents={openAgents}
          agentsActive
          onSettings={(section) => {
            setAgents(false)
            setSettings(section ?? 'general')
            if (narrow) setSidebarOpen(false)
          }}
        />
        <main
          className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper ${sidebarOpen ? 'border-l-[0.5px] border-hair' : ''}`}
        >
          <ErrorBanner />
          <AgentsView leading={expand} />
        </main>
        {search}
      </div>
    )
  }

  return (
    <div className="flex h-full bg-chrome text-fg">
      {/* 应用名只给读屏（窗口标题区不显示文字）；冒烟检查也据此确认界面已渲染 */}
      <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
      <Sidebar
        open={sidebarOpen}
        onNewChat={() => {
          setComposing(true)
          setAgents(false)
          if (narrow) setSidebarOpen(false)
        }}
        onCollapse={() => setSidebarOpen(false)}
        onSearch={() => setSearching(true)}
        onSelect={() => {
          setComposing(false)
          setAgents(false)
          if (narrow) setSidebarOpen(false)
        }}
        onAgents={openAgents}
        onSettings={(section) => {
          setSettings(section ?? 'general')
          if (narrow) setSidebarOpen(false)
        }}
      />
      <main
        className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper ${sidebarOpen ? 'border-l-[0.5px] border-hair' : ''}`}
      >
        <ErrorBanner />
        {composing || showNew ? (
          <>
            <TopBar>{expand}</TopBar>
            <NewSession
              onDone={() => setComposing(false)}
              onSettings={() => setSettings('providers')}
            />
          </>
        ) : (
          <ChatPanel leading={expand} />
        )}
      </main>
      {search}
    </div>
  )
}

function Shell({ store }: Omit<AppProps, 'i18n'>) {
  const { t } = useTranslation()
  if (!store) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 bg-chrome">
        <CairnMark size={64} label={t('app.name')} className="text-fg" />
        <h1 className="text-page">{t('app.name')}</h1>
        <LanguageSwitcher />
      </main>
    )
  }
  return (
    <SessionStoreProvider store={store}>
      <ThemeSync />
      <Workspace />
    </SessionStoreProvider>
  )
}

export function App({ i18n, store }: AppProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <Shell {...(store ? { store } : {})} />
      </TooltipProvider>
    </I18nextProvider>
  )
}
