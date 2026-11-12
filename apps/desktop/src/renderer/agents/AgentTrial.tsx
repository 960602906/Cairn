/**
 * Agent 试运行面板（M4-12，管理界面 §6）：用当前草稿开一次隐藏会话，默认只读；
 * 切到 Agent 自己的权限会重启试运行。面板里能看消息、处理审批、查看与清除历史。
 *
 * 试运行读取的是已保存的草稿，所以编辑器在打开前会先保存改动；`configKey` 是打开时的
 * 草稿序列化，之后草稿再变就提示重启。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PendingApproval, TrialSummary } from '@cairn/protocol'
import { ApprovalCard } from '../ApprovalCard.js'
import { MessageStream } from '../MessageStream.js'
import { inputClass } from '../settings/Field.js'
import { useSessionStore } from '../store-context.js'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Switch,
  cn,
} from '../ui/index.js'

const NONE_APPROVALS: readonly PendingApproval[] = []
const NONE_HISTORY: readonly TrialSummary[] = []

/** 历史行的时间：用本地时间显示，测试里按内容匹配。 */
export function trialTime(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AgentTrial({
  agentId,
  configKey,
  open,
  onOpenChange,
}: {
  readonly agentId: string
  /** 打开面板时的草稿序列化；变化后提示重启。 */
  readonly configKey: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('trial')
  const trial = useSessionStore((s) => s.trial)
  const current = trial?.agent.id === agentId ? trial : undefined
  const view = useSessionStore((s) => (current ? s.views[current.sessionId] : undefined))
  const running = useSessionStore((s) =>
    current ? s.awaitingTurn[current.sessionId] === true : false,
  )
  const approvals = useSessionStore((s) =>
    current ? (s.approvals[current.sessionId] ?? NONE_APPROVALS) : NONE_APPROVALS,
  )
  const projects = useSessionStore((s) => s.projects)
  const startTrial = useSessionStore((s) => s.startTrial)
  const restartTrial = useSessionStore((s) => s.restartTrial)
  const sendTrialPrompt = useSessionStore((s) => s.sendTrialPrompt)
  const abortTrial = useSessionStore((s) => s.abortTrial)
  const resolveApproval = useSessionStore((s) => s.resolveTrialApproval)
  const closeTrial = useSessionStore((s) => s.closeTrial)
  const listTrials = useSessionStore((s) => s.listTrials)
  const clearTrials = useSessionStore((s) => s.clearTrials)
  const openProject = useSessionStore((s) => s.openProject)
  const [projectPath, setProjectPath] = useState(current?.projectPath ?? projects[0]?.path ?? '')
  const [useAgentPermissions, setUseAgentPermissions] = useState(
    current?.useAgentPermissions ?? false,
  )
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<readonly TrialSummary[]>(NONE_HISTORY)
  const [notice, setNotice] = useState<string | undefined>()

  // 打开时同步一次已存在的试运行状态，并读取历史；换会话后重新读取。
  useEffect(() => {
    if (!open) return
    setProjectPath((path) => current?.projectPath ?? path)
    setUseAgentPermissions((on) => current?.useAgentPermissions ?? on)
  }, [open, current?.projectPath, current?.useAgentPermissions])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listTrials(agentId).then((list) => {
      if (!cancelled) setHistory(list ?? NONE_HISTORY)
    })
    return () => {
      cancelled = true
    }
  }, [agentId, listTrials, open, current?.sessionId])

  const close = async () => {
    await closeTrial()
    onOpenChange(false)
  }

  const start = async () => {
    const path = projectPath.trim()
    if (path === '' || busy) return
    setBusy(true)
    setNotice(undefined)
    await startTrial({ agentId, projectPath: path, useAgentPermissions, configKey })
    setBusy(false)
  }

  const restart = async () => {
    if (busy) return
    setBusy(true)
    await restartTrial(useAgentPermissions, configKey)
    setBusy(false)
  }

  const togglePermissions = (on: boolean) => {
    setUseAgentPermissions(on)
    // 权限模式是会话级的：试运行中修改会重启，没有试运行时就等下次开始。
    if (current) void restartTrial(on, configKey)
  }

  const send = async () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    const sent = await sendTrialPrompt(text)
    setBusy(false)
    if (sent) setText('')
  }

  const chooseProject = async () => {
    const project = await openProject()
    if (project) setProjectPath(project.path)
  }

  const clear = async () => {
    if (busy) return
    setBusy(true)
    const cleared = await clearTrials(agentId)
    setBusy(false)
    if (cleared !== undefined) {
      setNotice(t('cleared', { count: cleared }))
      setHistory(NONE_HISTORY)
    }
  }

  const changed = current !== undefined && current.configKey !== configKey

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void close()
      }}
    >
      <DialogContent className="flex h-[min(720px,calc(100vh-64px))] w-[min(920px,calc(100vw-48px))] flex-col gap-0 p-0">
        <header className="flex shrink-0 items-center gap-2 border-b-[0.5px] border-hair px-5 py-3">
          <DialogTitle className="text-ui font-medium text-fg">{t('title')}</DialogTitle>
          {current && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11.5px]',
                running ? 'bg-accent-soft text-accent' : 'bg-sunk text-muted',
              )}
            >
              {running ? t('status.running') : t('status.idle')}
            </span>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void close()}>
            {t('action.close')}
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
              <DialogDescription className="text-note leading-relaxed text-muted">
                {t('intro')}
              </DialogDescription>

              <label className="block">
                <span className="mb-1 block text-[13px] text-fg2">{t('project.label')}</span>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={t('project.label')}
                    className={inputClass}
                    value={projectPath}
                    disabled={current !== undefined}
                    onChange={(e) => setProjectPath(e.target.value)}
                  >
                    <option value="">{t('project.placeholder')}</option>
                    {projects.map((project) => (
                      <option key={project.projectId} value={project.path}>
                        {project.name} · {project.path}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={current !== undefined}
                    onClick={() => void chooseProject()}
                  >
                    {t('project.open')}
                  </Button>
                </div>
              </label>

              <div className="flex items-start justify-between gap-4 rounded-card bg-raise px-3.5 py-3 shadow-hair2">
                <span>
                  <span className="block text-ui text-fg">{t('permissions.useAgent')}</span>
                  <span className="mt-0.5 block text-note text-muted">{t('permissions.hint')}</span>
                </span>
                <Switch
                  aria-label={t('permissions.useAgent')}
                  checked={useAgentPermissions}
                  onCheckedChange={togglePermissions}
                />
              </div>

              {changed && (
                <div className="flex flex-wrap items-center gap-2 rounded-card bg-warn-soft px-3.5 py-2.5 text-note text-warn">
                  <span className="min-w-0 flex-1">{t('configChanged')}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void restart()}
                  >
                    {t('action.restart')}
                  </Button>
                </div>
              )}

              {current ? (
                <div className="flex flex-col gap-3">
                  <MessageStream view={view} sessionId={current.sessionId} />
                  {approvals.length > 0 && (
                    <section aria-label={t('approvals')} className="flex flex-col gap-3.5">
                      <h3 className="text-ui font-medium text-fg">{t('approvals')}</h3>
                      {approvals.map((approval) => (
                        <ApprovalCard
                          key={approval.approvalId}
                          approval={approval}
                          active={approvals[0]?.approvalId === approval.approvalId}
                          onResolve={resolveApproval}
                        />
                      ))}
                    </section>
                  )}
                </div>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy || projectPath.trim() === ''}
                  onClick={() => void start()}
                >
                  {t('action.start')}
                </Button>
              )}
            </div>

            {current && (
              <div className="flex shrink-0 items-end gap-2 border-t-[0.5px] border-hair px-5 py-3">
                <textarea
                  aria-label={t('input.label')}
                  placeholder={t('input.placeholder')}
                  rows={2}
                  className={`${inputClass} min-h-16 resize-none`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
                    e.preventDefault()
                    void send()
                  }}
                />
                {running && (
                  <Button variant="secondary" onClick={() => void abortTrial()}>
                    {t('action.stop')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  disabled={busy || text.trim() === ''}
                  onClick={() => void send()}
                >
                  {t('action.send')}
                </Button>
              </div>
            )}
          </div>

          <aside
            aria-label={t('title')}
            className="flex w-[250px] shrink-0 flex-col gap-2 overflow-y-auto border-l-[0.5px] border-hair px-4 py-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-fg">{t('history.title')}</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clear()}>
                {t('action.clear')}
              </Button>
            </div>
            {notice && <p className="text-note text-muted">{notice}</p>}
            {history.length === 0 ? (
              <p className="text-note text-muted">{t('history.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {history.map((item) => (
                  <li
                    key={item.sessionId}
                    className="rounded-item bg-raise px-2.5 py-2 text-note shadow-hair2"
                  >
                    <span className="block truncate text-[12.5px] text-fg">{item.title}</span>
                    <span className="tabular mt-0.5 block truncate text-[11.5px] text-faint">
                      {trialTime(item.updatedAt)} · {item.projectPath}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
