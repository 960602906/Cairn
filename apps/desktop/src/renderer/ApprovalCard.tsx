/**
 * 审批卡片（M1-11b，架构 §10.4）：当前会话的未决审批，按请求顺序。每张卡片显示工具名、判定理由、
 * 预览（命令或 diff）与参数，可以允许一次、本会话 / 本项目始终允许或拒绝（可附说明，交给模型）。
 * 决定期间按钮不可用；失败时错误由错误横幅显示，卡片保留。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  APPROVAL_FEEDBACK_MAX_LENGTH,
  type ApprovalDecision,
  type PendingApproval,
} from '@nexus/protocol'
import { useSessionStore } from './store-context.js'

const NONE: readonly PendingApproval[] = []

const DECISIONS: readonly { decision: ApprovalDecision; label: string }[] = [
  { decision: 'allow_once', label: 'approval.allowOnce' },
  { decision: 'allow_session', label: 'approval.allowSession' },
  { decision: 'allow_project', label: 'approval.allowProject' },
]

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return String(input)
  }
}

function Card({ approval }: { readonly approval: PendingApproval }) {
  const { t } = useTranslation('session')
  const resolveApproval = useSessionStore((s) => s.resolveApproval)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const { preview, tool } = approval
  const titleId = `approval-${approval.approvalId}`
  // 没有检查点时只能继续一次或拒绝，“始终允许”不适用
  const decisions = approval.kind === 'no_checkpoint' ? DECISIONS.slice(0, 1) : DECISIONS

  const decide = async (decision: ApprovalDecision) => {
    setBusy(true)
    await resolveApproval(approval.approvalId, decision, feedback)
    setBusy(false)
  }

  return (
    <article aria-labelledby={titleId}>
      <h3 id={titleId}>
        {approval.kind === 'no_checkpoint'
          ? t('approval.noCheckpoint', { name: tool.name })
          : t('approval.title', { name: tool.name })}
      </h3>
      <p>
        {t('approval.reasonLabel')}:{' '}
        {t(`approval.reason.${approval.reasonCode}`, {
          defaultValue: t('approval.reason.unknown'),
        })}
      </p>
      {preview?.summary && (
        <p>
          {t('approval.summary')}: {preview.summary}
        </p>
      )}
      {preview?.command !== undefined && (
        <figure>
          <figcaption>{t('approval.command')}</figcaption>
          <pre>{preview.command}</pre>
        </figure>
      )}
      {preview?.diff !== undefined && (
        <figure>
          <figcaption>{t('approval.diff')}</figcaption>
          <pre>{preview.diff}</pre>
        </figure>
      )}
      {preview?.command === undefined && preview?.diff === undefined && (
        <figure>
          <figcaption>{t('approval.input')}</figcaption>
          <pre>{formatInput(approval.input)}</pre>
        </figure>
      )}
      <textarea
        aria-label={t('approval.feedback')}
        placeholder={t('approval.feedback')}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        maxLength={APPROVAL_FEEDBACK_MAX_LENGTH}
      />
      <div>
        {decisions.map(({ decision, label }) => (
          <button
            key={decision}
            type="button"
            disabled={busy}
            onClick={() => void decide(decision)}
          >
            {t(label)}
          </button>
        ))}
        <button type="button" disabled={busy} onClick={() => void decide('deny')}>
          {t('approval.deny')}
        </button>
      </div>
    </article>
  )
}

/** 当前会话的未决审批；没有时不显示。 */
export function ApprovalList() {
  const { t } = useTranslation('session')
  const approvals = useSessionStore((s) =>
    s.activeSessionId === undefined ? NONE : (s.approvals[s.activeSessionId] ?? NONE),
  )
  if (approvals.length === 0) return null
  return (
    <section aria-label={t('approval.region')}>
      {approvals.map((approval) => (
        <Card key={approval.approvalId} approval={approval} />
      ))}
    </section>
  )
}
