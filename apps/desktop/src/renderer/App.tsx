/**
 * 根组件。界面文案一律通过 i18n key 引用（ADR-0013）。
 *
 * 布局是三栏：252px 左栏（标志、新对话 / 搜索 / 活动、会话列表、设置）、中间的对话、右侧的
 * 会话信息栏。左栏在宽窗口常驻，可以收成 0 宽，收起后由顶栏左侧的按钮展开；窗口窄于 900px
 * 时改为抽屉，避免把正文挤到 600px 以下。设置页用设置导航替换左栏，活动中心显示在主区。
 *
 * ⌘N / Ctrl+N 新对话；⌘K / Ctrl+K 搜索；⌘, / Ctrl+, 设置；Esc 关闭抽屉/返回对话。
 * 主题跟随设置（M2-01，`ThemeSync`）。
 */
import { PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@cairn/i18n'
import type { ProjectSummary } from '@cairn/protocol'
import { ActivityView } from './ActivityView.js'
import { AgentsView } from './agents/AgentsView.js'
import { ChatPanel, TopBar } from './ChatPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { LanguageSwitcher } from './LanguageSwitcher.js'
import { isNewChatKey, isSearchKey, isSettingsKey } from './layout/shortcuts.js'
import { Sidebar } from './layout/Sidebar.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { WindowControls } from './layout/WindowControls.js'
import { NewSession } from './NewSession.js'
import { WelcomeDialog } from './onboarding/WelcomeDialog.js'
import { SessionSearch } from './SessionSearch.js'
import type { SessionStore } from './session-store.js'
import { SettingsContent, SettingsNav, type SettingsSection } from './settings/SettingsPage.js'
import { SessionStoreProvider, useSessionStore } from './store-context.js'
import { ThemeSync } from './ThemeSync.js'
import { UpdateNotice } from './UpdateNotice.js'
import { CairnAppMark, IconButton, TooltipProvider } from './ui/index.js'

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
  const [agentsView, setAgentsView] = useState(false)
  const [searching, setSearching] = useState(false)
  /** 活动中心要求打开的改动集；`ChatPanel` 打开后清空。 */
  const [pendingChangeSet, setPendingChangeSet] = useState<
    { sessionId: string; changeSetId: string } | undefined
  >()
  const [newChatProjectPath, setNewChatProjectPath] = useState<string | undefined>()
  const refreshActivity = useSessionStore((s) => s.refreshActivity)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  const loadUpdateStatus = useSessionStore((s) => s.loadUpdateStatus)
  const userSettings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const onActivityOpen = useSessionStore((s) => s.onActivityOpen)
  const selectSession = useSessionStore((s) => s.selectSession)
  const activityBadge = useSessionStore((s) => s.activity?.counts?.approvals ?? 0)
  const chromeStyle = windowControlsStyle()
  // 没有选中的会话时直接显示新对话页（标志、问候与底部输入框）；选中后（即使不在列表中）显示会话
  const showNew = useSessionStore((s) => s.activeSessionId === undefined)
  const updateNotice = <UpdateNotice onOpenSettings={() => setSettings('update')} />
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const showWelcome = userSettings?.onboardingSeen === false && !welcomeDismissed

  /** 图标栏与 Ctrl+N 共用：离开设置/活动，清掉项目预设，进入新会话页。 */
  const startNewChat = useCallback(() => {
    setSettings(undefined)
    setActivity(false)
    setAgentsView(false)
    setComposing(true)
    setNewChatProjectPath(undefined)
    setPendingChangeSet(undefined)
    if (narrow) setSessionsOpen(false)
  }, [narrow])

  // 进入窄窗口时把会话列收成抽屉；窗口变宽后恢复常驻列。
  useEffect(() => {
    setSessionsOpen(!narrow)
  }, [narrow])

  useEffect(() => {
    if (!narrow || !sessionsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
        )
      )
        return
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
        setAgentsView(false)
        setSettings((current) => current ?? 'general')
        return
      }
      if (!isNewChatKey(event)) return
      event.preventDefault()
      startNewChat()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startNewChat])

  useEffect(() => {
    void refreshActivity()
  }, [refreshActivity])

  // 启动后读取一次更新状态；之后的检查与下载结果经 update.status 推送。
  useEffect(() => {
    void loadUpdateStatus()
  }, [loadUpdateStatus])

  // 委派卡片、检查器与 Agents 页都需要 Agent 名称，启动时读一次列表。
  useEffect(() => {
    void refreshAgents()
  }, [refreshAgents])

  useEffect(
    () =>
      onActivityOpen(({ sessionId }) => {
        setSettings(undefined)
        setActivity(false)
        setAgentsView(false)
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
    setAgentsView(false)
    setComposing(false)
    if (narrow) setSessionsOpen(false)
    setActivity(true)
  }, [narrow])

  /** 左栏收起后，从顶栏按钮展开；不离开当前页面。 */
  const openSessions = useCallback(() => setSessionsOpen(true), [])

  const openAgents = useCallback(() => {
    setSettings(undefined)
    setActivity(false)
    setComposing(false)
    setAgentsView(true)
    if (narrow) setSessionsOpen(false)
  }, [narrow])

  const openSessionFromActivity = useCallback(
    (sessionId: string, changeSetId?: string) => {
      setActivity(false)
      setAgentsView(false)
      setComposing(false)
      setPendingChangeSet(changeSetId === undefined ? undefined : { sessionId, changeSetId })
      void selectSession(sessionId)
      if (narrow) setSessionsOpen(false)
    },
    [narrow, selectSession],
  )

  const configureModels = useCallback(() => {
    setSettings('providers')
    setActivity(false)
    setAgentsView(false)
    setComposing(false)
    setSessionsOpen(false)
  }, [])

  const closeWelcome = useCallback(() => {
    setWelcomeDismissed(true)
    void updateSettings({ onboardingSeen: true })
  }, [updateSettings])

  const welcome = (
    <WelcomeDialog
      open={showWelcome}
      onOpenChange={(next) => {
        if (!next) closeWelcome()
      }}
      onConfigure={configureModels}
    />
  )

  const sidebarProps = {
    onClose: () => setSessionsOpen(false),
    onSearch: () => {
      setSessionsOpen(false)
      setSearching(true)
    },
    onSelect: () => {
      if (narrow) setSessionsOpen(false)
      setComposing(false)
      setActivity(false)
      setAgentsView(false)
    },
    onNewChat: startNewChat,
    onActivity: openActivity,
    onAgents: openAgents,
    onSettings: () => {
      setSessionsOpen(false)
      setAgentsView(false)
      setSettings('general')
    },
    activityActive: activity,
    agentsActive: agentsView,
    activityBadge,
    onNewConversationProject: (project: ProjectSummary) => {
      if (narrow) setSessionsOpen(false)
      setSettings(undefined)
      setActivity(false)
      setAgentsView(false)
      setNewChatProjectPath(project.path)
      setComposing(true)
    },
  } as const

  /** 左栏收起（或窄窗口）时，顶栏左侧提供展开入口。 */
  const reveal = sessionsOpen ? null : (
    <div className="no-drag mr-1 flex shrink-0 items-center gap-0.5">
      <IconButton label={t('sidebar.expand')} size="icon-sm" onClick={openSessions}>
        <PanelLeftOpen />
      </IconButton>
    </div>
  )

  const search = (
    <SessionSearch
      open={searching}
      onOpenChange={setSearching}
      onSelect={() => {
        setSettings(undefined)
        setActivity(false)
        setAgentsView(false)
        setComposing(false)
        setSessionsOpen(false)
      }}
    />
  )

  const drawer =
    narrow && sessionsOpen ? (
      <div className="fixed inset-0 z-50">
        <div
          aria-hidden
          className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
          onClick={() => setSessionsOpen(false)}
        />
        <div className="absolute inset-y-0 left-0 bg-chrome shadow-3">
          <Sidebar open {...sidebarProps} />
        </div>
      </div>
    ) : null

  if (settings) {
    return (
      <div className={SHELL} style={chromeStyle}>
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
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
        {welcome}
        <WindowControls />
      </div>
    )
  }

  if (activity) {
    return (
      <div className={SHELL} style={chromeStyle}>
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
        {!narrow && <Sidebar open={sessionsOpen} {...sidebarProps} />}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
          <ErrorBanner />
          <ActivityView leading={reveal} onOpenSession={openSessionFromActivity} />
        </main>
        {drawer}
        {search}
        {welcome}
        <WindowControls />
      </div>
    )
  }

  if (agentsView) {
    return (
      <div className={SHELL} style={chromeStyle}>
        <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
        {!narrow && <Sidebar open={sessionsOpen} {...sidebarProps} />}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
          <ErrorBanner />
          <AgentsView leading={reveal} />
        </main>
        {drawer}
        {search}
        {welcome}
        <WindowControls />
      </div>
    )
  }

  return (
    <div className={SHELL} style={chromeStyle}>
      {/* 应用名只给读屏（窗口标题区不显示文字）；冒烟检查也据此确认界面已渲染 */}
      <h1 className="sr-only">{t('app.name', { ns: 'common' })}</h1>
      {!narrow && <Sidebar open={sessionsOpen} {...sidebarProps} />}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
        <ErrorBanner />
        {composing || showNew ? (
          <>
            <TopBar>{reveal}</TopBar>
            {updateNotice}
            <NewSession
              initialProjectPath={newChatProjectPath}
              onDone={() => setComposing(false)}
            />
          </>
        ) : (
          <ChatPanel
            leading={reveal}
            notice={updateNotice}
            onNewChat={startNewChat}
            onOpenSettings={setSettings}
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
      {welcome}
      <WindowControls />
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
