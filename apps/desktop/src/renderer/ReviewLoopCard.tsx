/**
 * 审查循环卡片（M7-07，团队模板的 `review-loop` 模式）：对话里显示每轮的 maker / checker
 * 判定与最终结局。轮次由 `team.review.round` 事件累积，结局来自 `team.review.completed`。
 */
import { Repeat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReviewLoopView } from '@cairn/core'
import { cn } from './ui/index.js'

const statusClass = (status: ReviewLoopView['status']): string => {
  if (status === 'passed') return 'bg-ok-soft text-ok'
  if (status === 'failed' || status === 'stopped') return 'bg-danger-soft text-danger'
  if (status === 'exhausted' || status === 'limit_reached') return 'bg-warn-soft text-warn'
  return 'bg-sunk2 text-muted'
}

export function ReviewLoopCard({ loop }: { readonly loop: ReviewLoopView }) {
  const { t } = useTranslation('session')
  return (
    <section
      aria-label={t('review.title')}
      className="rounded-card bg-raise p-3 shadow-1"
      data-review-id={loop.reviewId}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Repeat aria-hidden className="size-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 font-medium text-fg2">{t('review.title')}</span>
        <span className="text-note text-muted">
          {t('review.rounds', { count: loop.rounds.length })}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]',
            statusClass(loop.status),
          )}
        >
          {loop.status === undefined ? t('review.running') : t(`review.status.${loop.status}`)}
        </span>
      </div>
      {loop.rounds.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1.5">
          {loop.rounds.map((round) => (
            <li key={round.round} className="flex items-start gap-2 text-note">
              <span className="shrink-0 text-faint">
                {t('review.round', { round: round.round })}
              </span>
              <span
                className={cn(
                  'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]',
                  round.verdict === 'pass' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn',
                )}
              >
                {t(`review.verdict.${round.verdict}`)}
              </span>
              {round.feedback !== undefined && (
                <span className="min-w-0 flex-1 text-muted">{round.feedback}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {loop.summary !== undefined && loop.summary !== '' && (
        <p className="mt-2 text-note text-muted">{loop.summary}</p>
      )}
    </section>
  )
}
