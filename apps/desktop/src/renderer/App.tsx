/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 *
 * 布局（01 枢纽）：60px 图标栏常驻，右侧是 252px 会话列和主工作区。会话列在宽窗口常驻，
 * 可以收成 0 宽；窗口窄于 900px 时改为抽屉，避免把正文挤到 600px 以下。设置页用设置导航
 * 替换会话列，活动中心占满主区。
 *
 * ⌘N / Ctrl+N 新对话；⌘K / Ctrl+K 搜索；⌘, / Ctrl+, 设置；Esc 关闭抽屉/返回对话。
 * 主题跟随设置（M2-01，`ThemeSync`）。
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@cairn/i18n'
import { ActivityView } from './ActivityView.js'
import { ChatPanel, TopBar } from './ChatPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { LanguageSwitcher } from './LanguageSwitcher.js'
import { AppRail } from './layout/AppRail.js'
import { isNewChatKey, isSearchKey, isSettingsKey } from './layout/shortcuts.js'
import { Sidebar } from './layout/Sidebar.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { WindowControls } from './layout/WindowControls.js'
import { NewSession } from './NewSession.js'
import { SessionSearch } from './SessionSearch.js'
import type { SessionStore } from './session-store.js'
import { SettingsContent, SettingsNav, type SettingsSection } from './settings/SettingsPage.js'
import { SessionStoreProvider, useSessionStore } from './store-context.js'
import { ThemeSync } from './ThemeSync.js'
import { CairnAppMark, TooltipProvider } from './ui/index.js'

export interface AppProps {
  readonly i18n: I18nInstance
  readonly store?: SessionStore
}

/** 窗口宽度小于这个值时会话列改为抽屉。 */
const NARROW_QUERY = '(max-width: 899px)'

const SHELL = 'flex h-full min-w-0 bg-chrome text-fg'

/** Windows / Linux 自绘按钮占住右上角，标题区右侧留出同样宽度。 */
function windowControlsStyle(): CSSProperties | undefined {
  const platform = window.cairn?.windowControls?.platform
  return platform !== undefined && platform !== 'darwin'
    ? ({ '--window-controls-inset': '150px' } as CSSProperties)
    : undefined
}

function Workspace() {
  const { t } = useTranslation('session')
  const narrow = useMediaQuery(NARROW_QUERY)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const [composing, setComposing] = useState(false)
  const [settings, setSettings] = useState<SettingsSection | undefined>(undefined)
  const [activity, setActivity] = useState(false)
  const [searching, setSearching] = useState(false)
  /** 活动中心要求打开的改动集；`ChatPanel` 打开后清空。 */
  const [pendingChangeSet, setPendingChangeSet] = useState<
    { sessionId: string; changeSetId: string } | undefined
  >()
  const refreshActivity = useSessionStore((s) => s.refreshActivity)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  const onActivityOpen = useSessionStore((s) => s.onActivityOpen)
  const selectSession = useSessionStore((s) => s.selectSession)
  const activityBadge = useSessionStore((s) => s.activity?.counts?.approvals ?? 0)
  const chromeStyle = windowControlsStyle()
  // 还没有会话时直接显示新对话表单；已选中的会话（即使不在列表中）仍显示会话
  const showNew = useSessionStore((s) => s.sessions.length === 0 && s.activeSessionId === undefined)

  // 进入窄窗口时把会话列收成抽屉；窗口变宽后恢复常驻列。
  useEffect(() => {
    setSessionsOpen(!narrow)
  }, [narrow])

  useEffect(() => {
    if (!narrow || !sessionsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      setSessionsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrow, sessionsOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSearchKey(event)) {
        event.preventDefault()
        setSearching(true)
        return
      }
      if (isSettingsKey(event)) {
        event.preventDefault()
        setSessionsOpen(false)
        setSettings((current) => current ?? 'general')
        return
      }
      if (!isNewChatKey(event)) return
      event.preventDefault()
      setSettings(undefined)
      setActivity(false)
      if (narrow) setSessionsOpen(false)
      setComposing(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrow])

  useEffect(() => {
    void refreshActivity()
  }, [refreshActivity])

  // Agent 管理页已移除，但委派卡片与检查器仍需要 Agent 名称，启动时读一次列表。
  useEffect(() => {
    void refreshAgents()
  }, [refreshAgents])

  useEffect(
    () =>
      onActivityOpen(({ sessionId }) => {
        setSettings(undefined)
        setActivity(false)
        setComposing(false)
        void selectSession(sessionId)
        if (narrow) setSessionsOpen(false)
      }),
    [narrow, onActivityOpen, selectSession],
  )

  const closeSettings = useCallback(() => {
    setSettings(undefined)
    // 返回对话时恢复会话列；窄窗口仍保持抽屉关闭。
    if (!narrow) setSessionsOpen(true)
  }, [narrow])

  const openActivity = useCallback(() => {
    setSettings(undefined)
    setComposing(false)
    setSessionsOpen(false)
    setActivity(true)
  }, [])

  const openSessionFromActivity = useCallback(
    (sessionId: string, changeSetId?: string) => {
      setActivity(false)
      setComposing(false)
      setPendingChangeSet(changeSetId === undefined ? undefined : { sessionId, changeSetId })
      void selectSession(sessionId)
      if (narrow) setSessionsOpen(false)
    },
    [narrow, selectSession],
  )

  /** 图标栏的“会话”：从其他页面回来时打开列表，已经在对话页时切换开合。 */
  const toggleSessions = useCallback(() => {
    const elsewhere = settings !== undefined || activity
    if (elsewhere) {
      setSettings(undefined)
      setActivity(false)
      setComposing(false)
      setSessionsOpen(true)
      return
    }
    setSessionsOpen((current) => !current)
  }, [activity, settings])

  const newChat = useCallback(() => {
    setSettings(undefined)
    setActivity(false)
    setComposing(true)
  }, [])

  const sidebarProps = {
    onNewChat: () => {
      if (narrow) setSessionsOpen(false)
      newChat()
    },
    onClose: () => setSessionsOpen(false),
    onSearch: () => {
      setSessionsOpen(false)
      setSearching(true)
    },
    onSelect: () => {
      if (narrow) setSessionsOpen(false)
      setComposing(false)
      setActivity(false)
    },
  } as const

  const rail = (
    <AppRail
      onNewChat={newChat}
      onSessions={toggleSessions}
      onSearch={() => setSearching(true)}
      onActivity={openActivity}
      onSettings={() => {
        setSessionsOpen(false)
        setSettings('general')
      }}
      sessionsActive={settings === undefined && !activity}
      activityActive={activity}
      activityBadge={activityBadge}
    />
  )

  const search = (
    <SessionSearch
      open={searching}
      onOpenChange={setSearching}
      onSelect={() => {
        setSettings(undefined)
        setActivity(false)
        setComposing(false)
        setSessionsOpen(false)
      }}
    />
  )

  const drawer =
    narrow && sessionsOpen ? (
      <div className="fixed inset-y-0 right-0 left-[60px] z-50">
        <div
          aria-hidden
          className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
          onClick={() => setSessionsOpen(false)}
        />
        <div className="absolute inset-y-0 left-0 border-r-[0.5px] border-hair bg-chrome shadow-3">
          <Sidebar open {...sidebarProps} />
        </div>
      </div>
    ) : null

  if (settings) {
    return (
      <div className={SHELL} style={chromeStyle}>
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
        <WindowControls />
        {rail}
        <SettingsNav
          open
          collapsible={false}
          section={settings}
          onSelect={setSettings}
          onBack={closeSettings}
          onCollapse={closeSettings}
        />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
          <ErrorBanner />
          <SettingsContent section={settings} onBack={closeSettings} />
        </main>
        {drawer}
        {search}
      </div>
    )
  }

  if (activity) {
    return (
      <div className={SHELL} style={chromeStyle}>
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
        <WindowControls />
        {rail}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
          <ErrorBanner />
          <ActivityView onOpenSession={openSessionFromActivity} />
        </main>
        {drawer}
        {search}
      </div>
    )
  }

  return (
    <div className={SHELL} style={chromeStyle}>
      {/* 应用名只给读屏（窗口标题区不显示文字）；冒烟检查也据此确认界面已渲染 */}
      <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
      <WindowControls />
      {rail}
      {!narrow && <Sidebar open={sessionsOpen} {...sidebarProps} />}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
        <ErrorBanner />
        {composing || showNew ? (
          <>
            <TopBar>
              <span className="text-note text-muted">{t('list.new')}</span>
            </TopBar>
            <NewSession
              onDone={() => setComposing(false)}
              onSettings={() => setSettings('providers')}
            />
          </>
        ) : (
          <ChatPanel
            {...(pendingChangeSet === undefined
              ? {}
              : {
                  initialChangeSetId: pendingChangeSet.changeSetId,
                  initialChangeSetSessionId: pendingChangeSet.sessionId,
                })}
            onInitialChangeSetOpened={() => setPendingChangeSet(undefined)}
          />
        )}
      </main>
      {drawer}
      {search}
    </div>
  )
}

function Shell({ store }: Omit<AppProps, 'i18n'>) {
  const { t } = useTranslation()
  if (!store) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 bg-chrome">
        <CairnAppMark size={64} label={t('app.name')} className="text-fg" />
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
