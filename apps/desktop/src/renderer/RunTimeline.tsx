/**
 * 只读运行树（M4-05）：委派卡片展开时显示子运行的轮次、步骤与工具调用。
 *
 * 原本是右侧检查器的「时间线」标签；检查器移除后只保留这棵可复用的树。
 */
import { Activity, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationView } from '@cairn/core'
import { isAgentDraftRef, type RunTree, type RunTreeNode } from '@cairn/protocol'
import { agentName } from './agents/model.js'
import { formatCompactTokens as compactTokens, formatDuration } from './format.js'
import { useSessionStore as useStore } from './store-context.js'
import { cn, IconButton } from './ui/index.js'

function RunNodeView({
  node,
  rootRunId,
  childrenMap,
  delegations,
  onLocate,
  onSelectRun,
  onOpenChanges,
}: {
  readonly node: RunTreeNode
  readonly rootRunId: string
  readonly childrenMap: ReadonlyMap<string, readonly RunTreeNode[]>
  readonly delegations: ReadonlyMap<string, DelegationView>
  readonly onLocate: ((runId: string, turnId: string) => void) | undefined
  readonly onSelectRun: ((runId: string) => void) | undefined
  readonly onOpenChanges: ((changeSetId: string) => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const agents = useStore((state) => state.agents) ?? []
  const [expanded, setExpanded] = useState(node.runId === rootRunId)
  const [openTurn, setOpenTurn] = useState<string | undefined>()
  const summary = agents.find((agent) => agent.agentId === node.agent.id)
  const name = summary
    ? agentName(summary, i18n.language)
    : node.agent.id === 'builtin.coder'
      ? t('composer.agent.default')
      : node.agent.id
  const delegation = delegations.get(node.runId)
  const changeSetId = delegation?.completed?.changeSetId
  const children = childrenMap.get(node.runId) ?? []
  return (
    <li className="list-none">
      <div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'inspector.timeline.collapse' : 'inspector.timeline.expand', {
              name,
            })}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[5px] px-0.5 py-0.5 text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3.5 shrink-0 text-faint', expanded && 'rotate-90')}
            />
            <span className="min-w-0 flex-1 truncate text-note font-medium text-fg2">{name}</span>
            <span className="shrink-0 text-[11px] text-muted">
              {isAgentDraftRef(node.agent)
                ? t('inspector.draftShort')
                : t('inspector.versionShort', { version: node.agent.version })}
            </span>
            <span
              className={cn(
                'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]',
                node.state === 'failed'
                  ? 'bg-danger-soft text-danger'
                  : node.state === 'awaiting_approval'
                    ? 'bg-warn-soft text-warn'
                    : 'bg-sunk2 text-muted',
              )}
            >
              {t(`inspector.state.${node.state}`)}
            </span>
          </button>
          {onSelectRun && node.runId !== rootRunId && (
            <button
              type="button"
              onClick={() => onSelectRun(node.runId)}
              className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] text-accent outline-none hover:bg-accent-soft focus-visible:ring-1 focus-visible:ring-accent"
            >
              {t('inspector.timeline.openRun')}
            </button>
          )}
          {onOpenChanges && changeSetId !== undefined && (
            <button
              type="button"
              onClick={() => onOpenChanges(changeSetId)}
              className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] text-accent outline-none hover:bg-accent-soft focus-visible:ring-1 focus-visible:ring-accent"
            >
              {t('inspector.timeline.openChanges')}
            </button>
          )}
        </div>
        {delegation && (
          <p className="mt-1 line-clamp-2 pl-[22px] text-note text-muted">{delegation.task}</p>
        )}
        {expanded && (
          <div className="mt-1 ml-[9px] flex flex-col gap-0.5 border-l-[0.5px] border-hair2 pl-2">
            {node.turns.length === 0 ? (
              <p className="text-note text-faint">{t('inspector.timeline.noTurns')}</p>
            ) : (
              node.turns.map((turn, index) => {
                const open = openTurn === turn.turnId
                return (
                  <div key={turn.turnId}>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenTurn(open ? undefined : turn.turnId)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[5px] px-0.5 py-0.5 text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn('size-3 shrink-0 text-faint', open && 'rotate-90')}
                        />
                        <span className="min-w-0 flex-1 truncate text-note text-fg2">
                          {t('inspector.timeline.turn', { number: index + 1 })}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted">
                          {t(`inspector.turn.${turn.status}`)}
                        </span>
                        <span className="tabular shrink-0 text-[11px] text-muted">
                          {compactTokens(turn.usage.inputTokens + turn.usage.outputTokens)}
                        </span>
                      </button>
                      {onLocate && node.runId === rootRunId && (
                        <IconButton
                          label={t('inspector.timeline.locate', { number: index + 1 })}
                          size="icon-sm"
                          onClick={() => onLocate(node.runId, turn.turnId)}
                        >
                          <Activity />
                        </IconButton>
                      )}
                    </div>
                    {open && (
                      <div className="mt-1 mb-2 flex flex-col gap-2 pl-5">
                        {turn.steps.length === 0 ? (
                          <p className="text-note text-faint">{t('inspector.timeline.noSteps')}</p>
                        ) : (
                          turn.steps.map((step, stepIndex) => (
                            <div
                              key={step.stepId}
                              className="rounded-[5px] border-l-2 border-hair2 pl-2 text-note"
                            >
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-fg2">
                                  {t('inspector.timeline.step', { number: stepIndex + 1 })}
                                </span>
                                <span className="shrink-0 text-[11px] text-muted">
                                  {step.finishReason ?? t('inspector.timeline.running')}
                                </span>
                                <span className="tabular shrink-0 text-[11px] text-muted">
                                  {compactTokens(step.usage.inputTokens + step.usage.outputTokens)}
                                </span>
                              </div>
                              <p className="truncate font-mono text-[11px] text-faint">
                                {step.model.providerId} · {step.model.modelId}
                              </p>
                              {step.toolCalls.length > 0 && (
                                <ul className="mt-1 flex flex-col gap-0.5">
                                  {step.toolCalls.map((tool) => (
                                    <li
                                      key={tool.toolCallId}
                                      className="flex items-center gap-2 text-[11px]"
                                    >
                                      <span className="min-w-0 flex-1 truncate font-mono text-fg2">
                                        {tool.name}
                                      </span>
                                      <span className="shrink-0 text-muted">
                                        {t(`tool.status.${tool.status}`)}
                                      </span>
                                      {tool.durationMs !== undefined && (
                                        <span className="tabular shrink-0 text-muted">
                                          {formatDuration(tool.durationMs)}
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
            {children.length > 0 && (
              <ul aria-label={t('inspector.timeline.children')} className="flex flex-col gap-1.5">
                {children.map((child) => (
                  <RunNodeView
                    key={child.runId}
                    node={child}
                    rootRunId={rootRunId}
                    childrenMap={childrenMap}
                    delegations={delegations}
                    onLocate={onLocate}
                    onSelectRun={onSelectRun}
                    onOpenChanges={onOpenChanges}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** 时间线只渲染一棵树；子运行按钮交给调用方切换 `run.inspect` 的根。 */
export function RunTimeline({
  tree,
  delegations = [],
  onLocate,
  onSelectRun,
  onOpenChanges,
}: {
  readonly tree: RunTree
  readonly delegations?: readonly DelegationView[]
  readonly onLocate?: ((runId: string, turnId: string) => void) | undefined
  readonly onSelectRun?: ((runId: string) => void) | undefined
  readonly onOpenChanges?: ((changeSetId: string) => void) | undefined
}) {
  const { t } = useTranslation('session')
  const byId = new Map(tree.runs.map((run) => [run.runId, run]))
  const children = new Map<string, RunTreeNode[]>()
  for (const run of tree.runs) {
    if (run.parentRunId === undefined) continue
    const list = children.get(run.parentRunId) ?? []
    list.push(run)
    children.set(run.parentRunId, list)
  }
  const root = byId.get(tree.rootRunId) ?? tree.runs[0]
  if (!root) return <p className="p-3 text-ui text-muted">{t('inspector.empty')}</p>
  const delegationMap = new Map(delegations.map((item) => [item.childRunId, item]))
  return (
    <ul aria-label={t('inspector.timeline.tree')} className="flex flex-col gap-2">
      <RunNodeView
        node={root}
        rootRunId={root.runId}
        childrenMap={children}
        delegations={delegationMap}
        onLocate={onLocate}
        onSelectRun={onSelectRun}
        onOpenChanges={onOpenChanges}
      />
    </ul>
  )
}
