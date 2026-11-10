/**
 * 审批卡片（M2-05，视觉规范 §6；M1-11b 起）：当前会话的未决审批，按请求顺序。
 *
 * 浮起的卡片：标题是一个问题（“要运行这条命令吗？”），下面是命令、改动或路径，以及触发审批的原因；
 * 再下面是三个编号选项：
 * 1. 运行一次（Enter）
 * 2. 运行，并且以后同类操作不再询问（写明作用范围：仅此项目）
 * 3. 不运行，告诉 Agent 换个做法（Esc）：选中后出现说明输入框，Enter 提交（说明交给模型）
 *
 * 键盘：数字键 1–3 直接选择，Enter 选 1，Esc 拒绝。只有最早的一张卡片响应键盘；正在别的输入框里打字、
 * 或有对话框和菜单打开时不响应。没有检查点（`no_checkpoint`）时只能继续一次或拒绝。
 * 决定期间选项不可用；失败时错误由错误横幅显示，卡片保留。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  APPROVAL_FEEDBACK_MAX_LENGTH,
  type ApprovalDecision,
  type PendingApproval,
} from '@cairn/protocol'
import { useSessionStore } from './store-context.js'
import { SandboxBadge } from './SandboxBadge.js'
import { sandboxLabels } from './sandbox-labels.js'
import { cn, Kbd } from './ui/index.js'

const NONE: readonly PendingApproval[] = []

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return String(input)
  }
}

/** 文案按操作的类别区分：运行命令、改文件，其他。 */
function wording(approval: PendingApproval): 'command' | 'write' | 'other' {
  if (approval.tool.category === 'execute' || approval.preview?.command !== undefined)
    return 'command'
  if (approval.tool.category === 'write') return 'write'
  return 'other'
}

/** 键盘事件是否来自正在打字的输入框（空的输入框不算，例如发送后仍有焦点的输入框）。 */
function typing(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
    return target.value !== ''
  return target instanceof HTMLElement && target.isContentEditable
}

function Option({
  index,
  hint,
  disabled,
  onSelect,
  children,
}: {
  readonly index: number
  readonly hint?: string
  readonly disabled: boolean
  readonly onSelect: () => void
  readonly children: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-center gap-3 rounded-item px-2.5 py-2 text-left text-ui text-fg transition-colors hover:bg-hover disabled:opacity-45"
      >
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-sunk2 font-mono text-[11.5px] text-fg2"
        >
          {index}
        </span>
        <span className="min-w-0 flex-1">{children}</span>
        {hint && <Kbd aria-hidden>{hint}</Kbd>}
      </button>
    </li>
  )
}

/** 一张审批卡片；委派卡片也复用它显示子运行的审批。 */
export function ApprovalCard({
  approval,
  active,
  onResolve,
}: {
  readonly approval: PendingApproval
  readonly active: boolean
  readonly onResolve?:
    | ((approvalId: string, decision: ApprovalDecision, feedback?: string) => Promise<boolean>)
    | undefined
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation('common')
  const resolveActiveApproval = useSessionStore((s) => s.resolveApproval)
  const resolveApproval = onResolve ?? resolveActiveApproval
  const [feedback, setFeedback] = useState('')
  const [denying, setDenying] = useState(false)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const { preview, tool } = approval
  const kind = wording(approval)
  const noCheckpoint = approval.kind === 'no_checkpoint'
  const overridable = approval.overridable !== false
  const sandbox = approval.sandbox
  const sandboxInfo = sandbox ? sandboxLabels(tc, sandbox) : undefined
  const paths = approval.targets.paths ?? []

  const decide = async (decision: ApprovalDecision, note = '') => {
    if (busy) return
    setBusy(true)
    await resolveApproval(approval.approvalId, decision, note.trim())
    setBusy(false)
  }
  const openDeny = () => {
    setDenying(true)
    queueMicrotask(() => field.current?.focus())
  }

  // 键盘：1 / Enter 允许一次，2 以后不再询问，3 打开说明输入框，Esc 拒绝
  const keys = useRef({ decide, openDeny, feedback })
  keys.current = { decide, openDeny, feedback }
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (document.querySelector('[role="dialog"]:not([aria-hidden="true"]), [role="menu"]'))
        return
      const k = keys.current
      if (event.key === 'Escape') {
        event.preventDefault()
        void k.decide('deny', k.feedback)
        return
      }
      if (typing(event.target) || event.target === field.current) return
      const action =
        event.key === '1' || event.key === 'Enter'
          ? () => void k.decide('allow_once')
          : event.key === '2' && !noCheckpoint && overridable
            ? () => void k.decide('allow_project')
            : event.key === '3'
              ? k.openDeny
              : undefined
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, noCheckpoint, overridable])

  const title = noCheckpoint ? t('approval.ask.noCheckpoint') : t(`approval.ask.${kind}`)
  const verb = kind === 'command' ? 'run' : 'allow'
  const reason = t(`approval.reason.${approval.reasonCode}`, {
    defaultValue: t('approval.reason.unknown'),
  })

  return (
    <article
      aria-label={t('approval.title', { name: tool.name })}
      className="rounded-approval bg-raise p-4 shadow-2"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-heading text-fg">{title}</h3>
        <span className="shrink-0 font-mono text-note text-muted">{tool.name}</span>
      </div>
      {noCheckpoint && (
        <div className="mb-2 text-ui text-fg2">
          {t('approval.noCheckpoint', { name: tool.name })}
        </div>
      )}
      {preview?.command !== undefined ? (
        <pre className="mb-2 max-h-40 overflow-auto rounded-item bg-sunk px-3 py-2 font-mono text-[13px] whitespace-pre-wrap break-all text-fg">
          <span aria-hidden className="text-faint select-none">
            ${' '}
          </span>
          {preview.command}
        </pre>
      ) : preview?.diff !== undefined ? (
        <figure className="mb-2">
          <figcaption className="sr-only">{t('approval.diff')}</figcaption>
          <pre className="max-h-56 overflow-auto rounded-item bg-sunk px-3 py-2 font-mono text-[12.5px] whitespace-pre text-fg2">
            {preview.diff}
          </pre>
        </figure>
      ) : paths.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-1 rounded-item bg-sunk px-3 py-2 font-mono text-[13px] text-fg">
          {paths.map((path) => (
            <li key={path} className="break-all">
              {path}
            </li>
          ))}
        </ul>
      ) : (
        <figure className="mb-2">
          <figcaption className="sr-only">{t('approval.input')}</figcaption>
          <pre className="max-h-40 overflow-auto rounded-item bg-sunk px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap break-all text-fg2">
            {formatInput(approval.input)}
          </pre>
        </figure>
      )}
      {preview?.summary && preview.command === undefined && (
        <div className="mb-1 text-ui text-fg2">{preview.summary}</div>
      )}
      {sandbox && sandboxInfo && (
        <div
          data-testid="approval-sandbox"
          className="mb-3 flex flex-col gap-1.5 rounded-item bg-sunk px-3 py-2"
        >
          <SandboxBadge execution={sandbox} />
          {sandboxInfo.warning && (
            <p className={cn('text-note', sandbox.enforced ? 'text-muted' : 'text-danger')}>
              {sandboxInfo.warning}
            </p>
          )}
        </div>
      )}
      <div className="mb-3 text-note text-muted">
        {t('approval.reasonLabel')}: {reason}
      </div>
      <ol aria-label={t('approval.options')} className="-mx-1 flex flex-col">
        <Option
          index={1}
          hint={t('approval.key.enter')}
          disabled={busy}
          onSelect={() => void decide('allow_once')}
        >
          {noCheckpoint ? t('approval.option.continueOnce') : t(`approval.option.${verb}Once`)}
        </Option>
        {!noCheckpoint && overridable && (
          <Option index={2} disabled={busy} onSelect={() => void decide('allow_project')}>
            {t(`approval.option.${verb}Always`)}
            <span className="ml-1.5 text-note text-muted">{t('approval.scope.project')}</span>
          </Option>
        )}
        <Option index={3} hint={t('approval.key.esc')} disabled={busy} onSelect={openDeny}>
          {noCheckpoint ? t('approval.option.dontContinue') : t(`approval.option.${verb}Deny`)}
        </Option>
      </ol>
      {denying && (
        <form
          className={cn('mt-2 flex items-end gap-2')}
          onSubmit={(e) => {
            e.preventDefault()
            void decide('deny', feedback)
          }}
        >
          <textarea
            ref={field}
            rows={2}
            aria-label={t('approval.feedback')}
            placeholder={t('approval.feedbackPlaceholder')}
            value={feedback}
            maxLength={APPROVAL_FEEDBACK_MAX_LENGTH}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              void decide('deny', feedback)
            }}
            className="min-h-14 flex-1 resize-none rounded-item bg-sunk px-3 py-2 text-ui text-fg outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={busy}
            className="h-8 shrink-0 rounded-item bg-ink px-3 text-ui font-medium text-ink-fg hover:opacity-85 disabled:opacity-45"
          >
            {t('approval.submit')}
          </button>
        </form>
      )}
    </article>
  )
}

/** 当前会话的未决审批；没有时不显示。 */
export function ApprovalList() {
  const { t } = useTranslation('session')
  const all = useSessionStore((s) =>
    s.activeSessionId === undefined ? NONE : (s.approvals[s.activeSessionId] ?? NONE),
  )
  // 子运行的审批显示在对应的委派卡片里，避免同一个审批出现两次（M4-05）。
  const approvals = all.filter((approval) => approval.parentRunId === undefined)
  if (approvals.length === 0) return null
  return (
    <section aria-label={t('approval.region')} className="flex flex-col gap-3.5">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.approvalId}
          approval={approval}
          active={all[0]?.approvalId === approval.approvalId}
        />
      ))}
    </section>
  )
}
