/**
 * 当前会话（01 枢纽）：48px 顶栏 + 对话列 + 右侧常驻工作台。
 *
 * 宽屏（≥1440px）工作台占布局宽度；更窄时改为右侧浮层，由顶栏按钮开合，避免把正文挤到
 * 500px 以下。正文最大 840px，输入框最大 880px。会话切换、订阅恢复、审批与检查器行为沿用
 * 原有 store 投影（M0-15c、M1-11b、M2-04、M2-07、M2-08）。
 */
import { ArrowDown, FileDiff, PanelRight, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { openGoal, progressTaskList, proposedPlan, rootRun, sessionStatus } from '@cairn/core'
import { isAgentDraftRef } from '@cairn/protocol'
import { ApprovalList } from './ApprovalCard.js'
import { MemoryProposalList } from './MemoryProposalCard.js'
import { QuestionList } from './QuestionCard.js'
import { TurnRail } from './Checkpoints.js'
import { Composer } from './Composer.js'
import { totals, turnEntries, type FileDiffMode } from './file-changes.js'
import { FindBar } from './FindBar.js'
import { MessageStream } from './MessageStream.js'
import { GoalBar } from './GoalBar.js'
import { PlanActions, TaskProgress } from './PlanCard.js'
import { projectNameForPath } from './project-name.js'
import {
  fileTabId,
  fileTabPath,
  isFileTab,
  SessionSidePanel,
  type SessionPanel,
  type SessionPanelTarget,
  type SessionPanelView,
  type SessionTab,
} from './SessionSidePanel.js'
import type { SettingsSection } from './settings/SettingsPage.js'
import { useStickToBottom } from './stick-to-bottom.js'
import { useSessionStore } from './store-context.js'
import { useMediaQuery } from './layout/use-media-query.js'
import {
  COMPOSER_FOCUS_EVENT,
  findShortcut,
  isFindKey,
  isToggleWorkbenchKey,
  toggleWorkbenchShortcut,
} from './layout/shortcuts.js'
import { TopBar } from './layout/TopBar.js'
import { cn, IconButton } from './ui/index.js'

/** 工作台从浮层切到常驻列的宽度；1280/1366 下仍保持浮层，避免把正文挤到 600px 以下。 */
const PANEL_DOCK_QUERY = '(min-width: 1440px)'

export function ChatPanel({
  initialChangeSetId,
  initialChangeSetSessionId,
  onInitialChangeSetOpened,
  leading,
  onNewChat,
  onOpenSettings,
  onOpenSearch,
}: {
  /** 从活动中心等入口打开会话时要直接显示的改动集。 */
  readonly initialChangeSetId?: string | undefined
  /** 请求打开改动集的会话；当前会话不同时不打开。 */
  readonly initialChangeSetSessionId?: string | undefined
  readonly onInitialChangeSetOpened?: (() => void) | undefined
  /** 顶栏最左侧的内容：左栏收起时的展开与新对话按钮。 */
  readonly leading?: ReactNode
  /** 输入框 `/new`。 */
  readonly onNewChat?: (() => void) | undefined
  /** 输入框 `/settings [分区]`。 */
  readonly onOpenSettings?: ((section: SettingsSection) => void) | undefined
  /** 输入框 `/search`。 */
  readonly onOpenSearch?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation()
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const view = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.views[s.activeSessionId],
  )
  const summary = useSessionStore((s) => s.sessions.find((x) => x.sessionId === s.activeSessionId))
  const projects = useSessionStore((s) => s.projects)
  const awaiting = useSessionStore(
    (s) => s.activeSessionId !== undefined && s.awaitingTurn[s.activeSessionId] === true,
  )
  const pendingQuestions = useSessionStore((s) =>
    s.activeSessionId === undefined ? 0 : (s.questions[s.activeSessionId]?.length ?? 0),
  )
  const pendingMemories = view?.memoryProposals.length ?? 0
  const pendingPlan = useSessionStore((s) => {
    const view = s.activeSessionId === undefined ? undefined : s.views[s.activeSessionId]
    return view === undefined ? undefined : proposedPlan(view)
  })
  const defaultModel = useSessionStore((s) => s.settings?.defaultModel)
  const changes = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.changes[s.activeSessionId],
  )
  const [panel, setPanelState] = useState<SessionPanelView>('home')
  /** 右侧已打开的标签；空数组表示只看首页。 */
  const [tabs, setTabs] = useState<readonly SessionTab[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>()
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | undefined>()
  /** 子 Agent 详情面板当前查看的子运行。 */
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  /** 从消息里的路径打开文件时要定位的行号；按路径记住，换标签时仍生效。 */
  const [fileLines, setFileLines] = useState<Readonly<Record<string, number>>>({})
  /** 用户显式选择的文件视图；缺省时由文件是否有改动自动决定。 */
  const [fileModes, setFileModes] = useState<Readonly<Record<string, FileDiffMode>>>({})
  /** 宽屏工作台常驻；窄屏默认收起，按需浮出。 */
  const docked = useMediaQuery(PANEL_DOCK_QUERY)
  const [panelPreference, setPanelPreference] = useState<boolean>()
  const panelOpen = panelPreference ?? docked
  const overlayOpen = !docked && panelOpen
  /** 会话内查找（⌘F）；`findToken` 让再次按快捷键时焦点回到输入框。 */
  const [findOpen, setFindOpen] = useState(false)
  const [findToken, setFindToken] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const { isPinned, scrollToBottom } = useStickToBottom(scroller, content, sessionId ?? '')
  const run = view ? rootRun(view) : undefined

  /** 点击已打开标签：只切换，不重置当前选中项。 */
  const activateTab = useCallback((next: SessionTab) => {
    setTabs((current) => (current.includes(next) ? current : [...current, next]))
    setPanelState(next)
  }, [])

  /** 从首页、对话卡片或「+」菜单打开：必要时补标签，并回到该面板的概览状态。 */
  const openPanel = useCallback(
    (next: SessionPanel, target?: SessionPanelTarget) => {
      if (next === 'diff') setSelectedChangeSetId(target?.changeSetId)
      if (next === 'plan') setSelectedPlanId(target?.planId)
      if (next === 'delegation') setSelectedRunId(target?.runId)
      activateTab(next)
      setPanelPreference(true)
    },
    [activateTab],
  )

  /** 单击文件：追加标签；已经打开时只激活。带行号时打开后定位到那一行。 */
  const openFile = useCallback(
    (path: string, line?: number) => {
      activateTab(fileTabId(path))
      setPanelPreference(true)
      setFileLines((current) => {
        const next = { ...current }
        if (line === undefined) delete next[path]
        else next[path] = line
        return next
      })
      // 带行号的打开是“去看这一行”，保持预览；普通打开回到自动判断。
      setFileModes((current) => {
        const next = { ...current }
        if (line === undefined) delete next[path]
        else next[path] = 'preview'
        return next
      })
    },
    [activateTab],
  )

  /** 用户在文件标签里显式切换视图。 */
  const setFileMode = useCallback((path: string, mode: FileDiffMode) => {
    setFileModes((current) => ({ ...current, [path]: mode }))
  }, [])

  /** 重命名：同步这个文件及子路径下已打开的标签。 */
  const renameFileTabs = useCallback(
    (from: string, to: string) => {
      const mapped = tabs.map((tab) => {
        if (!isFileTab(tab)) return tab
        const path = fileTabPath(tab)
        if (path !== from && !path.startsWith(`${from}/`)) return tab
        return fileTabId(`${to}${path.slice(from.length)}`)
      })
      const next = [...new Set(mapped)]
      setTabs(next)
      setFileLines((current) => {
        const lines: Record<string, number> = {}
        for (const [path, line] of Object.entries(current)) {
          if (path !== from && !path.startsWith(`${from}/`)) lines[path] = line
          else lines[`${to}${path.slice(from.length)}`] = line
        }
        return lines
      })
      setFileModes((current) => {
        const modes: Record<string, FileDiffMode> = {}
        for (const [path, mode] of Object.entries(current)) {
          if (path !== from && !path.startsWith(`${from}/`)) modes[path] = mode
          else modes[`${to}${path.slice(from.length)}`] = mode
        }
        return modes
      })
      setPanelState((current) => {
        if (!isFileTab(current)) return current
        const path = fileTabPath(current)
        if (path !== from && !path.startsWith(`${from}/`)) return current
        return fileTabId(`${to}${path.slice(from.length)}`)
      })
    },
    [tabs],
  )

  /** 删除：关闭这个文件或目录下已打开的标签。 */
  const deleteFileTabs = useCallback(
    (path: string) => {
      const matches = (tab: SessionTab) =>
        isFileTab(tab) && (fileTabPath(tab) === path || fileTabPath(tab).startsWith(`${path}/`))
      const index = tabs.findIndex((tab) => tab === panel)
      const next = tabs.filter((tab) => !matches(tab))
      setTabs(next)
      setFileLines((current) => {
        const lines: Record<string, number> = {}
        for (const [key, line] of Object.entries(current)) {
          if (key !== path && !key.startsWith(`${path}/`)) lines[key] = line
        }
        return lines
      })
      setFileModes((current) => {
        const modes: Record<string, FileDiffMode> = {}
        for (const [key, mode] of Object.entries(current)) {
          if (key !== path && !key.startsWith(`${path}/`)) modes[key] = mode
        }
        return modes
      })
      if (isFileTab(panel) && matches(panel)) {
        setPanelState(next[Math.min(Math.max(index, 0), next.length - 1)] ?? 'home')
      }
    },
    [panel, tabs],
  )

  // 跨断点时恢复默认：宽屏常驻，窄屏收起，避免缩窗后浮层突然盖住对话。
  useEffect(() => {
    setPanelPreference(undefined)
  }, [docked])

  useEffect(() => {
    if (!overlayOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // 菜单、命令面板或其他对话框先处理 Esc；工作台自己不算阻塞。
      if (
        document.querySelector(
          '[role="menu"], [role="listbox"], [role="dialog"]:not([data-side-panel-dialog]):not([aria-hidden="true"])',
        )
      )
        return
      event.preventDefault()
      setPanelPreference(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlayOpen])

  // ⌘F 查找、⌘J 收起或展开工作台；对话框 / 菜单打开时让给它们。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        document.querySelector(
          '[role="menu"], [role="listbox"], [role="dialog"]:not([aria-hidden="true"])',
        )
      )
        return
      if (isFindKey(event)) {
        event.preventDefault()
        setFindOpen(true)
        setFindToken((token) => token + 1)
        return
      }
      if (!isToggleWorkbenchKey(event)) return
      event.preventDefault()
      setPanelPreference((current) => !(current ?? docked))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [docked])

  useEffect(() => {
    setSelectedPlanId(undefined)
    setSelectedChangeSetId(undefined)
    setSelectedRunId(undefined)
    setFileModes({})
    setTabs([])
    setPanelState('home')
    setFindOpen(false)
  }, [sessionId])

  useEffect(() => {
    if (initialChangeSetId === undefined) return
    if (initialChangeSetSessionId !== undefined && initialChangeSetSessionId !== sessionId) return
    openPanel('diff', { changeSetId: initialChangeSetId })
    onInitialChangeSetOpened?.()
  }, [
    initialChangeSetId,
    initialChangeSetSessionId,
    onInitialChangeSetOpened,
    openPanel,
    sessionId,
  ])

  const closeTab = (id: SessionTab) => {
    const remaining = tabs.filter((item) => item !== id)
    if (remaining.length === 0) {
      // 关掉最后一个标签回到首页，工作台本身保持打开。
      setTabs([])
      setPanelState('home')
      return
    }
    setTabs(remaining)
    if (panel === id) {
      const index = tabs.indexOf(id)
      setPanelState(remaining[Math.min(index, remaining.length - 1)]!)
    }
  }

  /** 关闭查找条后输入框消失，把焦点交还输入框，Esc / 关闭后可以接着打字。 */
  const closeFind = () => {
    setFindOpen(false)
    window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT))
  }

  // 没有选中的会话时由 App 显示新对话页，这里不再渲染占位内容。
  if (sessionId === undefined) return null

  const title = view?.info?.title ?? summary?.title ?? ''
  const viewStatus = view ? sessionStatus(view) : undefined
  const status = awaiting
    ? pendingQuestions > 0
      ? 'waiting_input'
      : viewStatus === 'waiting_approval'
        ? 'waiting_approval'
        : 'running'
    : (viewStatus ?? summary?.status ?? 'idle')
  const path = view?.info?.projectPath ?? summary?.projectPath
  const project = projectNameForPath(path, projects, tc('project.defaultName'))
  const model = view?.info?.model ?? run?.model ?? summary?.model ?? defaultModel
  const progressList = view ? progressTaskList(view) : undefined
  const progressPlan =
    view && progressList?.planId
      ? view.plans.find((plan) => plan.planId === progressList.planId)
      : undefined
  const goal = view === undefined ? undefined : openGoal(view)
  /** 输入框上方是否已有其它悬浮内容（提问、计划、记忆提案、任务进度、目标条）。 */
  const floatingContent =
    pendingQuestions > 0 ||
    pendingPlan !== undefined ||
    pendingMemories > 0 ||
    progressList !== undefined ||
    goal !== undefined
  const turnId = run?.turn?.turnId
  const turnChanges =
    turnId === undefined || changes === undefined ? undefined : totals(turnEntries(changes, turnId))
  return (
    <section aria-labelledby="chat-title" className="flex min-h-0 flex-1 flex-col bg-paper">
      {/* 读屏与端到端测试的运行状态；视觉上不占位。role=status 只在文字变化（状态变化）时播报，
          不额外计时或重复播报；不在这里新增可见状态条（聊天区域状态显示优化方案 §1.2）。 */}
      <span role="status" aria-atomic="true" className="sr-only">
        {t(`status.${status}`)}
      </span>
      <TopBar>
        {leading}
        {project && (
          <>
            <span
              title={path}
              className="flex min-w-0 shrink items-center gap-1.5 text-note text-muted"
            >
              <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0">
                <path
                  d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
              </svg>
              <span className="max-w-[220px] truncate">{project}</span>
            </span>
            <span aria-hidden className="shrink-0 text-faint">
              /
            </span>
          </>
        )}
        <h2 id="chat-title" className="min-w-0 truncate text-ui font-semibold text-fg">
          {title === '' ? t('title.untitled') : title}
        </h2>
        {view?.agentsMd && (
          <span
            title={t('chat.agentsMd.loaded', { lines: view.agentsMd.lines })}
            aria-label={t('chat.agentsMd.loaded', { lines: view.agentsMd.lines })}
            className="shrink-0 rounded-[5px] bg-sunk px-1.5 py-0.5 text-[11.5px] text-muted"
          >
            {t('chat.agentsMd.mark')}
          </span>
        )}
        <div className="no-drag ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
          {turnChanges !== undefined && turnChanges.files > 0 && (
            <button
              type="button"
              onClick={() => openPanel('diff')}
              className="hidden h-7 items-center gap-1.5 rounded-item px-2 text-note text-muted outline-none hover:bg-hover hover:text-fg2 focus-visible:ring-1 focus-visible:ring-accent min-[1200px]:flex"
            >
              <FileDiff aria-hidden className="size-3.5" />
              <span className="tabular">
                {t('chat.turnChanges', {
                  count: turnChanges.files,
                  added: turnChanges.added,
                  removed: turnChanges.removed,
                })}
              </span>
            </button>
          )}
          <IconButton
            label={t('find.open')}
            title={`${t('find.open')} (${findShortcut()})`}
            size="icon-sm"
            aria-expanded={findOpen}
            onClick={() => {
              setFindOpen(true)
              setFindToken((token) => token + 1)
            }}
          >
            <Search />
          </IconButton>
          <IconButton
            label={t('sidePanel.label')}
            title={`${t('sidePanel.label')} (${toggleWorkbenchShortcut()})`}
            size="icon-sm"
            aria-expanded={panelOpen}
            aria-controls="session-side-panel"
            onClick={() => setPanelPreference(!panelOpen)}
          >
            <PanelRight />
          </IconButton>
        </div>
      </TopBar>
      <div className="relative flex min-h-0 flex-1">
        {overlayOpen && (
          <div
            aria-hidden
            data-testid="session-panel-overlay"
            className="absolute inset-0 z-10 bg-black/40 backdrop-blur-[1px]"
            onClick={() => setPanelPreference(false)}
          />
        )}
        <div
          aria-hidden={overlayOpen}
          inert={overlayOpen}
          className="relative flex min-w-0 flex-1 flex-col"
        >
          <FindBar
            open={findOpen}
            root={content}
            revision={view}
            focusToken={findToken}
            onClose={closeFind}
          />
          {/* 滚动位置由 useStickToBottom 自己维护：关掉浏览器的滚动锚定，否则新内容插入会打断平滑滚动 */}
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
            <div
              ref={content}
              className={cn(
                'mx-auto flex w-full max-w-[840px] flex-col gap-4 px-5 pt-6 text-body min-[1200px]:px-8',
                // 有浮动面板时多留一段底部空白，滚到底也能看到消息末尾而不被面板盖住。
                pendingQuestions > 0 || pendingPlan !== undefined || pendingMemories > 0
                  ? 'pb-28'
                  : 'pb-8',
              )}
            >
              <MessageStream
                view={view}
                onOpenChanges={(changeSetId) =>
                  openPanel('diff', changeSetId === undefined ? {} : { changeSetId })
                }
                onOpenPlan={(planId) => openPanel('plan', { planId })}
                onOpenRun={(runId) => openPanel('delegation', { runId })}
                onOpenGoal={() => openPanel('goal')}
                onOpenFile={openFile}
              />
              <ApprovalList />
            </div>
          </div>
          <TurnRail view={view} />
          <div className="relative mx-auto w-full max-w-[880px] px-5 pb-4 min-[1200px]:px-8">
            {/* 提问卡片浮在输入框上方，不占消息流的位置；周围留空处不拦截点击。 */}
            <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 pb-3">
              <div className="pointer-events-auto mx-auto flex max-h-[min(60vh,560px)] max-w-[840px] flex-col gap-2 overflow-y-auto">
                <PlanActions plan={pendingPlan} />
                <QuestionList />
                <MemoryProposalList />
              </div>
            </div>
            {progressList && (
              <TaskProgress
                key={progressList.listId}
                list={progressList}
                running={status === 'running'}
                {...(progressPlan
                  ? {
                      onOpen: () => openPanel('plan', { planId: progressPlan.planId }),
                    }
                  : { labelKey: 'taskList.progress.label' as const })}
              />
            )}
            {view !== undefined && goal !== undefined && (
              <GoalBar
                view={view}
                status={status}
                onOpen={() => openPanel('goal')}
                returnFocus={() => window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT))}
              />
            )}
            {/* 「回到底部」浮在输入框正上方；有其他悬浮卡片（提问、计划、记忆、任务进度、目标）时让位，优先级最低。 */}
            {!isPinned && !floatingContent && (
              <button
                type="button"
                aria-label={t('chat.scrollToBottom')}
                title={t('chat.scrollToBottom')}
                onClick={() => scrollToBottom(true)}
                className="absolute bottom-full left-1/2 z-10 mb-3 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-hair2 bg-raise text-fg shadow-2 transition-all hover:bg-hover hover:scale-105 active:scale-95 focus-visible:ring-1 focus-visible:ring-accent"
              >
                <ArrowDown className="size-4 text-muted" />
                {status === 'running' && (
                  <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent animate-pulse" />
                )}
              </button>
            )}
            <Composer
              key={sessionId}
              sessionId={sessionId}
              status={status}
              run={run}
              agent={run?.agent && !isAgentDraftRef(run.agent) ? run.agent : undefined}
              model={model}
              projectPath={path}
              contextTokens={view?.contextTokens}
              onOpenPanel={(next) => openPanel(next)}
              onNewChat={onNewChat}
              onOpenSettings={onOpenSettings}
              onOpenSearch={onOpenSearch}
            />
          </div>
        </div>
        <SessionSidePanel
          docked={docked}
          placement="side"
          sessionId={sessionId}
          view={view}
          status={status}
          panel={panel}
          selectedPlanId={selectedPlanId}
          selectedChangeSetId={selectedChangeSetId}
          selectedRunId={selectedRunId}
          onSelectChangeSet={setSelectedChangeSetId}
          onOpenPanel={openPanel}
          onActivateTab={activateTab}
          onOpenFile={openFile}
          fileLines={fileLines}
          fileModes={fileModes}
          onFileModeChange={setFileMode}
          onFileRenamed={renameFileTabs}
          onFileDeleted={deleteFileTabs}
          onHome={() => setPanelState('home')}
          tabs={tabs}
          onCloseTab={closeTab}
          open={panelOpen}
          onClose={() => setPanelPreference(false)}
        />
      </div>
    </section>
  )
}
