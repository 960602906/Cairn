/**
 * 运行检查器（M4-05，管理界面 §8.2；ADR-0033）。
 *
 * 数据按需从 `run.inspect` 读取：打开面板或切换到子运行时才请求，不在事件流里维护第二份运行树。
 * 四个标签分别是时间线、上下文快照、按 Agent 分组的用量与运行设置。检查器只读。
 */
import { Activity, ChevronRight, Clock, Layers, RotateCw, Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { estimateTokens, type DelegationView } from '@cairn/core'
import { translateError, type TFunction } from '@cairn/i18n'
import type {
  AgentDefinitionRef,
  RunInspectResult,
  RunLimits,
  RunSnapshot,
  RunTree,
  RunTreeNode,
  RunUsage,
} from '@cairn/protocol'
import { agentName } from './agents/AgentsPage.js'
import { formatCompactTokens as compactTokens, formatDuration } from './format.js'
import { inspectionKey } from './session-store.js'
import { useSessionStore as useStore } from './store-context.js'
import { cn, IconButton } from './ui/index.js'

export type InspectorTab = 'timeline' | 'context' | 'usage' | 'settings'

const TABS = [
  { id: 'timeline', label: 'inspector.tab.timeline', Icon: Clock },
  { id: 'context', label: 'inspector.tab.context', Icon: Layers },
  { id: 'usage', label: 'inspector.tab.usage', Icon: Activity },
  { id: 'settings', label: 'inspector.tab.settings', Icon: Settings2 },
] as const

const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 0,
  toolCalls: 0,
  durationMs: 0,
}

function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens === undefined && b.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }),
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    durationMs: a.durationMs + b.durationMs,
  }
}

/** 一个运行自己的用量；不含子运行，避免按 Agent 分组时重复计算。 */
export function directUsage(node: RunTreeNode): RunUsage {
  return node.turns.reduce((sum, turn) => addUsage(sum, turn.usage), { ...EMPTY_USAGE })
}

function SnapshotBar({ snapshot }: { readonly snapshot: RunSnapshot }) {
  const { t, i18n } = useTranslation('session')
  const system = snapshot.systemPrompt.reduce((sum, section) => sum + section.tokens, 0)
  const skills = snapshot.skills.reduce((sum, skill) => sum + skill.tokens, 0)
  const tools = snapshot.tools.reduce((sum, tool) => sum + tool.tokens, 0)
  const history = snapshot.history.tokens
  const compaction = snapshot.compaction ? estimateTokens(snapshot.compaction.summary) : 0
  const parts = [
    { key: 'system', label: t('inspector.context.system'), tokens: system, tone: 'bg-accent' },
    { key: 'skills', label: t('inspector.context.skills'), tokens: skills, tone: 'bg-ok' },
    { key: 'tools', label: t('inspector.context.tools'), tokens: tools, tone: 'bg-warn' },
    { key: 'history', label: t('inspector.context.history'), tokens: history, tone: 'bg-muted' },
    ...(compaction > 0
      ? [
          {
            key: 'compaction',
            label: t('inspector.context.compaction'),
            tokens: compaction,
            tone: 'bg-danger',
          },
        ]
      : []),
  ]
  const sum = parts.reduce((total, part) => total + part.tokens, 0)
  const total = Math.max(snapshot.tokens, sum, 1)
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={t('inspector.context.bar', {
          total: total.toLocaleString(i18n.language),
        })}
        className="flex h-2 overflow-hidden rounded-full bg-sunk2"
      >
        {parts.map((part) =>
          part.tokens === 0 ? null : (
            <span
              key={part.key}
              className={part.tone}
              style={{ width: `${(part.tokens / total) * 100}%` }}
            />
          ),
        )}
      </div>
      <ul aria-label={t('inspector.context.breakdown')} className="flex flex-col gap-1">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center gap-2 text-note">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', part.tone)} />
            <span className="min-w-0 flex-1 text-fg2">{part.label}</span>
            <span className="tabular text-muted">
              {compactTokens(part.tokens)} · {Math.round((part.tokens / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ContextTab({ snapshots }: { readonly snapshots: readonly RunSnapshot[] }) {
  const { t, i18n } = useTranslation('session')
  const snapshot = snapshots.reduce<RunSnapshot | undefined>(
    (latest, item) => (latest === undefined || item.createdAt > latest.createdAt ? item : latest),
    undefined,
  )
  if (!snapshot) {
    return (
      <div className="flex flex-col gap-1 p-3 text-ui text-muted">
        <p>{t('inspector.context.empty')}</p>
        <p className="text-note text-faint">{t('inspector.context.emptyHint')}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4 p-3 text-ui">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-note text-muted">
        <span>{snapshot.agent.id}</span>
        <span aria-hidden>·</span>
        <span>
          {snapshot.model.providerId} · {snapshot.model.modelId}
        </span>
        <span aria-hidden>·</span>
        <time dateTime={new Date(snapshot.createdAt).toISOString()}>
          {new Date(snapshot.createdAt).toLocaleString(i18n.language)}
        </time>
      </div>
      <SnapshotBar snapshot={snapshot} />

      <section className="flex flex-col gap-2">
        <h4 className="text-note font-medium text-fg2">{t('inspector.context.systemPrompt')}</h4>
        {snapshot.systemPrompt.length === 0 ? (
          <p className="text-note text-faint">{t('inspector.context.none')}</p>
        ) : (
          snapshot.systemPrompt.map((section, index) => (
            <details key={`${section.title}-${index}`} className="group rounded-item bg-sunk">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-note text-fg2 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                <span className="tabular shrink-0 text-muted">{compactTokens(section.tokens)}</span>
              </summary>
              <pre className="max-h-56 overflow-auto border-t-[0.5px] border-hair px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-fg2">
                {section.text}
              </pre>
            </details>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-note font-medium text-fg2">{t('inspector.context.skills')}</h4>
        {snapshot.skills.length === 0 ? (
          <p className="text-note text-faint">{t('inspector.context.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snapshot.skills.map((skill) => (
              <li key={skill.name} className="rounded-item bg-sunk px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    {skill.name}
                  </span>
                  {skill.pinned && (
                    <span className="rounded-[5px] bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                      {t('inspector.context.pinned')}
                    </span>
                  )}
                  <span className="tabular text-note text-muted">
                    {compactTokens(skill.tokens)}
                  </span>
                </div>
                <p className="mt-1 text-note text-muted">{skill.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-note font-medium text-fg2">{t('inspector.context.tools')}</h4>
        {snapshot.tools.length === 0 ? (
          <p className="text-note text-faint">{t('inspector.context.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {snapshot.tools.map((tool) => (
              <li
                key={tool.name}
                className="flex items-start gap-2 rounded-item bg-sunk px-2.5 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[12.5px]">{tool.name}</span>
                  <span className="mt-0.5 block text-note text-muted">{tool.description}</span>
                </span>
                <span className="tabular shrink-0 text-note text-muted">
                  {compactTokens(tool.tokens)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-note font-medium text-fg2">
          {t('inspector.context.historyCount', { count: snapshot.history.messages })}
        </h4>
        {snapshot.history.preview.length === 0 ? (
          <p className="text-note text-faint">{t('inspector.context.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snapshot.history.preview.map((message, index) => (
              <li key={`${message.ts}-${index}`} className="rounded-item bg-sunk px-2.5 py-2">
                <div className="mb-1 flex items-center gap-2 text-note text-muted">
                  <span>{message.role}</span>
                  <span className="tabular ml-auto">{compactTokens(message.tokens)}</span>
                </div>
                <p className="line-clamp-3 text-note whitespace-pre-wrap text-fg2">
                  {message.text}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {snapshot.compaction && (
        <section className="flex flex-col gap-2">
          <h4 className="text-note font-medium text-fg2">{t('inspector.context.compaction')}</h4>
          <p className="rounded-item bg-sunk px-2.5 py-2 text-note whitespace-pre-wrap text-fg2">
            {snapshot.compaction.summary}
          </p>
        </section>
      )}
    </div>
  )
}

function UsageLine({ usage }: { readonly usage: RunUsage }) {
  const { t, i18n } = useTranslation('session')
  const tokens = usage.inputTokens + usage.outputTokens
  return (
    <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-note text-muted">
      <span>{t('inspector.usage.tokens', { count: tokens.toLocaleString(i18n.language) })}</span>
      <span>{t('inspector.usage.calls', { count: usage.modelCalls })}</span>
      <span>{t('inspector.usage.tools', { count: usage.toolCalls })}</span>
      <span>{formatDuration(usage.durationMs)}</span>
    </div>
  )
}

function UsageTab({
  tree,
  selected,
}: {
  readonly tree: RunTree
  readonly selected: RunTreeNode | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const agents = useStore((state) => state.agents) ?? []
  const groups = new Map<string, { agent: AgentDefinitionRef; usage: RunUsage; runs: number }>()
  let total = { ...EMPTY_USAGE }
  for (const node of tree.runs) {
    const usage = directUsage(node)
    total = addUsage(total, usage)
    const key = `${node.agent.id}@${node.agent.version}`
    const group = groups.get(key) ?? { agent: node.agent, usage: { ...EMPTY_USAGE }, runs: 0 }
    groups.set(key, { ...group, usage: addUsage(group.usage, usage), runs: group.runs + 1 })
  }
  return (
    <div className="flex flex-col gap-4 p-3 text-ui">
      <section className="rounded-card bg-sunk px-3 py-2.5">
        <h4 className="text-note font-medium text-fg2">
          {selected ? t('inspector.usage.run') : t('inspector.usage.session')}
        </h4>
        <UsageLine usage={selected ? directUsage(selected) : total} />
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="text-note font-medium text-fg2">{t('inspector.usage.byAgent')}</h4>
        {groups.size === 0 ? (
          <p className="text-note text-faint">{t('inspector.usage.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {[...groups.entries()].map(([key, group]) => {
              const summary = agents.find((agent) => agent.agentId === group.agent.id)
              const name = summary
                ? agentName(summary, i18n.language)
                : group.agent.id === 'builtin.coder'
                  ? t('composer.agent.default')
                  : group.agent.id
              return (
                <li key={key} className="rounded-item bg-sunk px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-fg2">{name}</span>
                    <span className="text-note text-muted">
                      {t('inspector.versionShort', { version: group.agent.version })} ·{' '}
                      {t('inspector.usage.runCount', { count: group.runs })}
                    </span>
                  </div>
                  <UsageLine usage={group.usage} />
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function limitValue(
  t: TFunction,
  limits: RunLimits,
): readonly { key: keyof RunLimits; label: string; value: string }[] {
  return [
    {
      key: 'maxStepsPerTurn',
      label: t('inspector.settings.maxSteps'),
      value: limits.maxStepsPerTurn?.toString() ?? t('inspector.settings.unlimited'),
    },
    {
      key: 'maxTurnDurationMs',
      label: t('inspector.settings.maxDuration'),
      value:
        limits.maxTurnDurationMs === undefined
          ? t('inspector.settings.unlimited')
          : formatDuration(limits.maxTurnDurationMs),
    },
    {
      key: 'maxTokensPerTurn',
      label: t('inspector.settings.maxTokens'),
      value: limits.maxTokensPerTurn?.toLocaleString() ?? t('inspector.settings.unlimited'),
    },
    {
      key: 'maxCostPerTurn',
      label: t('inspector.settings.maxCost'),
      value: limits.maxCostPerTurn?.toString() ?? t('inspector.settings.unlimited'),
    },
    {
      key: 'maxConsecutiveToolErrors',
      label: t('inspector.settings.maxToolErrors'),
      value: limits.maxConsecutiveToolErrors?.toString() ?? t('inspector.settings.unlimited'),
    },
  ]
}

function SettingsTab({
  result,
  selected,
}: {
  readonly result: RunInspectResult
  readonly selected: RunTreeNode | undefined
}) {
  const { t } = useTranslation('session')
  if (!selected) return <p className="p-3 text-ui text-muted">{t('inspector.empty')}</p>
  return (
    <div className="flex flex-col gap-4 p-3 text-ui">
      <section className="flex flex-col gap-1.5">
        <h4 className="text-note font-medium text-fg2">{t('inspector.settings.agent')}</h4>
        <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 text-note">
          <dt className="text-muted">{t('inspector.settings.agentId')}</dt>
          <dd className="break-all font-mono">{selected.agent.id}</dd>
          <dt className="text-muted">{t('inspector.settings.version')}</dt>
          <dd>{t('inspector.versionShort', { version: selected.agent.version })}</dd>
          <dt className="text-muted">{t('inspector.settings.model')}</dt>
          <dd className="break-all font-mono text-[12.5px]">
            {selected.model.providerId} · {selected.model.modelId}
          </dd>
          <dt className="text-muted">{t('inspector.settings.mode')}</dt>
          <dd>{t(`inspector.mode.${selected.mode}`)}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-1.5">
        <h4 className="text-note font-medium text-fg2">{t('inspector.settings.paths')}</h4>
        <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 text-note">
          <dt className="text-muted">{t('inspector.settings.project')}</dt>
          <dd className="break-all font-mono text-[12.5px]">{result.settings.projectPath}</dd>
          <dt className="text-muted">{t('inspector.settings.workspace')}</dt>
          <dd className="break-all font-mono text-[12.5px]">{result.settings.workspacePath}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-1.5">
        <h4 className="text-note font-medium text-fg2">{t('inspector.settings.limits')}</h4>
        <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-note">
          {limitValue(t, selected.limits).map((limit) => (
            <div key={limit.key} className="contents">
              <dt className="text-muted">{limit.label}</dt>
              <dd className="tabular text-right">{limit.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-1.5">
        <h4 className="text-note font-medium text-fg2">{t('inspector.settings.permissions')}</h4>
        {result.settings.permissionRules.length === 0 ? (
          <p className="text-note text-faint">{t('inspector.settings.noPermissions')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {result.settings.permissionRules.map((rule) => {
              const match = Object.entries(rule.match).flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : [`${key}: ${Array.isArray(value) ? value.join(', ') : value}`],
              )
              return (
                <li key={rule.id} className="rounded-item bg-sunk px-2.5 py-2 text-note">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-[5px] px-1.5 py-0.5 text-[11px]',
                        rule.effect === 'allow'
                          ? 'bg-ok-soft text-ok'
                          : rule.effect === 'deny'
                            ? 'bg-danger-soft text-danger'
                            : 'bg-warn-soft text-warn',
                      )}
                    >
                      {t(`inspector.effect.${rule.effect}`)}
                    </span>
                    <span className="ml-auto text-muted">{rule.scope}</span>
                  </div>
                  <p className="mt-1 break-words font-mono text-[12px] text-fg2">
                    {match.length === 0 ? t('inspector.settings.allCalls') : match.join(' · ')}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function RunNodeView({
  node,
  rootRunId,
  childrenMap,
  delegations,
  onLocate,
  onSelectRun,
}: {
  readonly node: RunTreeNode
  readonly rootRunId: string
  readonly childrenMap: ReadonlyMap<string, readonly RunTreeNode[]>
  readonly delegations: ReadonlyMap<string, DelegationView>
  readonly onLocate: ((runId: string, turnId: string) => void) | undefined
  readonly onSelectRun: ((runId: string) => void) | undefined
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
  const children = childrenMap.get(node.runId) ?? []
  return (
    <li className="list-none">
      <div className="rounded-item bg-sunk px-2 py-1.5">
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
              {t('inspector.versionShort', { version: node.agent.version })}
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
        </div>
        {delegation && (
          <p className="mt-1 line-clamp-2 pl-[22px] text-note text-muted">{delegation.task}</p>
        )}
        {expanded && (
          <div className="mt-2 flex flex-col gap-1.5 pl-3">
            {node.turns.length === 0 ? (
              <p className="text-note text-faint">{t('inspector.timeline.noTurns')}</p>
            ) : (
              node.turns.map((turn, index) => {
                const open = openTurn === turn.turnId
                return (
                  <div key={turn.turnId} className="rounded-[6px] bg-paper/60 px-2 py-1.5">
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
                      <div className="mt-1.5 flex flex-col gap-1.5 pl-4">
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
}: {
  readonly tree: RunTree
  readonly delegations?: readonly DelegationView[]
  readonly onLocate?: ((runId: string, turnId: string) => void) | undefined
  readonly onSelectRun?: ((runId: string) => void) | undefined
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
      />
    </ul>
  )
}

export function Inspector({
  sessionId,
  delegations = [],
  onLocate,
}: {
  readonly sessionId: string
  readonly delegations?: readonly DelegationView[]
  readonly onLocate?: ((runId: string, turnId: string) => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const [tab, setTab] = useState<InspectorTab>('timeline')
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const key = inspectionKey(sessionId, selectedRunId)
  const entry = useStore((state) => state.inspections[key])
  const inspectRun = useStore((state) => state.inspectRun)

  useEffect(() => {
    setSelectedRunId(undefined)
    setTab('timeline')
  }, [sessionId])

  useEffect(() => {
    void inspectRun(sessionId)
  }, [inspectRun, sessionId])

  useEffect(() => {
    if (selectedRunId !== undefined) void inspectRun(sessionId, selectedRunId)
  }, [inspectRun, selectedRunId, sessionId])

  const result = entry?.result
  const root =
    result === undefined
      ? undefined
      : (result.tree.runs.find((run) => run.runId === result.tree.rootRunId) ?? result.tree.runs[0])
  const selected =
    selectedRunId === undefined || result === undefined
      ? undefined
      : result.tree.runs.find((run) => run.runId === selectedRunId)
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b-[0.5px] border-hair px-2">
        {selectedRunId !== undefined && (
          <button
            type="button"
            onClick={() => setSelectedRunId(undefined)}
            className="mr-1 shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] text-accent outline-none hover:bg-accent-soft focus-visible:ring-1 focus-visible:ring-accent"
          >
            {t('inspector.back')}
          </button>
        )}
        <div
          role="tablist"
          aria-label={t('inspector.tabs')}
          className="flex min-w-0 flex-1 gap-0.5"
        >
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-[6px] px-1 text-[11.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent',
                tab === id
                  ? 'bg-sunk2 font-medium text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg2',
              )}
            >
              <Icon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        aria-label={t(TABS.find((item) => item.id === tab)?.label ?? 'inspector.tab.timeline')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {entry?.error ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-3 text-ui">
            <p className="text-danger">{translateError(i18n, entry.error)}</p>
            <button
              type="button"
              onClick={() => void inspectRun(sessionId, selectedRunId)}
              className="flex h-7 items-center gap-1.5 rounded-item bg-sunk px-2 text-note text-fg2 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
            >
              <RotateCw aria-hidden className="size-3.5" />
              {t('inspector.retry')}
            </button>
          </div>
        ) : entry === undefined || entry.loading ? (
          <p role="status" className="p-3 text-ui text-muted">
            {t('inspector.loading')}
          </p>
        ) : result === undefined || result.tree.runs.length === 0 ? (
          <div className="flex flex-col gap-1 p-3 text-ui text-muted">
            <p>{t('inspector.empty')}</p>
            <p className="text-note text-faint">{t('inspector.emptyHint')}</p>
          </div>
        ) : tab === 'timeline' ? (
          <div className="p-3">
            <RunTimeline
              tree={result.tree}
              delegations={delegations}
              onLocate={selectedRunId === undefined ? onLocate : undefined}
              onSelectRun={(runId) => setSelectedRunId(runId)}
            />
          </div>
        ) : tab === 'context' ? (
          <ContextTab snapshots={result.snapshots} />
        ) : tab === 'usage' ? (
          <UsageTab tree={result.tree} selected={selected} />
        ) : (
          <SettingsTab result={result} selected={selected ?? root} />
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {entry?.loading
          ? t('inspector.loading')
          : entry?.error
            ? translateError(i18n, entry.error)
            : result
              ? t('inspector.loaded', { count: result.tree.runs.length })
              : ''}
      </p>
    </div>
  )
}
