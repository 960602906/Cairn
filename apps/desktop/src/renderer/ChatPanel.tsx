/**
 * 当前会话（01 枢纽）：48px 顶栏 + 对话列 + 右侧常驻工作台。
 *
 * 宽屏（≥1440px）工作台占布局宽度；更窄时改为右侧浮层，由顶栏按钮开合，避免把正文挤到
 * 500px 以下。正文最大 840px，输入框最大 880px。会话切换、订阅恢复、审批与检查器行为沿用
 * 原有 store 投影（M0-15c、M1-11b、M2-04、M2-07、M2-08）。
 */
import { FileDiff, PanelRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { activeExecutionPlan, rootRun, sessionStatus } from '@cairn/core'
import { isAgentDraftRef } from '@cairn/protocol'
import { ApprovalList } from './ApprovalCard.js'
import { TurnRail } from './Checkpoints.js'
import { Composer } from './Composer.js'
import { totals, turnEntries } from './file-changes.js'
import { MessageStream } from './MessageStream.js'
import { planInProgress, PlanProgress } from './PlanCard.js'
import { projectNameForPath } from './project-name.js'
import { SESSION_PANELS, SessionSidePanel, type SessionPanel } from './SessionSidePanel.js'
import { useStickToBottom } from './stick-to-bottom.js'
import { useSessionStore } from './store-context.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { TITLE_BAR_INSET } from './layout/WindowControls.js'
import { cn, IconButton } from './ui/index.js'

/** 工作台从浮层切到常驻列的宽度；1280/1366 下仍保持浮层，避免把正文挤到 600px 以下。 */
const PANEL_DOCK_QUERY = '(min-width: 1440px)'

/** 纸面顶栏（48px）：和对话同一底色，左侧是项目 / 会话面包屑，右侧是会话信息栏开关。 */
export function TopBar({ children }: { readonly children?: ReactNode }) {
  return (
    <header
      className="drag relative flex h-12 shrink-0 items-center gap-1.5 bg-paper pr-3 pl-5"
      style={TITLE_BAR_INSET}
    >
      {children}
      {/* 线条放在顶栏之外，避免被窗口按钮或拖拽区裁切。 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full z-[5] block h-[0.5px] bg-hair"
      />
    </header>
  )
}

export function ChatPanel({
  initialChangeSetId,
  initialChangeSetSessionId,
  onInitialChangeSetOpened,
  notice,
  leading,
}: {
  /** 从活动中心等入口打开会话时要直接显示的改动集。 */
  readonly initialChangeSetId?: string | undefined
  /** 请求打开改动集的会话；当前会话不同时不打开。 */
  readonly initialChangeSetSessionId?: string | undefined
  readonly onInitialChangeSetOpened?: (() => void) | undefined
  /** 会话标题栏下方的非模态提示（M5-07 的更新提示）。 */
  readonly notice?: ReactNode
  /** 顶栏最左侧的内容：左栏收起时的展开与新对话按钮。 */
  readonly leading?: ReactNode
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
  const defaultModel = useSessionStore((s) => s.settings?.defaultModel)
  const changes = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.changes[s.activeSessionId],
  )
  const [panel, setPanelState] = useState<SessionPanel>('diff')
  /** 右侧已打开的标签（可逐个关闭，关掉最后一个即收起整栏）；跨会话保留。 */
  const [tabs, setTabs] = useState<readonly SessionPanel[]>(SESSION_PANELS)
  /** 切到某个面板；它的标签已被关掉时重新打开。 */
  const setPanel = useCallback((next: SessionPanel) => {
    setTabs((current) =>
      current.includes(next)
        ? current
        : SESSION_PANELS.filter((id) => id === next || current.includes(id)),
    )
    setPanelState(next)
  }, [])
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>()
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | undefined>()
  /** 宽屏工作台常驻；窄屏默认收起，按需浮出。 */
  const docked = useMediaQuery(PANEL_DOCK_QUERY)
  const [panelPreference, setPanelPreference] = useState<boolean>()
  const panelOpen = panelPreference ?? docked
  const overlayOpen = !docked && panelOpen
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useStickToBottom(scroller, content, sessionId ?? '')
  const run = view ? rootRun(view) : undefined

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

  useEffect(() => {
    setSelectedPlanId(undefined)
    setSelectedChangeSetId(undefined)
    setPanel('diff')
  }, [sessionId])

  useEffect(() => {
    if (initialChangeSetId === undefined) return
    if (initialChangeSetSessionId !== undefined && initialChangeSetSessionId !== sessionId) return
    setSelectedChangeSetId(initialChangeSetId)
    setPanel('diff')
    setPanelPreference(true)
    onInitialChangeSetOpened?.()
  }, [initialChangeSetId, initialChangeSetSessionId, onInitialChangeSetOpened, sessionId])

  const closeTab = (id: SessionPanel) => {
    const remaining = tabs.filter((item) => item !== id)
    if (remaining.length === 0) {
      // 关掉最后一个标签就是收起整栏；下次打开时恢复全部标签。
      setTabs(SESSION_PANELS)
      setPanelState('diff')
      setPanelPreference(false)
      return
    }
    setTabs(remaining)
    if (panel === id) {
      const index = tabs.indexOf(id)
      setPanelState(remaining[Math.min(index, remaining.length - 1)]!)
    }
  }

  const locateTurn = (runId: string, turnId: string) => {
    void runId
    setPanel('inspector')
    // 浮层会锁住对话区的焦点；先收起浮层，等遮罩和 inert 解除后再定位。
    setPanelPreference(docked)
    requestAnimationFrame(() => {
      const target = scroller.current?.querySelector<HTMLElement>(
        `[data-turn="${CSS.escape(turnId)}"]`,
      )
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      target?.focus({ preventScroll: true })
    })
  }

  // 没有选中的会话时由 App 显示新对话页，这里不再渲染占位内容。
  if (sessionId === undefined) return null

  const title = view?.info?.title ?? summary?.title ?? ''
  const viewStatus = view ? sessionStatus(view) : undefined
  const status = awaiting
    ? viewStatus === 'waiting_approval'
      ? 'waiting_approval'
      : 'running'
    : (viewStatus ?? summary?.status ?? 'idle')
  const path = view?.info?.projectPath ?? summary?.projectPath
  const project = projectNameForPath(path, projects, tc('project.defaultName'))
  const model = view?.info?.model ?? run?.model ?? summary?.model ?? defaultModel
  const executing = view ? activeExecutionPlan(view) : undefined
  const progressPlan = executing && planInProgress(executing) ? executing : undefined
  const turnId = run?.turn?.turnId
  const turnChanges =
    turnId === undefined || changes === undefined ? undefined : totals(turnEntries(changes, turnId))
  return (
    <section aria-labelledby="chat-title" className="flex min-h-0 flex-1 flex-col bg-paper">
      {/* 读屏与端到端测试的运行状态；视觉上不占位，状态变化经 role=status 播报。 */}
      <span role="status" className="sr-only">
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
              onClick={() => {
                setSelectedChangeSetId(undefined)
                setPanel('diff')
                setPanelPreference(true)
              }}
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
            label={t('sidePanel.label')}
            size="icon-sm"
            aria-expanded={panelOpen}
            aria-controls="session-side-panel"
            onClick={() => setPanelPreference(!panelOpen)}
          >
            <PanelRight />
          </IconButton>
        </div>
      </TopBar>
      {notice}
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
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div
              ref={content}
              className={cn(
                'mx-auto flex w-full max-w-[840px] flex-col gap-4 px-5 pt-6 pb-8 text-body min-[1200px]:px-8',
              )}
            >
              <MessageStream
                view={view}
                onOpenChanges={(changeSetId) => {
                  setSelectedChangeSetId(changeSetId)
                  setPanel('diff')
                  setPanelPreference(true)
                }}
                onOpenPlan={(planId) => {
                  setSelectedPlanId(planId)
                  setPanel('plan')
                  setPanelPreference(true)
                }}
              />
              <ApprovalList />
            </div>
          </div>
          <TurnRail view={view} />
          <div className="mx-auto w-full max-w-[880px] px-5 pb-4 min-[1200px]:px-8">
            {progressPlan && (
              <PlanProgress
                key={progressPlan.planId}
                plan={progressPlan}
                onOpen={() => {
                  setSelectedPlanId(progressPlan.planId)
                  setPanel('plan')
                  setPanelPreference(true)
                }}
              />
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
            />
          </div>
        </div>
        <SessionSidePanel
          docked={docked}
          placement="side"
          sessionId={sessionId}
          view={view}
          panel={panel}
          selectedPlanId={selectedPlanId}
          selectedChangeSetId={selectedChangeSetId}
          onSelectChangeSet={setSelectedChangeSetId}
          onPanelChange={setPanel}
          tabs={tabs}
          onCloseTab={closeTab}
          open={panelOpen}
          onClose={() => setPanelPreference(false)}
          onLocateTurn={locateTurn}
        />
      </div>
    </section>
  )
}
