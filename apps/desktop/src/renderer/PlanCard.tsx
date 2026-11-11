/**
 * 计划卡片（M3-05）：对话里显示摘要与审批操作，右侧栏只展示完整内容。
 */
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Copy,
  ChevronDown,
  ListTodo,
  Download,
  Lightbulb,
  Maximize2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus, type PlanView } from '@cairn/core'
import { PLAN_FEEDBACK_MAX } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { Button, cn, IconButton } from './ui/index.js'

/** 下载与复制使用的完整计划文本。 */
export function planDocument(plan: PlanView): string {
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

function PlanReviewActions({ plan }: { readonly plan: PlanView }) {
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
  if (plan.status !== 'proposed') return null
  return (
    <div className="border-t-[0.5px] border-hair px-3 py-2.5">
      {replanning ? (
        <form
          className="flex flex-col gap-2"
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
            <Button variant="primary" type="submit" disabled={busy || note === ''}>
              {t('plan.replanSubmit')}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => setReplanning(false)}
            >
              {t('plan.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void approvePlan(plan.planId)}>
            {t('plan.approve')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setReplanning(true)}>
            {t('plan.replan')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void abandonPlan(plan.planId)}>
            {t('plan.abandon')}
          </Button>
        </div>
      )}
    </div>
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
        <span className="shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[11px] text-muted">
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
      <PlanReviewActions plan={plan} />
    </article>
  )
}

const STEP_ICON = {
  done: CircleCheck,
  in_progress: CircleDot,
  skipped: CircleSlash,
  pending: Circle,
} as const

function StepIcon({ status }: { readonly status: PlanView['steps'][number]['status'] }) {
  const Icon = STEP_ICON[status]
  return (
    <Icon
      aria-hidden
      className={cn(
        'size-3.5 shrink-0',
        status === 'done' ? 'text-ok' : status === 'in_progress' ? 'text-accent' : 'text-faint',
      )}
    />
  )
}

/** 计划还有没做完的步骤。 */
export function planInProgress(plan: PlanView): boolean {
  return plan.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')
}

/**
 * 执行中的计划进度：悬浮在输入框上方的一张小卡片，随时能看到做到哪一步。
 * 标题行可以收起步骤；点目标在右侧打开完整计划。
 */
export function PlanProgress({
  plan,
  onOpen,
}: {
  readonly plan: PlanView
  readonly onOpen: () => void
}) {
  const { t } = useTranslation('session')
  const [expanded, setExpanded] = useState(true)
  const finished = plan.steps.filter(
    (step) => step.status === 'done' || step.status === 'skipped',
  ).length
  const current =
    plan.steps.find((step) => step.status === 'in_progress') ??
    plan.steps.find((step) => step.status === 'pending')
  return (
    <section
      aria-label={t('plan.progress.label')}
      className="mb-2 overflow-hidden rounded-card bg-raise shadow-2"
    >
      <div className="flex h-9 items-center gap-2 pr-1.5 pl-3">
        <ListTodo aria-hidden className="size-3.5 shrink-0 text-muted" />
        <button
          type="button"
          title={t('plan.openSide')}
          onClick={onOpen}
          className="min-w-0 flex-1 truncate rounded-[5px] text-left text-note font-medium text-fg outline-none hover:underline focus-visible:ring-1 focus-visible:ring-accent"
        >
          {expanded || !current ? plan.content.goal : current.title}
        </button>
        <span className="tabular shrink-0 text-note text-muted">
          {t('plan.progress.count', { done: finished, total: plan.steps.length })}
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
          {plan.steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2.5 text-ui">
              <StepIcon status={step.status} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  step.status === 'done' || step.status === 'skipped' ? 'text-muted' : 'text-fg',
                )}
              >
                {step.title}
              </span>
              <span className="shrink-0 text-[11.5px] text-muted">
                {t(`plan.step.${step.status}`)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** 右侧栏的完整计划：只展示内容，不重复审批操作。铺在侧栏纸面上，不再套一层卡片。 */
export function PlanDetails({ plan }: { readonly plan: PlanView }) {
  const { t } = useTranslation('session')
  const label = 'text-[11.5px] font-medium tracking-[0.02em] text-faint'
  return (
    <article aria-label={t('plan.title')} className="flex flex-col gap-5 px-4 pt-2 pb-5">
      <h3 className="text-heading leading-snug text-fg">{plan.content.goal}</h3>
      <section>
        <h4 className={label}>{t('plan.steps')}</h4>
        <ol className="mt-2 flex flex-col gap-2.5">
          {plan.steps.map((step) => {
            return (
              <li key={step.id} className="flex items-start gap-2.5 text-ui">
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
