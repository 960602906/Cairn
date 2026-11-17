/**
 * 子 Agent 详情面板（右侧工作台）：委派卡片点开后查看这个子运行。
 *
 * - 头部显示 Agent、版本、状态、任务、用量与完成摘要；
 * - 写入类子运行完成后给出改动集入口，跳到「改动」面板审阅；
 * - 过程树按需读取 `run.inspect`（快照，运行中可手动刷新），可以切换到它委派的下一级子运行。
 *
 * 子运行的审批不在这里：按约定留在对话区的委派卡片里，避免同时出现两个审批面。
 */
import { FileDiff, GitBranch, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationView } from '@cairn/core'
import { DelegationStatusBadge, useDelegationName } from './DelegationCard.js'
import { formatCompactTokens as compactTokens } from './format.js'
import { RunTimeline } from './RunTimeline.js'
import type { SessionPanelContext } from './SessionPanels.js'
import { inspectionKey } from './session-store.js'
import { useSessionStore } from './store-context.js'
import { Button, PanelEmpty, Spinner } from './ui/index.js'

function DelegationHeader({
  delegation,
  onOpenChanges,
}: {
  readonly delegation: DelegationView
  readonly onOpenChanges: (changeSetId: string) => void
}) {
  const { t } = useTranslation('session')
  const name = useDelegationName(delegation)
  const status = delegation.completed?.status ?? 'running'
  const usage = delegation.completed?.usage
  const tokens = usage ? usage.inputTokens + usage.outputTokens : 0
  const changeSetId = delegation.completed?.changeSetId
  return (
    <div className="flex flex-col gap-2 border-b-[0.5px] border-hair px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted" />
        <h3 className="min-w-0 flex-1 truncate text-ui font-medium text-fg">{name}</h3>
        <DelegationStatusBadge status={status} />
      </div>
      <p className="text-note text-muted">
        {t('inspector.versionShort', { version: delegation.agent.version })}
        {tokens > 0 && (
          <span className="tabular">
            {' '}
            · {t('delegation.tokens', { count: compactTokens(tokens) })}
          </span>
        )}
      </p>
      <p className="text-note text-fg2">{delegation.task}</p>
      {delegation.completed?.summary && (
        <p className="rounded-item bg-sunk px-2.5 py-2 text-note whitespace-pre-wrap text-fg2">
          {delegation.completed.summary}
        </p>
      )}
      {delegation.completed?.issues && delegation.completed.issues.length > 0 && (
        <ul className="flex flex-col gap-1 text-note text-warn">
          {delegation.completed.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {changeSetId !== undefined && (
        <button
          type="button"
          onClick={() => onOpenChanges(changeSetId)}
          className="flex h-7 w-fit items-center gap-1.5 rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
        >
          <FileDiff aria-hidden className="size-3.5" />
          {t('delegation.openChangeSet')}
        </button>
      )}
    </div>
  )
}

export function DelegationPanel({
  sessionId,
  view,
  selectedRunId,
  onOpenPanel,
}: SessionPanelContext) {
  const { t } = useTranslation('session')
  const inspectRun = useSessionStore((state) => state.inspectRun)
  const delegation = view?.delegations.find((item) => item.childRunId === selectedRunId)
  const entry = useSessionStore((state) =>
    selectedRunId === undefined
      ? undefined
      : state.inspections[inspectionKey(sessionId, selectedRunId)],
  )
  // `run.inspect` 是快照：换子运行或打开面板时读一次，运行中由刷新按钮再读；失败不自动重试。
  useEffect(() => {
    if (selectedRunId === undefined) return
    if (entry !== undefined && (entry.result !== undefined || entry.loading || entry.error)) return
    void inspectRun(sessionId, selectedRunId)
  }, [entry, inspectRun, sessionId, selectedRunId])

  if (delegation === undefined) {
    return <PanelEmpty icon={<GitBranch />}>{t('sidePanel.emptyDelegation')}</PanelEmpty>
  }
  const known = new Set((view?.delegations ?? []).map((item) => item.childRunId))
  return (
    <section aria-label={t('sidePanel.delegation')} className="flex h-full min-h-0 flex-col">
      <DelegationHeader
        delegation={delegation}
        onOpenChanges={(changeSetId) => onOpenPanel('diff', { changeSetId })}
      />
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-note">
        <h4 className="font-normal text-muted">{t('inspector.timeline.tree')}</h4>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={entry?.loading === true}
          onClick={() => void inspectRun(sessionId, delegation.childRunId)}
        >
          <RefreshCw aria-hidden />
          {t('delegation.refresh')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {entry?.error && (
          <div role="alert" className="flex flex-col items-start gap-2 pb-2 text-ui">
            <p className="text-danger">{t('delegation.loadFailed')}</p>
            <Button size="sm" onClick={() => void inspectRun(sessionId, delegation.childRunId)}>
              {t('delegation.retry')}
            </Button>
          </div>
        )}
        {entry?.result ? (
          <RunTimeline
            tree={entry.result.tree}
            delegations={view?.delegations ?? []}
            onOpenChanges={(changeSetId) => onOpenPanel('diff', { changeSetId })}
            onSelectRun={(runId) => {
              if (known.has(runId)) onOpenPanel('delegation', { runId })
            }}
          />
        ) : entry === undefined || entry.loading ? (
          <p role="status" className="flex items-center gap-2 text-note text-muted">
            <Spinner className="size-3.5" />
            {t('inspector.loading')}
          </p>
        ) : entry.error ? null : (
          <p className="text-note text-faint">{t('inspector.empty')}</p>
        )}
      </div>
    </section>
  )
}
