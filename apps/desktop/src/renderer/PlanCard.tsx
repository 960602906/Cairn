/**
 * 计划卡片（M3-05）：对话里显示摘要与审批操作，右侧栏只展示完整内容。
 *
 * 步骤与待办条目的图标：未开始空心圆、进行中转圈、完成绿色对勾圆、跳过划线圆；执行中的标记也用转圈，
 * 不用品牌图形。
 */
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleSlash,
  Copy,
  ChevronDown,
  ListTodo,
  Download,
  Lightbulb,
  LoaderCircle,
  Maximize2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus, type PlanView, type TaskItemView, type TaskListView } from '@cairn/core'
import { PLAN_FEEDBACK_MAX } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { Button, cn, FloatCard, IconButton } from './ui/index.js'

/** 下载与复制使用的完整计划文本。 */
export function planDocument(plan: PlanView): string {
  // 执行时的修订会清掉旧 Markdown；复制/下载必须反映当前步骤。
  if (plan.content.markdown.trim() !== '') return plan.content.markdown.trim()
  const { goal, files, risks, verification } = plan.content
  return [
    `# ${goal}`,
    '## Files',
    ...(files.length === 0 ? ['None'] : files.map((file) => `- ${file}`)),
    '## Steps',
    ...plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
    '## Risks',
    risks.trim() || 'None',
    '## Verification',
    verification.trim() || 'None',
  ].join('\n\n')
}

/** 摘要只保留标题和几行正文，避免计划占满整个对话区。 */
export function planPreview(plan: PlanView): string {
  const markdown = planDocument(plan)
  const lines = markdown.split('\n')
  if (lines[0]?.replace(/^#+\s*/, '').trim() === plan.content.goal.trim()) lines.shift()
  return lines.join('\n').trim()
}

/** 执行中的转圈（计划状态、进度卡的“执行中”标记）。 */
function Spinner({ size }: { readonly size: number }) {
  return (
    <LoaderCircle
      aria-hidden
      style={{ width: size, height: size, animationDuration: '1.4s' }}
      strokeWidth={2.4}
      className="shrink-0 animate-spin"
    />
  )
}

/**
 * 待审批计划的操作条：浮在输入框上方，计划正文仍留在对话里。
 *
 * 「取消」放弃这份计划：不再开始新的一轮，也不执行；计划卡片留在对话里并标记为已取消。
 * 计划模式的那一轮在 `propose_plan` 之后已经结束，没有在等结果，所以取消不需要回传任何东西。
 */
export function PlanActions({ plan }: { readonly plan: PlanView | undefined }) {
  const { t } = useTranslation('session')
  const approvePlan = useSessionStore((s) => s.approvePlan)
  const replan = useSessionStore((s) => s.replan)
  const abandonPlan = useSessionStore((s) => s.abandonPlan)
  const [replanning, setReplanning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const busy = useSessionStore((s) => {
    const id = s.activeSessionId
    if (id === undefined) return false
    if (s.awaitingTurn[id]) return true
    const view = s.views[id]
    if (!view) return false
    const status = sessionStatus(view)
    return status === 'running' || status === 'waiting_approval'
  })
  const note = feedback.trim()
  if (!plan || plan.status !== 'proposed') return null
  return (
    <FloatCard aria-label={t('plan.actions')}>
      <div className="flex items-center gap-2">
        <Lightbulb aria-hidden className="size-3.5 shrink-0 text-accent" />
        <span
          className="min-w-0 flex-1 truncate text-note font-medium text-fg"
          title={plan.content.goal}
        >
          {plan.content.goal}
        </span>
        {!replanning && (
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void approvePlan(plan.planId)}
            >
              {t('plan.approve')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setReplanning(true)}
            >
              {t('plan.replan')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void abandonPlan(plan.planId)}
            >
              {t('plan.cancelPlan')}
            </Button>
          </span>
        )}
      </div>
      {replanning && (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (note === '' || busy) return
            void replan(plan.planId, note)
          }}
        >
          <textarea
            aria-label={t('plan.replan')}
            rows={2}
            value={feedback}
            maxLength={PLAN_FEEDBACK_MAX}
            disabled={busy}
            placeholder={t('plan.replanPlaceholder')}
            onChange={(event) => setFeedback(event.target.value)}
            className="w-full resize-none rounded-item bg-sunk px-3 py-2 text-ui text-fg outline-none placeholder:text-faint"
          />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" type="submit" disabled={busy || note === ''}>
              {t('plan.replanSubmit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => setReplanning(false)}
            >
              {t('plan.replanBack')}
            </Button>
          </div>
        </form>
      )}
    </FloatCard>
  )
}

/** 对话里的计划只显示目标、摘要、下载/复制/侧栏入口和审批操作。 */
export function PlanSummaryCard({
  plan,
  onOpen,
}: {
  readonly plan: PlanView
  readonly onOpen: (planId: string) => void
}) {
  const { t } = useTranslation('session')
  const [copied, setCopied] = useState(false)
  const status =
    plan.status === 'proposed'
      ? t('plan.short.proposed')
      : plan.status === 'approved'
        ? t('plan.short.approved')
        : plan.feedback
          ? t('plan.short.replanned')
          : t('plan.short.rejected')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(planDocument(plan))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([planDocument(plan)], { type: 'text/markdown;charset=utf-8' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${plan.planId}.md`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }
  return (
    <article className="mt-3 overflow-hidden rounded-card border-[0.5px] border-hair bg-raise shadow-hair2">
      <header className="flex h-10 items-center gap-2 border-b-[0.5px] border-hair px-3">
        <Lightbulb aria-hidden className="size-3.5 text-faint" />
        <span className="text-note font-medium text-fg2">{t('plan.title')}</span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
            plan.status === 'approved' ? 'bg-accent-soft text-accent' : 'bg-sunk text-muted',
          )}
        >
          {plan.status === 'approved' && <Spinner size={11} />}
          {status}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <IconButton label={t('plan.download')} size="icon-sm" onClick={download}>
            <Download />
          </IconButton>
          <IconButton
            label={copied ? t('plan.copied') : t('plan.copy')}
            size="icon-sm"
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
          </IconButton>
          <IconButton label={t('plan.openSide')} size="icon-sm" onClick={() => onOpen(plan.planId)}>
            <Maximize2 />
          </IconButton>
        </span>
      </header>
      <button
        type="button"
        aria-label={t('plan.summary.open', { goal: plan.content.goal })}
        onClick={() => onOpen(plan.planId)}
        className="block w-full px-4 py-3 text-left transition-colors hover:bg-sunk"
      >
        <h3 className="text-heading text-fg">{plan.content.goal}</h3>
        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-ui text-fg2">
          {planPreview(plan)}
        </p>
      </button>
    </article>
  )
}

/** 步骤与待办条目的图标：未开始空心圆、进行中转圈、完成绿色对勾圆、跳过划线圆。 */
function StepIcon({ status }: { readonly status: PlanView['steps'][number]['status'] }) {
  switch (status) {
    case 'in_progress':
      return (
        <LoaderCircle
          aria-hidden
          strokeWidth={2.4}
          style={{ animationDuration: '1.4s' }}
          className="size-3.5 shrink-0 animate-spin text-accent"
        />
      )
    case 'done':
      return <CircleCheck aria-hidden className="size-3.5 shrink-0 text-ok" />
    case 'skipped':
      return <CircleSlash aria-hidden className="size-3.5 shrink-0 text-faint" />
    default:
      return <Circle aria-hidden className="size-3.5 shrink-0 text-faint" />
  }
}

/** 计划还有没做完的步骤。 */
export function planInProgress(plan: PlanView): boolean {
  return plan.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')
}

/** 进度卡只需要标题与条目；计划视图与待办列表都能直接传入。 */
type ProgressList = Pick<TaskListView, 'title' | 'items'>

/**
 * 待办列表进度卡（ADR-0038）：悬浮在输入框上方，计划关联列表与普通轮次的临时列表共用。
 * 标题行可以收起条目；只有计划来源的列表提供 `onOpen`（打开完整计划）。
 */
export function TaskProgress({
  list,
  running,
  onOpen,
  labelKey = 'plan.progress.label',
}: {
  readonly list: ProgressList
  /** 会话正在运行（Agent 正在执行）。 */
  readonly running?: boolean
  /** 打开计划侧栏；临时列表没有可打开的详情。 */
  readonly onOpen?: () => void
  readonly labelKey?: 'plan.progress.label' | 'taskList.progress.label'
}) {
  const { t } = useTranslation('session')
  const [expanded, setExpanded] = useState(true)
  const finished = list.items.filter(
    (item) => item.status === 'done' || item.status === 'skipped',
  ).length
  const current =
    list.items.find((item) => item.status === 'in_progress') ??
    list.items.find((item) => item.status === 'pending')
  const title = expanded || !current ? list.title : current.title
  return (
    <FloatCard variant="bar" aria-label={t(labelKey)}>
      <div className="flex h-9 items-center gap-2 pr-1.5 pl-3">
        <ListTodo
          aria-hidden
          className={cn('size-3.5 shrink-0', running ? 'text-accent' : 'text-muted')}
        />
        {onOpen ? (
          <button
            type="button"
            title={t('plan.openSide')}
            onClick={onOpen}
            className="min-w-0 flex-1 truncate rounded-[5px] text-left text-note font-medium text-fg outline-none hover:underline focus-visible:ring-1 focus-visible:ring-accent"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-note font-medium text-fg">{title}</span>
        )}
        {running && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
            <Spinner size={10} />
            {t('plan.progress.running')}
          </span>
        )}
        <span className="tabular shrink-0 text-note text-muted">
          {t('plan.progress.count', { done: finished, total: list.items.length })}
        </span>
        <IconButton
          label={t(expanded ? 'plan.progress.collapse' : 'plan.progress.expand')}
          size="icon-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown className={cn('transition-transform', !expanded && 'rotate-180')} />
        </IconButton>
      </div>
      {expanded && (
        <ol className="flex max-h-44 flex-col gap-1.5 overflow-y-auto border-t-[0.5px] border-hair px-3 py-2.5">
          {list.items.map((item) => (
            <li key={item.itemId} className="flex items-center gap-2.5 text-ui">
              <StepIcon status={item.status} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  item.status === 'done' || item.status === 'skipped' ? 'text-muted' : 'text-fg',
                )}
              >
                {item.title}
              </span>
              <span className="shrink-0 text-[11.5px] text-muted">
                {t(`plan.step.${item.status}`)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </FloatCard>
  )
}

/** 计划进度：沿用计划标题与步骤，内部与通用进度卡一致。 */
export function PlanProgress({
  plan,
  running,
  onOpen,
}: {
  readonly plan: PlanView
  /** 会话正在运行（Agent 正在执行步骤）。 */
  readonly running?: boolean
  readonly onOpen: () => void
}) {
  return (
    <TaskProgress
      list={{
        title: plan.content.goal,
        items: plan.steps.map((step) => ({
          itemId: step.id,
          title: step.title,
          status: step.status,
          ...(step.note ? { note: step.note } : {}),
        })),
      }}
      {...(running !== undefined ? { running } : {})}
      onOpen={onOpen}
    />
  )
}

/** 右侧栏的完整计划：只展示内容，不重复审批操作。铺在侧栏纸面上，不再套一层卡片。 */
export function PlanDetails({
  plan,
  steps,
  running,
}: {
  readonly plan: PlanView
  /** 执行中的步骤来自关联待办列表（ADR-0038）；省略时用计划快照。 */
  readonly steps?: readonly TaskItemView[]
  /** 会话正在运行（Agent 正在执行步骤）。 */
  readonly running?: boolean
}) {
  const { t } = useTranslation('session')
  const label = 'text-[11.5px] font-medium tracking-[0.02em] text-faint'
  const rows =
    steps ??
    plan.steps.map((step) => ({
      itemId: step.id,
      title: step.title,
      status: step.status,
      ...(step.note ? { note: step.note } : {}),
    }))
  return (
    <article aria-label={t('plan.title')} className="flex flex-col gap-5 px-4 pt-2 pb-5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-heading leading-snug text-fg">{plan.content.goal}</h3>
        {running && (
          <span className="mt-1 flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
            <Spinner size={10} />
            {t('plan.progress.running')}
          </span>
        )}
      </div>
      <section>
        <h4 className={label}>{t('plan.steps')}</h4>
        <ol className="mt-2 flex flex-col gap-2.5">
          {rows.map((step) => {
            return (
              <li key={step.itemId} className="flex items-start gap-2.5 text-ui">
                <span className="mt-[3px] flex">
                  <StepIcon status={step.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn(step.status === 'done' ? 'text-fg2' : 'text-fg')}>
                    {step.title}
                  </p>
                  {step.note && (
                    <p className="mt-1 text-note text-muted">
                      {t('plan.note', { note: step.note })}
                    </p>
                  )}
                </div>
                <span className="mt-px shrink-0 text-[11.5px] text-muted">
                  {t(`plan.step.${step.status}`)}
                </span>
              </li>
            )
          })}
        </ol>
      </section>
      <section>
        <h4 className={label}>{t('plan.files')}</h4>
        {plan.content.files.length === 0 ? (
          <p className="mt-1.5 text-ui text-fg2">{t('plan.none')}</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1 font-mono text-[12px] text-fg2">
            {plan.content.files.map((file) => (
              <li key={file} className="break-all">
                {file}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-ui text-fg2">
        <span className={cn('block', label)}>{t('plan.risks')}</span>
        <span className="mt-1.5 block whitespace-pre-wrap">
          {plan.content.risks.trim() || t('plan.none')}
        </span>
      </p>
      <p className="text-ui text-fg2">
        <span className={cn('block', label)}>{t('plan.verification')}</span>
        <span className="mt-1.5 block whitespace-pre-wrap">
          {plan.content.verification.trim() || t('plan.none')}
        </span>
      </p>
      {plan.content.markdown.trim() !== '' && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-note text-muted hover:text-fg2 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            {t('plan.markdown')}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-ui text-fg2">
            {plan.content.markdown}
          </pre>
        </details>
      )}
      {plan.status === 'approved' && (
        <p className="text-note text-muted">{t('plan.status.approved')}</p>
      )}
      {plan.status === 'rejected' && (
        <p className="text-note text-muted">
          {plan.feedback ? t('plan.status.replanned') : t('plan.status.rejected')}
          {plan.feedback && (
            <span className="mt-1 block text-fg2">
              {t('plan.feedback', { feedback: plan.feedback })}
            </span>
          )}
        </p>
      )}
    </article>
  )
}
