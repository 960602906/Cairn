/**
 * 流水线进度卡片（M7-08）：按依赖执行的固定阶段，显示每个阶段的状态、跳过项与结局。
 * 图形与色调沿用计划进度卡（Check / Clock / CircleSlash）。
 */
import { Check, CircleSlash, Clock, ListChecks, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PipelineStageView, PipelineView } from '@cairn/core'
import { cn } from './ui/index.js'

const statusClass = (status: PipelineView['status'] | undefined): string => {
  if (status === 'completed') return 'bg-ok-soft text-ok'
  if (status === 'failed' || status === 'stopped') return 'bg-danger-soft text-danger'
  if (status === 'limit_reached') return 'bg-warn-soft text-warn'
  return 'bg-sunk2 text-muted'
}

function StageIcon({ status }: { readonly status: PipelineStageView['status'] }) {
  if (status === 'completed') return <Check aria-hidden className="size-3.5 text-ok" />
  if (status === 'failed') return <X aria-hidden className="size-3.5 text-danger" />
  if (status === 'limit_reached') return <Clock aria-hidden className="size-3.5 text-warn" />
  return (
    <CircleSlash
      aria-hidden
      className={cn('size-3.5', status === 'aborted' ? 'text-muted' : 'text-faint')}
    />
  )
}

export function PipelineCard({ pipeline }: { readonly pipeline: PipelineView }) {
  const { t } = useTranslation('session')
  const total = pipeline.stages.length + pipeline.skipped.length
  const completed = pipeline.stages.filter((stage) => stage.status === 'completed').length
  return (
    <section
      aria-label={t('pipeline.title')}
      className="rounded-card bg-raise p-3 shadow-1"
      data-pipeline-id={pipeline.pipelineId}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ListChecks aria-hidden className="size-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 font-medium text-fg2">{t('pipeline.title')}</span>
        <span className="text-note text-muted">{t('pipeline.progress', { completed, total })}</span>
        <span
          className={cn(
            'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px]',
            statusClass(pipeline.status),
          )}
        >
          {pipeline.status === undefined
            ? t('pipeline.running')
            : t(`pipeline.status.${pipeline.status}`)}
        </span>
      </div>
      {pipeline.stages.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1.5">
          {pipeline.stages.map((stage) => (
            <li key={stage.stage} className="flex items-start gap-2 text-note">
              <StageIcon status={stage.status} />
              <span className="shrink-0 font-medium text-fg2">{stage.stage}</span>
              <span className="shrink-0 text-faint">{t(`pipeline.stage.${stage.status}`)}</span>
              {stage.summary !== undefined && (
                <span className="min-w-0 flex-1 text-muted">{stage.summary}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {pipeline.skipped.length > 0 && (
        <p className="mt-2 text-note text-warn">
          {t('pipeline.skipped', { stages: pipeline.skipped.join('、') })}
        </p>
      )}
      {pipeline.summary !== undefined && pipeline.summary !== '' && (
        <p className="mt-2 text-note text-muted">{pipeline.summary}</p>
      )}
    </section>
  )
}
