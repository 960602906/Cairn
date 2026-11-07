/**
 * 计划卡片（M3-05）：目标、文件、步骤、风险、验证方式。
 *
 * 待审时可以改步骤标题，再批准、附说明重新规划，或放弃。
 * 批准后显示每一步的进度；模型偏离计划时，说明写在这一步下面，不阻止执行。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus, type PlanView } from '@cairn/core'
import { PLAN_FEEDBACK_MAX, PLAN_TITLE_MAX } from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { Button } from './ui/index.js'

export interface PlanCardProps {
  readonly plan: PlanView
  readonly busy: boolean
  readonly onApprove: (steps: readonly { id: string; title: string }[] | undefined) => void
  readonly onReplan: (feedback: string) => void
  readonly onAbandon: () => void
}

export function PlanCard({ plan, busy, onApprove, onReplan, onAbandon }: PlanCardProps) {
  const { t } = useTranslation('session')
  const [titles, setTitles] = useState(() => plan.steps.map((step) => step.title))
  const [replanning, setReplanning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const pending = plan.status === 'proposed'
  const edited = plan.steps.some((step, index) => step.title !== titles[index]?.trim())
  const titlesValid = titles.every((title) => title.trim() !== '')
  const note = feedback.trim()

  return (
    <article aria-label={t('plan.title')} className="mt-3 rounded-card bg-raise p-4 shadow-2">
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
          {plan.steps.map((step, index) => (
            <li key={step.id} className="text-ui text-fg">
              {pending ? (
                <input
                  aria-label={t('plan.stepLabel', { index: index + 1 })}
                  value={titles[index] ?? ''}
                  maxLength={PLAN_TITLE_MAX}
                  disabled={busy}
                  onChange={(event) =>
                    setTitles((current) =>
                      current.map((title, i) => (i === index ? event.target.value : title)),
                    )
                  }
                  className="w-full rounded-item bg-sunk px-2 py-1 text-ui text-fg outline-none"
                />
              ) : (
                <p>
                  <span className="text-muted">{t(`plan.step.${step.status}`)}</span>
                  <span className="mx-1.5 text-faint">·</span>
                  {step.title}
                </p>
              )}
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
      {pending && !replanning && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy || !titlesValid}
            onClick={() =>
              onApprove(
                edited
                  ? plan.steps.map((step, index) => ({ id: step.id, title: titles[index]!.trim() }))
                  : undefined,
              )
            }
          >
            {edited ? t('plan.approveEdited') : t('plan.approve')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setReplanning(true)}>
            {t('plan.replan')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onAbandon}>
            {t('plan.abandon')}
          </Button>
        </div>
      )}
      {pending && replanning && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (note === '' || busy) return
            onReplan(note)
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
      )}
    </article>
  )
}

/** 接到当前会话上的计划卡片。 */
export function SessionPlanCard({ plan }: { readonly plan: PlanView }) {
  const approvePlan = useSessionStore((s) => s.approvePlan)
  const replan = useSessionStore((s) => s.replan)
  const abandonPlan = useSessionStore((s) => s.abandonPlan)
  const busy = useSessionStore((s) => {
    const id = s.activeSessionId
    if (id === undefined) return false
    if (s.awaitingTurn[id]) return true
    const view = s.views[id]
    if (!view) return false
    const status = sessionStatus(view)
    return status === 'running' || status === 'waiting_approval'
  })
  return (
    <PlanCard
      plan={plan}
      busy={busy}
      onApprove={(steps) => void approvePlan(plan.planId, steps)}
      onReplan={(feedback) => void replan(plan.planId, feedback)}
      onAbandon={() => void abandonPlan(plan.planId)}
    />
  )
}
