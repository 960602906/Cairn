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
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import type { I18nInstance } from '@cairn/i18n'
import type { ProjectSummary } from '@cairn/protocol'
import { ErrorBanner } from './ErrorBanner.js'
import { onIdle } from './idle.js'
import { LanguageSwitcher } from './LanguageSwitcher.js'
import {
  adjacentSessionId,
  COMPOSER_FOCUS_EVENT,
  isFocusComposerKey,
  isNewChatKey,
  isNextSessionKey,
  isPreviousSessionKey,
  isSearchKey,
  isSettingsKey,
  isToggleSidebarKey,
  toggleSidebarShortcut,
} from './layout/shortcuts.js'
import { Sidebar } from './layout/Sidebar.js'
import { TopBar } from './layout/TopBar.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { WindowControls } from './layout/WindowControls.js'
import { readNewSessionProject, writeNewSessionProject } from './composer-drafts.js'
import { NewSession } from './NewSession.js'
import type { SessionStore } from './session-store.js'
import type { SettingsSection } from './settings/SettingsPage.js'
import { SessionStoreProvider, useSessionStore } from './store-context.js'
import { ThemeSync } from './ThemeSync.js'
import { CairnAppMark, cn, IconButton, TooltipProvider } from './ui/index.js'

/**
 * 首屏只显示侧栏与新对话页；对话页、设置、活动、搜索与欢迎框按需加载。
 * 对话页会带出 Markdown、Shiki、diff 与右侧工作台，是首屏最大的一块。
 */
const ChatPanel = lazy(() =>
  import('./ChatPanel.js').then((module) => ({ default: module.ChatPanel })),
)
const SettingsNav = lazy(() =>
  import('./settings/SettingsPage.js').then((module) => ({ default: module.SettingsNav })),
)
const SettingsContent = lazy(() =>
  import('./settings/SettingsPage.js').then((module) => ({ default: module.SettingsContent })),
)
const ActivityView = lazy(() =>
  import('./ActivityView.js').then((module) => ({ default: module.ActivityView })),
)
const SessionSearch = lazy(() =>
  import('./SessionSearch.js').then((module) => ({ default: module.SessionSearch })),
)
const WelcomeDialog = lazy(() =>
  import('./onboarding/WelcomeDialog.js').then((module) => ({ default: module.WelcomeDialog })),
)
const WhatsNewDialog = lazy(() =>
  import('./WhatsNewDialog.js').then((module) => ({ default: module.WhatsNewDialog })),
)

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
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  /**
   * 是否停在新对话页。不能用 `activeSessionId === undefined` 直接判断：新建会话时它会先一步
   * 变好，那时第一条消息还没送到，切到会话页会闪一下空状态（欢迎屏一闪而过）。所以进入或
   * 回到新对话页后由这个状态记住，直到新会话的第一条消息发出（`onDone`）或改选了别的会话。
   */
  const [composing, setComposing] = useState(() => activeSessionId === undefined)
  /**
   * 新对话页正在创建会话并发出第一条消息。这段时间里 `activeSessionId` 会先变好，
   * 但页面不能跟着切走，否则消息区会闪一下空状态。用 ref 记下来，判断时不触发重渲染。
   */
  const creatingSession = useRef(false)
  const [settings, setSettings] = useState<SettingsSection | undefined>(undefined)
  const [activity, setActivity] = useState(false)
  const [searching, setSearching] = useState(false)
  /** 活动中心要求打开的改动集；`ChatPanel` 打开后清空。 */
  const [pendingChangeSet, setPendingChangeSet] = useState<
    { sessionId: string; changeSetId: string } | undefined
  >()
  const [newChatProjectPath, setNewChatProjectPath] = useState<string | undefined>()
  const refreshActivity = useSessionStore((s) => s.refreshActivity)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  const refreshTeams = useSessionStore((s) => s.refreshTeams)
  const loadUpdateStatus = useSessionStore((s) => s.loadUpdateStatus)
  const userSettings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const onActivityOpen = useSessionStore((s) => s.onActivityOpen)
  const selectSession = useSessionStore((s) => s.selectSession)
  const sessions = useSessionStore((s) => s.sessions)
  const activityBadge = useSessionStore((s) => s.activity?.counts?.approvals ?? 0)
  const chromeStyle = windowControlsStyle()
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const showWelcome = userSettings?.onboardingSeen === false && !welcomeDismissed

  /** 图标栏与 Ctrl+N 共用：离开设置/活动，清掉项目预设，进入新会话页。 */
  const startNewChat = useCallback(() => {
    setSettings(undefined)
    setActivity(false)
    setComposing(true)
    setNewChatProjectPath(undefined)
    setPendingChangeSet(undefined)
    if (narrow) setSessionsOpen(false)
  }, [narrow])

  /** 切换到指定会话：离开设置 / 活动中心，回到对话页。 */
  const openSessionById = useCallback(
    (sessionId: string) => {
      setSettings(undefined)
      setActivity(false)
      setComposing(false)
      setPendingChangeSet(undefined)
      void selectSession(sessionId)
      if (narrow) setSessionsOpen(false)
    },
    [narrow, selectSession],
  )

  // 进入窄窗口时把会话列收成抽屉；窗口变宽后恢复常驻列。
  useEffect(() => {
    setSessionsOpen(!narrow)
  }, [narrow])

  // 会话被归档或取消选中后回到新对话页；选中别的会话时离开它。
  useEffect(() => {
    if (activeSessionId === undefined) setComposing(true)
    else if (!creatingSession.current) setComposing(false)
  }, [activeSessionId])

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

  // 聚焦输入框、收起侧栏、切换会话：对话框 / 菜单打开时让给它们。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="dialog"]:not([aria-hidden="true"]), [role="menu"], [role="listbox"]',
        )
      )
        return
      if (isFocusComposerKey(event)) {
        event.preventDefault()
        window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT))
        return
      }
      if (isToggleSidebarKey(event)) {
        // 设置页的左栏是设置导航，本身不可收起。
        if (settings !== undefined) return
        event.preventDefault()
        setSessionsOpen((open) => !open)
        return
      }
      if (!isPreviousSessionKey(event) && !isNextSessionKey(event)) return
      const target = adjacentSessionId(sessions, activeSessionId, isNextSessionKey(event) ? 1 : -1)
      if (target === undefined) return
      event.preventDefault()
      openSessionById(target)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeSessionId, openSessionById, sessions, settings])

  // 活动角标不参与首屏：首帧之后再读，避免主进程在首屏同时重扫全部会话。
  useEffect(() => onIdle(() => void refreshActivity(), 1000), [refreshActivity])

  // 启动后读取一次更新状态；之后的检查与下载结果经 update.status 推送。首帧之后再做。
  useEffect(() => onIdle(() => void loadUpdateStatus(), 1000), [loadUpdateStatus])

  // 委派卡片、检查器、设置与输入框都需要 Agent 名称；带上已归档的，会话里正在用的 Agent
  // 归档后仍能显示原来的名称。团队模板随输入框选择器一起读取，设置页改动后会再刷新。
  useEffect(() => {
    void refreshAgents({ includeArchived: true })
    void refreshTeams()
  }, [refreshAgents, refreshTeams])

  // 首屏之后预取对话页 chunk：点开会话时无需再等模块加载，也不占用首帧。
  // 测试环境不预取：用例结束后的动态 import 会落在已销毁的环境里。
  useEffect(() => {
    if (import.meta.env.MODE === 'test') return
    return onIdle(() => void import('./ChatPanel.js'), 2000)
  }, [])

  useEffect(
    () => onActivityOpen(({ sessionId }) => openSessionById(sessionId)),
    [onActivityOpen, openSessionById],
  )

  const closeSettings = useCallback(() => {
    setSettings(undefined)
    // 返回对话时恢复会话列；窄窗口仍保持抽屉关闭。
    if (!narrow) setSessionsOpen(true)
  }, [narrow])

  const openActivity = useCallback(() => {
    setSettings(undefined)
    setComposing(false)
    if (narrow) setSessionsOpen(false)
    setActivity(true)
  }, [narrow])

  /** 左栏收起后，从顶栏按钮展开；不离开当前页面。 */
  const openSessions = useCallback(() => setSessionsOpen(true), [])

  const openSessionFromActivity = useCallback(
    (sessionId: string, changeSetId?: string) => {
      openSessionById(sessionId)
      if (changeSetId !== undefined) setPendingChangeSet({ sessionId, changeSetId })
    },
    [openSessionById],
  )

  const configureModels = useCallback(() => {
    setSettings('providers')
    setActivity(false)
    setComposing(false)
    setSessionsOpen(false)
  }, [])

  const closeWelcome = useCallback(() => {
    setWelcomeDismissed(true)
    void updateSettings({ onboardingSeen: true })
  }, [updateSettings])

  const welcome = showWelcome ? (
    <Suspense fallback={null}>
      <WelcomeDialog
        open
        onOpenChange={(next) => {
          if (!next) closeWelcome()
        }}
        onConfigure={configureModels}
      />
    </Suspense>
  ) : null

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
    },
    onNewChat: startNewChat,
    onActivity: openActivity,
    onSettings: () => {
      setSessionsOpen(false)
      setSettings('general')
    },
    activityActive: activity,
    activityBadge,
    onNewConversationProject: (project: ProjectSummary) => {
      if (narrow) setSessionsOpen(false)
      setSettings(undefined)
      setActivity(false)
      setNewChatProjectPath(project.path)
      setComposing(true)
    },
    onSelectWorkspace: (project: ProjectSummary) => {
      writeNewSessionProject(project.path)
      setNewChatProjectPath(project.path)
    },
    selectedProjectPath:
      newChatProjectPath ??
      sessions.find((session) => session.sessionId === activeSessionId)?.projectPath ??
      readNewSessionProject() ??
      undefined,
  } as const

  /**
   * 左栏收起（或窄窗口）时，顶栏左侧提供展开入口。macOS 上这时红绿灯落在纸面左上角，
   * 按钮向右让出位置（顶栏左内边距 12～20px，再加 64px，越过红绿灯）。
   */
  const mac = window.cairn?.windowControls?.platform === 'darwin'
  const reveal = sessionsOpen ? null : (
    <div
      data-sidebar-reveal
      className={cn('no-drag mr-1 flex shrink-0 items-center gap-0.5', mac && 'ml-16')}
    >
      <IconButton
        label={t('sidebar.expand')}
        title={`${t('sidebar.expand')} (${toggleSidebarShortcut()})`}
        size="icon-sm"
        onClick={openSessions}
      >
        <PanelLeftOpen />
      </IconButton>
    </div>
  )

  const search = searching ? (
    <Suspense fallback={null}>
      <SessionSearch
        open
        onOpenChange={setSearching}
        onSelect={() => {
          setSettings(undefined)
          setActivity(false)
          setComposing(false)
          setSessionsOpen(false)
        }}
      />
    </Suspense>
  ) : null

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
        <Suspense fallback={<div className="h-full w-[252px] shrink-0 bg-chrome" />}>
          <SettingsNav
            open
            collapsible={false}
            section={settings}
            onSelect={setSettings}
            onBack={closeSettings}
            onCollapse={closeSettings}
          />
        </Suspense>
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
          <ErrorBanner />
          <Suspense fallback={<div className="flex-1 bg-paper" />}>
            <SettingsContent section={settings} onBack={closeSettings} onNavigate={setSettings} />
          </Suspense>
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
          <Suspense fallback={<div className="flex-1 bg-paper" />}>
            <ActivityView leading={reveal} onOpenSession={openSessionFromActivity} />
          </Suspense>
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
        {composing ? (
          <>
            <TopBar>{reveal}</TopBar>
            <NewSession
              initialProjectPath={newChatProjectPath}
              onCreatingChange={(creating) => {
                creatingSession.current = creating
              }}
              onOpenSettings={setSettings}
              onDone={() => setComposing(false)}
            />
          </>
        ) : (
          <Suspense fallback={<div className="flex-1 bg-paper" />}>
            <ChatPanel
              leading={reveal}
              onNewChat={startNewChat}
              onOpenSettings={setSettings}
              onOpenSearch={() => setSearching(true)}
              {...(pendingChangeSet === undefined
                ? {}
                : {
                    initialChangeSetId: pendingChangeSet.changeSetId,
                    initialChangeSetSessionId: pendingChangeSet.sessionId,
                  })}
              onInitialChangeSetOpened={() => setPendingChangeSet(undefined)}
            />
          </Suspense>
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
  // 欢迎/更新对话框不参与首屏：首帧之后才挂载并加载模块。测试环境直接挂载，与用例原有行为一致。
  const [extrasReady, setExtrasReady] = useState(import.meta.env.MODE === 'test')
  useEffect(() => {
    if (extrasReady) return
    return onIdle(() => setExtrasReady(true), 1500)
  }, [extrasReady])
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
      {extrasReady && (
        <Suspense fallback={null}>
          <WhatsNewDialog />
        </Suspense>
      )}
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
