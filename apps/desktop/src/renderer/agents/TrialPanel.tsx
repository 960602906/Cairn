/**
 * Agent 试运行面板（M4-12，管理界面 §6）。
 *
 * 右侧与编辑器并排显示，使用当前草稿创建一个隐藏会话。面板复用消息流展示正文、推理与工具调用，
 * 审批使用同一个卡片；默认只读，用户可切换为 Agent 自身的权限。
 */
import { Play, RotateCw, Square, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionStatus } from '@cairn/core'
import type { ApprovalDecision } from '@cairn/protocol'
import { ApprovalCard } from '../ApprovalCard.js'
import { MessageStream } from '../MessageStream.js'
import { useSessionStore } from '../store-context.js'
import { Button, IconButton, Spinner, cn } from '../ui/index.js'

export interface TrialPanelProps {
  readonly agentId: string
  readonly agentName: string
  /** 编辑器当前草稿的稳定序列化，用于提示配置已变化。 */
  readonly draftKey: string
  /** 草稿有未保存修改时，开始或重启前保存；失败时返回 false。 */
  readonly saveDraft?: (() => Promise<boolean>) | undefined
  readonly onClose: () => void
}

const NONE = [] as const

export function TrialPanel({ agentId, agentName, draftKey, saveDraft, onClose }: TrialPanelProps) {
  const { t } = useTranslation('trial')
  const trial = useSessionStore((s) => s.trial)
  const projects = useSessionStore((s) => s.projects)
  const view = useSessionStore((s) => (trial ? s.views[trial.sessionId] : undefined))
  const approvals = useSessionStore((s) => (trial ? (s.approvals[trial.sessionId] ?? NONE) : NONE))
  const awaiting = useSessionStore((s) =>
    trial ? s.awaitingTurn[trial.sessionId] === true : false,
  )
  const startTrial = useSessionStore((s) => s.startTrial)
  const restartTrial = useSessionStore((s) => s.restartTrial)
  const sendTrialPrompt = useSessionStore((s) => s.sendTrialPrompt)
  const abortTrial = useSessionStore((s) => s.abortTrial)
  const resolveTrialApproval = useSessionStore((s) => s.resolveTrialApproval)
  const closeTrial = useSessionStore((s) => s.closeTrial)
  const clearTrials = useSessionStore((s) => s.clearTrials)
  const openProject = useSessionStore((s) => s.openProject)

  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '')
  const [useAgentPermissions, setUseAgentPermissions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [cleared, setCleared] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (trial) setUseAgentPermissions(trial.useAgentPermissions)
  }, [trial])

  useEffect(() => {
    if (projectPath === '' && projects[0]) setProjectPath(projects[0].path)
  }, [projectPath, projects])

  useEffect(
    () => () => {
      void closeTrial()
    },
    [closeTrial],
  )

  const configChanged = trial !== undefined && trial.configKey !== draftKey
  const status = awaiting ? 'running' : view ? sessionStatus(view) : 'idle'
  const running = status === 'running' || status === 'waiting_approval'
  const canSend = draft.trim() !== '' && !running && trial !== undefined

  const prepare = async (): Promise<boolean> => {
    if (!saveDraft) return true
    return saveDraft()
  }

  const start = async () => {
    if (!projectPath || busy) return
    setBusy(true)
    const saved = await prepare()
    if (saved) {
      await startTrial({
        agentId,
        projectPath,
        useAgentPermissions,
        configKey: draftKey,
      })
    }
    setBusy(false)
  }

  const restart = async (nextPermissions = useAgentPermissions) => {
    if (busy) return
    setBusy(true)
    const saved = await prepare()
    if (saved) {
      const restarted = await restartTrial(nextPermissions, draftKey)
      if (!restarted) setUseAgentPermissions(trial?.useAgentPermissions ?? false)
    } else {
      setUseAgentPermissions(trial?.useAgentPermissions ?? false)
    }
    setBusy(false)
  }

  const togglePermissions = async (next: boolean) => {
    setUseAgentPermissions(next)
    if (trial) await restart(next)
  }

  const send = async () => {
    if (!canSend) return
    const text = draft
    setDraft('')
    const sent = await sendTrialPrompt(text)
    if (!sent) setDraft(text)
  }

  const clear = async () => {
    if (busy) return
    setBusy(true)
    if (trial) await closeTrial()
    const count = await clearTrials(agentId)
    setCleared(count)
    setBusy(false)
  }

  const close = async () => {
    if (trial) await closeTrial()
    onClose()
  }

  const projectOptions = useMemo(
    () => projects.map((project) => ({ id: project.projectId, path: project.path })),
    [projects],
  )

  return (
    <aside
      aria-label={t('title')}
      className="flex min-h-0 w-[min(440px,42vw)] shrink-0 flex-col border-l-[0.5px] border-hair bg-paper"
    >
      <header className="flex items-center gap-2 border-b-[0.5px] border-hair px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-ui font-medium text-fg">{t('title')}</h3>
          <p className="truncate text-note text-muted">{agentName}</p>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11.5px]',
            running ? 'bg-accent-soft text-accent' : 'bg-sunk text-muted',
          )}
        >
          {t(`status.${running ? 'running' : 'idle'}`)}
        </span>
        <IconButton label={t('action.close')} size="sm" onClick={() => void close()}>
          <X />
        </IconButton>
      </header>

      {!trial ? (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          <p className="text-note text-muted">{t('intro')}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-note font-medium text-fg2">{t('project.label')}</span>
            <select
              aria-label={t('project.label')}
              className="h-8 rounded-item border-[0.5px] border-hair bg-raise px-2 text-ui text-fg"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            >
              <option value="">{t('project.placeholder')}</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.path}>
                  {project.path}
                </option>
              ))}
            </select>
          </label>
          {projects.length === 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const project = await openProject()
                if (project) setProjectPath(project.path)
              }}
            >
              {t('project.open')}
            </Button>
          )}
          <label className="flex items-start gap-2 text-note text-fg2">
            <input
              type="checkbox"
              checked={useAgentPermissions}
              onChange={(event) => setUseAgentPermissions(event.target.checked)}
            />
            <span>
              <span className="block font-medium">{t('permissions.useAgent')}</span>
              <span className="block text-muted">{t('permissions.hint')}</span>
            </span>
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || projectPath === ''}
            onClick={() => void start()}
          >
            {busy ? <Spinner /> : <Play />}
            {t('action.start')}
          </Button>
          {cleared !== undefined && (
            <p role="status" className="text-note text-muted">
              {t('cleared', { count: cleared })}
            </p>
          )}
        </div>
      ) : (
        <>
          {configChanged && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 border-b-[0.5px] border-warn/30 bg-warn-soft px-4 py-2 text-note text-warn"
            >
              <span className="min-w-0 flex-1">{t('configChanged')}</span>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void restart()}>
                <RotateCw />
                {t('action.restart')}
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
            <MessageStream
              view={view}
              sessionId={trial.sessionId}
              onContinue={(prompt) => void sendTrialPrompt(prompt)}
            />
            {approvals.length > 0 && (
              <section aria-label={t('approvals')} className="mt-4 flex flex-col gap-3">
                {approvals.map((approval, index) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    active={index === 0}
                    onResolve={(
                      approvalId: string,
                      decision: ApprovalDecision,
                      feedback?: string,
                    ) => resolveTrialApproval(approvalId, decision, feedback)}
                  />
                ))}
              </section>
            )}
          </div>
          <footer className="border-t-[0.5px] border-hair p-3">
            <textarea
              aria-label={t('input.label')}
              className="min-h-20 w-full resize-y rounded-item border-[0.5px] border-hair bg-raise px-3 py-2 text-ui text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent"
              placeholder={t('input.placeholder')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-note text-fg2">
                <input
                  type="checkbox"
                  checked={useAgentPermissions}
                  onChange={(event) => void togglePermissions(event.target.checked)}
                />
                <span className="truncate">{t('permissions.useAgent')}</span>
              </label>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clear()}>
                <Trash2 />
                {t('action.clear')}
              </Button>
              {running ? (
                <Button variant="secondary" size="sm" onClick={() => void abortTrial()}>
                  <Square />
                  {t('action.stop')}
                </Button>
              ) : (
                <Button variant="primary" size="sm" disabled={!canSend} onClick={() => void send()}>
                  {t('action.send')}
                </Button>
              )}
            </div>
          </footer>
        </>
      )}
    </aside>
  )
}
