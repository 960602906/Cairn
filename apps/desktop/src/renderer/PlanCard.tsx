/**
 * 计划卡片（M3-05）：对话里显示摘要与审批操作，右侧栏只展示完整内容。
 */
import { Check, Copy, Download, Lightbulb, Maximize2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus, type PlanView } from '@cairn/core'
import { PLAN_FEEDBACK_MAX } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { Button, IconButton } from './ui/index.js'

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
          <IconButton
            label={t('plan.openSide')}
            size="icon-sm"
            onClick={() => onOpen(plan.planId)}
          >
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

/** 右侧栏的完整计划：只展示内容，不重复审批操作。 */
export function PlanDetails({ plan }: { readonly plan: PlanView }) {
  const { t } = useTranslation('session')
  return (
    <article
      aria-label={t('plan.title')}
      className="rounded-card border-[0.5px] border-hair bg-raise p-4"
    >
      <h3 className="text-heading text-fg">{plan.content.goal}</h3>
      <section className="mt-3">
        <h4 className="text-note text-muted">{t('plan.files')}</h4>
        {plan.content.files.length === 0 ? (
          <p className="mt-1 text-ui text-fg2">{t('plan.none')}</p>
        ) : (
          <ul className="mt-1 font-mono text-[13px] text-fg">
            {plan.content.files.map((file) => (
              <li key={file} className="break-all">
                {file}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="mt-3">
        <h4 className="text-note text-muted">{t('plan.steps')}</h4>
        <ol className="mt-1 flex flex-col gap-2">
          {plan.steps.map((step) => (
            <li key={step.id} className="text-ui text-fg">
              <p>
                <span className="text-muted">{t(`plan.step.${step.status}`)}</span>
                <span className="mx-1.5 text-faint">·</span>
                {step.title}
              </p>
              {step.note && (
                <p className="mt-1 text-note text-fg2">{t('plan.note', { note: step.note })}</p>
              )}
            </li>
          ))}
        </ol>
      </section>
      <p className="mt-3 text-ui text-fg2">
        <span className="text-note text-muted">{t('plan.risks')}</span>
        <span className="mt-1 block whitespace-pre-wrap">
          {plan.content.risks.trim() || t('plan.none')}
        </span>
      </p>
      <p className="mt-2 text-ui text-fg2">
        <span className="text-note text-muted">{t('plan.verification')}</span>
        <span className="mt-1 block whitespace-pre-wrap">
          {plan.content.verification.trim() || t('plan.none')}
        </span>
      </p>
      {plan.content.markdown.trim() !== '' && (
        <details className="mt-3">
          <summary className="cursor-pointer text-note text-muted">{t('plan.markdown')}</summary>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-ui text-fg2">
            {plan.content.markdown}
          </pre>
        </details>
      )}
      {plan.status === 'approved' && (
        <p className="mt-3 text-note text-muted">{t('plan.status.approved')}</p>
      )}
      {plan.status === 'rejected' && (
        <p className="mt-3 text-note text-muted">
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
