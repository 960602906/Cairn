/**
 * 后台任务面板（右侧工作台）：当前会话里在后台进行或刚刚结束的工作。
 *
 * 数据分别来自 `view.delegations`（委派出去的子 Agent）、`autofix.jobs`（自动修复）和
 * `commands`（`start_command` 启动的后台命令）。运行中的在上面按启动时间排列，结束的按
 * 结束时间倒序；命令可以就地展开输出并停止。会话切换或关闭标签不影响任务本身。
 */
import { Activity, ChevronRight, GitBranch, Square, Terminal, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationView, SessionView } from '@cairn/core'
import type { AutoFixJob, BackgroundCommand, PullRequestWatch } from '@cairn/protocol'
import type { TFunction } from '@cairn/i18n'
import { agentName } from './agents/model.js'
import { lastSegment } from './paths.js'
import type { SessionPanelContext } from './SessionPanels.js'
import { useSessionStore } from './store-context.js'
import { cn, IconButton, PanelEmpty } from './ui/index.js'

const EMPTY_COMMANDS: readonly BackgroundCommand[] = []
const EMPTY_JOBS: readonly AutoFixJob[] = []
const EMPTY_WATCHES: readonly PullRequestWatch[] = []

type BackgroundTaskKind = 'delegation' | 'autofix' | 'command'

export interface BackgroundTask {
  readonly key: string
  readonly kind: BackgroundTaskKind
  readonly running: boolean
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  /** 已经结束的任务耗时；运行中的任务按当前时间计算。 */
  readonly durationMs: number | undefined
  readonly delegation: DelegationView | undefined
  readonly job: AutoFixJob | undefined
  readonly watch: PullRequestWatch | undefined
  readonly command: BackgroundCommand | undefined
}

/** 任务标题：子 Agent 用任务描述，自动修复用仓库与 PR 号，命令用命令行。 */
export function backgroundTaskTitle(task: BackgroundTask): string {
  if (task.delegation !== undefined) return task.delegation.task
  if (task.job !== undefined) {
    return task.watch === undefined ? task.job.watchId : `${task.watch.repo}#${task.watch.prNumber}`
  }
  return task.command?.command ?? ''
}

const jobRunning = (status: AutoFixJob['status']) =>
  status === 'queued' || status === 'running' || status === 'pushed'

const commandRunning = (status: BackgroundCommand['status']) =>
  status === 'running' || status === 'stopping'

/** 当前会话的后台任务，分成进行中与已结束两组。 */
export function useBackgroundTasks(
  view: SessionView | undefined,
  sessionId: string,
): { readonly running: readonly BackgroundTask[]; readonly finished: readonly BackgroundTask[] } {
  const commands = useSessionStore((state) => state.commands ?? EMPTY_COMMANDS)
  const jobs = useSessionStore((state) => state.autofix?.jobs ?? EMPTY_JOBS)
  const watches = useSessionStore((state) => state.autofix?.watches ?? EMPTY_WATCHES)
  return useMemo(() => {
    const items: BackgroundTask[] = []
    for (const delegation of view?.delegations ?? []) {
      items.push({
        key: `delegation:${delegation.childRunId}`,
        kind: 'delegation',
        running: delegation.completed === undefined,
        startedAt: delegation.createdAt,
        endedAt: undefined,
        // 子运行的完成事件不带结束时间，只有运行中能按当前时间算耗时。
        durationMs: undefined,
        delegation,
        job: undefined,
        watch: undefined,
        command: undefined,
      })
    }
    for (const job of jobs) {
      if (job.sessionId !== sessionId) continue
      const running = jobRunning(job.status)
      items.push({
        key: `autofix:${job.jobId}`,
        kind: 'autofix',
        running,
        startedAt: job.createdAt,
        endedAt: running ? undefined : job.updatedAt,
        durationMs: running ? undefined : Math.max(0, job.updatedAt - job.createdAt),
        delegation: undefined,
        job,
        watch: watches.find((item) => item.watchId === job.watchId),
        command: undefined,
      })
    }
    for (const command of commands) {
      if (command.sessionId !== sessionId) continue
      const running = commandRunning(command.status)
      items.push({
        key: `command:${command.commandId}`,
        kind: 'command',
        running,
        startedAt: command.startedAt,
        endedAt: command.endedAt,
        durationMs:
          command.endedAt === undefined
            ? undefined
            : Math.max(0, command.endedAt - command.startedAt),
        delegation: undefined,
        job: undefined,
        watch: undefined,
        command,
      })
    }
    const byStart = (a: BackgroundTask, b: BackgroundTask) =>
      (a.startedAt ?? 0) - (b.startedAt ?? 0)
    const byEnd = (a: BackgroundTask, b: BackgroundTask) =>
      (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0)
    return {
      running: items.filter((item) => item.running).sort(byStart),
      finished: items.filter((item) => !item.running).sort(byEnd),
    }
  }, [commands, jobs, sessionId, view, watches])
}

/** 运行中的任务每秒刷新一次耗时；没有运行中的任务时不建定时器。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function formatElapsed(ms: number, t: TFunction): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t('background.duration.seconds', { seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t('background.duration.minutes', { minutes, seconds: seconds % 60 })
  }
  return t('background.duration.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

function TaskDuration({ task, now }: { readonly task: BackgroundTask; readonly now: number }) {
  const { t } = useTranslation('session')
  const ms =
    task.durationMs ??
    (task.running && task.startedAt !== undefined ? now - task.startedAt : undefined)
  if (ms === undefined) return null
  return <span className="tabular shrink-0 text-note text-faint">{formatElapsed(ms, t)}</span>
}

function useTaskText(task: BackgroundTask): {
  readonly icon: ReactNode
  readonly title: string
  readonly meta: string
  readonly tone: string
  readonly ariaLabel: string
} {
  const { t, i18n } = useTranslation('session')
  const agents = useSessionStore((state) => state.agents) ?? []
  if (task.delegation !== undefined) {
    const delegation = task.delegation
    const agent = agents.find((item) => item.agentId === delegation.agent.id)
    const name = agent
      ? agentName(agent, i18n.language)
      : delegation.agent.id === 'builtin.coder'
        ? t('composer.agent.default')
        : delegation.agent.id
    const status = delegation.completed?.status ?? 'running'
    return {
      icon: <GitBranch aria-hidden className="size-3.5" />,
      title: backgroundTaskTitle(task),
      meta: `${name} · ${t(`delegation.status.${status}`)}`,
      tone: task.running ? 'text-accent' : 'text-muted',
      ariaLabel: t('background.delegationItem', { task: delegation.task }),
    }
  }
  if (task.job !== undefined) {
    const job = task.job
    const attempt =
      task.watch === undefined
        ? ''
        : ` · ${t('background.attempt', { attempt: job.attempt, max: task.watch.maxAttempts })}`
    return {
      icon: <Wrench aria-hidden className="size-3.5" />,
      title: backgroundTaskTitle(task),
      meta: `${t(`autofix.job.status.${job.status}`, { ns: 'settings' })}${attempt}`,
      tone: task.running ? 'text-accent' : 'text-muted',
      ariaLabel:
        task.watch === undefined
          ? t('background.autoFixFallback', { id: job.watchId })
          : t('background.autoFixItem', { repo: task.watch.repo, number: task.watch.prNumber }),
    }
  }
  const command = task.command!
  return {
    icon: <Terminal aria-hidden className="size-3.5" />,
    title: backgroundTaskTitle(task),
    meta: `${t(`activity.commandStatus.${command.status}`)} · ${lastSegment(command.cwd)}`,
    tone: task.running ? 'text-accent' : 'text-muted',
    ariaLabel: t('activity.commandItem', { command: command.command }),
  }
}

function TaskHeader({ task, now }: { readonly task: BackgroundTask; readonly now: number }) {
  const { icon, title, meta, tone } = useTaskText(task)
  return (
    <>
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-note font-medium text-fg2">{title}</span>
          <TaskDuration task={task} now={now} />
        </span>
        <span className={cn('mt-0.5 flex min-w-0 items-center gap-1 text-note', tone)}>
          <span className="truncate">{meta}</span>
        </span>
      </span>
    </>
  )
}

function CommandTaskRow({ task, now }: { readonly task: BackgroundTask; readonly now: number }) {
  const { t } = useTranslation('session')
  const command = task.command!
  const output = useSessionStore((state) => state.commandOutputs[command.commandId])
  const loadCommandOutput = useSessionStore((state) => state.loadCommandOutput)
  const stopCommand = useSessionStore((state) => state.stopCommand)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const running = commandRunning(command.status)

  useEffect(() => {
    if (!expanded) return
    void loadCommandOutput(command.commandId)
    if (!running) return
    const timer = setInterval(() => void loadCommandOutput(command.commandId), 1_000)
    return () => clearInterval(timer)
  }, [command.commandId, expanded, loadCommandOutput, running])

  const ariaLabel = t('activity.commandItem', { command: command.command })
  const toggleLabel = expanded ? t('activity.hideOutput') : t('activity.showOutput')
  return (
    <article aria-label={ariaLabel} className="flex flex-col rounded-item py-1">
      <div className="flex items-start gap-2 rounded-item px-2 py-1.5 hover:bg-hover">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={toggleLabel}
          onClick={() => setExpanded((value) => !value)}
          title={toggleLabel}
          className="flex min-w-0 flex-1 items-start gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <TaskHeader task={task} now={now} />
          <ChevronRight
            aria-hidden
            className={cn(
              'mt-1 size-3.5 shrink-0 text-faint transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
        </button>
        {running && (
          <IconButton
            label={t('activity.stopCommand')}
            size="icon-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void stopCommand(command.commandId).finally(() => setBusy(false))
            }}
          >
            <Square />
          </IconButton>
        )}
      </div>
      {expanded && (
        <pre className="mx-2 mb-1 max-h-56 overflow-auto rounded-item bg-sunk p-2 font-mono text-[11px] text-fg2">
          {output === undefined
            ? t('activity.outputLoading')
            : output.chunks.length === 0
              ? t('activity.outputEmpty')
              : output.chunks.map((chunk, index) => (
                  <span
                    key={index}
                    className={chunk.stream === 'stderr' ? 'text-danger' : undefined}
                  >
                    {chunk.text}
                  </span>
                ))}
          {output !== undefined && output.omittedChars > 0 && (
            <span className="text-faint">
              {'\n'}
              {t('activity.outputOmitted', { chars: output.omittedChars })}
            </span>
          )}
        </pre>
      )}
    </article>
  )
}

function TaskRow({ task, now }: { readonly task: BackgroundTask; readonly now: number }) {
  const { ariaLabel } = useTaskText(task)
  if (task.kind === 'command') return <CommandTaskRow task={task} now={now} />
  return (
    <article aria-label={ariaLabel} className="rounded-item">
      <div className="flex items-start gap-2 rounded-item px-2 py-1.5 hover:bg-hover">
        <TaskHeader task={task} now={now} />
      </div>
    </article>
  )
}

function DelegationTaskRow({
  task,
  now,
  onOpenRun,
}: {
  readonly task: BackgroundTask
  readonly now: number
  readonly onOpenRun: (runId: string) => void
}) {
  const { ariaLabel } = useTaskText(task)
  return (
    <article aria-label={ariaLabel} className="rounded-item">
      <button
        type="button"
        onClick={() => onOpenRun(task.delegation!.childRunId)}
        className="flex w-full items-start gap-2 rounded-item px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
      >
        <TaskHeader task={task} now={now} />
        <ChevronRight aria-hidden className="mt-1 size-3.5 shrink-0 text-faint" />
      </button>
    </article>
  )
}

function Group({
  title,
  count,
  children,
}: {
  readonly title: string
  readonly count: number
  readonly children: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5 px-2 pt-2">
      <h3 className="flex items-baseline gap-2 px-2 pb-1 text-note font-medium text-muted">
        {title}
        <span className="tabular">{count}</span>
      </h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  )
}

export function BackgroundTasksPanel({ sessionId, view, onOpenPanel }: SessionPanelContext) {
  const { t } = useTranslation('session')
  const { running, finished } = useBackgroundTasks(view, sessionId)
  const refreshCommands = useSessionStore((state) => state.refreshCommands)
  const refreshAutofix = useSessionStore((state) => state.refreshAutofix)
  const now = useNow(running.length > 0)

  useEffect(() => {
    void refreshCommands()
    void refreshAutofix()
  }, [refreshAutofix, refreshCommands])

  if (running.length === 0 && finished.length === 0) {
    return (
      <PanelEmpty icon={<Activity />} hint={t('background.emptyHint')}>
        {t('background.empty')}
      </PanelEmpty>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto pb-3">
      {running.length > 0 && (
        <Group title={t('background.running')} count={running.length}>
          {running.map((task) =>
            task.kind === 'delegation' ? (
              <li key={task.key}>
                <DelegationTaskRow
                  task={task}
                  now={now}
                  onOpenRun={(runId) => onOpenPanel('delegation', { runId })}
                />
              </li>
            ) : (
              <li key={task.key}>
                <TaskRow task={task} now={now} />
              </li>
            ),
          )}
        </Group>
      )}
      {finished.length > 0 && (
        <Group title={t('background.finished')} count={finished.length}>
          {finished.map((task) =>
            task.kind === 'delegation' ? (
              <li key={task.key}>
                <DelegationTaskRow
                  task={task}
                  now={now}
                  onOpenRun={(runId) => onOpenPanel('delegation', { runId })}
                />
              </li>
            ) : (
              <li key={task.key}>
                <TaskRow task={task} now={now} />
              </li>
            ),
          )}
        </Group>
      )}
    </div>
  )
}
