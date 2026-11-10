/**
 * 当前会话（01 枢纽）：48px 顶栏 + 对话列 + 右侧常驻工作台。
 *
 * 宽屏（≥1280px）工作台占布局宽度；更窄时改为右侧浮层，由顶栏按钮开合，避免把正文挤到
 * 500px 以下。正文最大 840px，输入框最大 880px。会话切换、订阅恢复、审批与检查器行为沿用
 * 原有 store 投影（M0-15c、M1-11b、M2-04、M2-07、M2-08）。
 */
import { PanelRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { rootRun, sessionStatus } from '@cairn/core'
import { isAgentDraftRef } from '@cairn/protocol'
import { ApprovalList } from './ApprovalCard.js'
import { TurnRail } from './Checkpoints.js'
import { Composer } from './Composer.js'
import { MessageStream } from './MessageStream.js'
import { projectNameForPath } from './project-name.js'
import { SessionSidePanel, type SessionPanel } from './SessionSidePanel.js'
import { useStickToBottom } from './stick-to-bottom.js'
import { useSessionStore } from './store-context.js'
import { useMediaQuery } from './layout/use-media-query.js'
import { TITLE_BAR_INSET } from './layout/WindowControls.js'
import { cn, IconButton } from './ui/index.js'

/** 纸面顶栏（48px）：左侧是项目 / 会话面包屑，右侧是模型与工作台开关。 */
export function TopBar({ children }: { readonly children?: ReactNode }) {
  return (
    <header
      className="drag relative flex h-12 shrink-0 items-center gap-1.5 bg-chrome pr-3 pl-5"
      style={TITLE_BAR_INSET}
    >
      {children}
      {/* 线条放在顶栏之外，避免被窗口按钮或拖拽区裁切。 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full block h-[0.5px] bg-hair"
      />
    </header>
  )
}

export function ChatPanel({
  initialChangeSetId,
  initialChangeSetSessionId,
  onInitialChangeSetOpened,
  notice,
}: {
  /** 从活动中心等入口打开会话时要直接显示的改动集。 */
  readonly initialChangeSetId?: string | undefined
  /** 请求打开改动集的会话；当前会话不同时不打开。 */
  readonly initialChangeSetSessionId?: string | undefined
  readonly onInitialChangeSetOpened?: (() => void) | undefined
  /** 会话标题栏下方的非模态提示（M5-07 的更新提示）。 */
  readonly notice?: ReactNode
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
  const [panel, setPanel] = useState<SessionPanel>('diff')
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>()
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | undefined>()
  const [locatedTurnId, setLocatedTurnId] = useState<string | undefined>()
  /** 宽屏工作台常驻；窄屏默认收起，按需浮出。 */
  const docked = useMediaQuery('(min-width: 1280px)')
  const [panelPreference, setPanelPreference] = useState<boolean>()
  const panelOpen = panelPreference ?? docked
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

  // 没有选中的会话时由 App 显示新对话页，这里不再渲染占位内容。
  if (sessionId === undefined) return null

  const title = view?.info?.title ?? summary?.title ?? ''
  const status = awaiting ? 'running' : view ? sessionStatus(view) : (summary?.status ?? 'idle')
  const run = view && rootRun(view)
  const path = view?.info?.projectPath ?? summary?.projectPath
  const project = projectNameForPath(path, projects, tc('project.defaultName'))
  const model = view?.info?.model ?? summary?.model ?? defaultModel
  return (
    <section aria-labelledby="chat-title" className="flex min-h-0 flex-1 flex-col bg-paper">
      {/* 读屏与端到端测试的运行状态；视觉上不占位，状态变化经 role=status 播报。 */}
      <span role="status" className="sr-only">
        {t(`status.${status}`)}
      </span>
      <TopBar>
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
            className="shrink-0 rounded-[5px] bg-sunk px-1.5 py-0.5 text-[10.5px] text-muted"
          >
            {t('chat.agentsMd.mark')}
          </span>
        )}
        <div className="no-drag ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
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
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div
              ref={content}
              className={cn(
                'mx-auto flex w-full max-w-[840px] flex-col gap-4 px-5 pt-6 pb-8 text-body min-[1200px]:px-8',
              )}
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
          <div className="mx-auto w-full max-w-[880px] px-5 pb-4 min-[1200px]:px-8">
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
          open={panelOpen}
          onClose={() => setPanelPreference(false)}
          onLocateTurn={locateTurn}
        />
      </div>
    </section>
  )
}
