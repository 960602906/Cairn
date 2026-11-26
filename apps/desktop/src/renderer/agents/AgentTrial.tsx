/**
 * Agent 试运行（M4-12，管理界面 §6）：用当前草稿开一次隐藏会话，默认只读；
 * 切到 Agent 自己的权限会重启试运行。面板本体与团队模板共用（`TrialPanel`），
 * 这里只负责按 Agent 读取当前试运行与历史。
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store-context.js'
import { TrialPanel, type TrialPanelHistoryEntry, type TrialPanelStart } from '../TrialPanel.js'

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
  const current = trial?.teamId === undefined && trial?.agent.id === agentId ? trial : undefined
  const startTrial = useSessionStore((s) => s.startTrial)
  const restartTrial = useSessionStore((s) => s.restartTrial)
  const listTrials = useSessionStore((s) => s.listTrials)
  const clearTrials = useSessionStore((s) => s.clearTrials)

  const start = useCallback(
    (input: TrialPanelStart) =>
      startTrial({
        agentId,
        projectPath: input.projectPath,
        useAgentPermissions: input.useAgentPermissions,
        configKey: input.configKey,
      }),
    [agentId, startTrial],
  )

  const restart = useCallback(
    (input: TrialPanelStart) => restartTrial(input.useAgentPermissions, input.configKey),
    [restartTrial],
  )

  const listHistory = useCallback(async (): Promise<readonly TrialPanelHistoryEntry[]> => {
    const trials = await listTrials(agentId)
    return (trials ?? []).map((item) => ({
      sessionId: item.sessionId,
      title: item.title,
      projectPath: item.projectPath,
      updatedAt: item.updatedAt,
    }))
  }, [agentId, listTrials])

  const clearHistory = useCallback(() => clearTrials(agentId), [agentId, clearTrials])

  return (
    <TrialPanel
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      intro={t('intro')}
      current={current}
      configKey={configKey}
      start={start}
      restart={restart}
      listHistory={listHistory}
      clearHistory={clearHistory}
    />
  )
}
