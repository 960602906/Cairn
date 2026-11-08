/**
 * 当前会话（M0-15c）：标题、运行状态、消息流、未决审批（M1-11b）、输入框与停止按钮。
 * M2-02 起放在纸面上：顶栏是“项目 / 会话标题”（可拖动窗口，右侧给系统按钮让出位置），下面是可滚动的
 * 对话列（最大宽度 700px，内容变高时贴底滚动），输入框悬浮在底部（M2-04，运行状态条也在输入框上方）。
 * 内容都来自 store 中的事件投影，窗口刷新后经 `afterSeq` 补发恢复。订阅返回之前还没有投影，
 * 标题与状态先取会话列表中的值。已发送、等待这一轮开始时显示为运行中（可以停止）。
 * M2-07：右侧会话信息栏列出本会话的改动、要点与完整计划。
 * M2-08：对话列左侧是对话导航条（合并了检查点入口）；撤销本轮移到轮次操作中（`Checkpoints.tsx`）。
 */
import { PanelRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { rootRun, sessionStatus } from '@cairn/core'
import { ApprovalList } from './ApprovalCard.js'
import { TurnRail } from './Checkpoints.js'
import { Composer } from './Composer.js'
import { MessageStream } from './MessageStream.js'
import { lastSegment } from './paths.js'
import { SessionSidePanel, type SessionPanel } from './SessionSidePanel.js'
import { useStickToBottom } from './stick-to-bottom.js'
import { useSessionStore } from './store-context.js'
import { newChatShortcut } from './layout/shortcuts.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { CairnMark, IconButton } from './ui/index.js'

/** 顶栏右侧给 Windows / Linux 叠在窗口右上角的系统按钮让出位置（Window Controls Overlay 的 CSS 变量）。 */
const TITLE_BAR_INSET = {
  paddingRight:
    'max(12px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) - 8px + 12px))',
} as const

/** 纸面顶栏（48px）：左侧可以放展开侧栏按钮与面包屑。 */
export function TopBar({ children }: { readonly children: ReactNode }) {
  return (
    <header
      className="drag relative flex h-12 shrink-0 items-center gap-1.5 pl-3"
      style={TITLE_BAR_INSET}
    >
      {children}
      {/* 线条放在 48px 之外：Windows 的系统按钮覆盖层会盖住标题区内的像素。 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full block h-[0.5px] bg-hair"
      />
    </header>
  )
}

export function ChatPanel({
  leading,
  initialChangeSetId,
  initialChangeSetSessionId,
  onInitialChangeSetOpened,
}: {
  readonly leading?: ReactNode
  /** 从活动中心等入口打开会话时要直接显示的改动集。 */
  readonly initialChangeSetId?: string | undefined
  /** 请求打开改动集的会话；当前会话不同时不打开。 */
  readonly initialChangeSetSessionId?: string | undefined
  readonly onInitialChangeSetOpened?: (() => void) | undefined
}) {
  const { t } = useTranslation('session')
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  useEffect(() => {
    void refreshAgents({ includeArchived: true })
  }, [refreshAgents])
  const view = useSessionStore((s) =>
    s.activeSessionId === undefined ? undefined : s.views[s.activeSessionId],
  )
  const summary = useSessionStore((s) => s.sessions.find((x) => x.sessionId === s.activeSessionId))
  const projects = useSessionStore((s) => s.projects)
  const awaiting = useSessionStore(
    (s) => s.activeSessionId !== undefined && s.awaitingTurn[s.activeSessionId] === true,
  )
  const defaultModel = useSessionStore((s) => s.settings?.defaultModel)
  const [panel, setPanel] = useState<SessionPanel>('diff')
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>()
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | undefined>()
  const [locatedTurnId, setLocatedTurnId] = useState<string | undefined>()
  const wide = useMediaQuery('(min-width: 1200px)')
  const [panelPreference, setPanelPreference] = useState<boolean>()
  const panelOpen = panelPreference ?? wide
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useStickToBottom(scroller, content, sessionId ?? '')

  useEffect(() => {
    setSelectedPlanId(undefined)
    setSelectedChangeSetId(undefined)
    setLocatedTurnId(undefined)
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

  const locateTurn = (runId: string, turnId: string) => {
    void runId
    setLocatedTurnId(turnId)
    setPanel('inspector')
    setPanelPreference(true)
    requestAnimationFrame(() => {
      const target = scroller.current?.querySelector<HTMLElement>(
        `[data-turn="${CSS.escape(turnId)}"]`,
      )
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      target?.focus({ preventScroll: true })
    })
  }

  if (sessionId === undefined) {
    return (
      <>
        <TopBar>{leading}</TopBar>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ui text-muted">
          <CairnMark size={48} className="text-faint" />
          <p>{t('chat.empty')}</p>
          <p className="text-note text-faint">
            {t('chat.emptyHint', { shortcut: newChatShortcut() })}
          </p>
        </div>
      </>
    )
  }

  const title = view?.info?.title ?? summary?.title ?? ''
  const status = awaiting ? 'running' : view ? sessionStatus(view) : (summary?.status ?? 'idle')
  const run = view && rootRun(view)
  const path = view?.info?.projectPath ?? summary?.projectPath
  const project = path && (projects.find((p) => p.path === path)?.name ?? lastSegment(path))
  return (
    <section aria-labelledby="chat-title" className="flex min-h-0 flex-1 flex-col">
      <TopBar>
        {leading}
        <h2 id="chat-title" className="truncate text-ui font-medium text-fg">
          {title === '' ? t('title.untitled') : title}
        </h2>
        {view?.agentsMd && (
          <span
            title={t('chat.agentsMd.loaded', { lines: view.agentsMd.lines })}
            aria-label={t('chat.agentsMd.loaded', { lines: view.agentsMd.lines })}
            className="shrink-0 rounded-[5px] bg-sunk px-1.5 py-0.5 text-[11px] text-muted"
          >
            {t('chat.agentsMd.mark')}
          </span>
        )}
        <div className="no-drag ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {project && (
            <>
              <span title={path} className="max-w-[200px] truncate text-note text-muted">
                {project}
              </span>
              <span aria-hidden className="h-3.5 w-px shrink-0 bg-hair2" />
            </>
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
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div
              ref={content}
              className="mx-auto flex w-full max-w-[clamp(560px,78%,960px)] flex-col gap-3.5 px-7 pt-6 pb-8 text-body"
            >
              <MessageStream
                view={view}
                locatedTurnId={locatedTurnId}
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
          <div className="mx-auto w-full max-w-[clamp(580px,82%,980px)] px-7 pb-3">
            <Composer
              key={sessionId}
              sessionId={sessionId}
              status={status}
              run={run}
              agent={run?.agent}
              model={view?.info?.model ?? summary?.model ?? defaultModel}
              contextTokens={view?.contextTokens}
              onInspect={() => {
                setPanel('inspector')
                setPanelPreference(true)
              }}
            />
          </div>
        </div>
        <SessionSidePanel
          sessionId={sessionId}
          view={view}
          panel={panel}
          selectedPlanId={selectedPlanId}
          selectedChangeSetId={selectedChangeSetId}
          onSelectChangeSet={setSelectedChangeSetId}
          onPanelChange={setPanel}
          open={panelOpen}
          onClose={() => setPanelPreference(false)}
          onLocateTurn={locateTurn}
        />
      </div>
    </section>
  )
}
