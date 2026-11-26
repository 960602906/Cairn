/**
 * 团队模板试运行（M7-09）：用当前草稿开一个隐藏会话，以主控 Agent 的草稿运行。
 * 面板本体与 Agent 试运行共用（`TrialPanel`），这里只负责按团队读取当前试运行与历史。
 *
 * 团队试运行没有 `trial.restart`：重新开始会创建一个新的隐藏会话，旧记录留在历史里。
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store-context.js'
import { TrialPanel, type TrialPanelHistoryEntry, type TrialPanelStart } from '../TrialPanel.js'

export function TeamTrial({
  teamId,
  configKey,
  open,
  onOpenChange,
}: {
  readonly teamId: string
  /** 打开面板时的草稿序列化；变化后提示重新开始。 */
  readonly configKey: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('teams')
  const trial = useSessionStore((s) => s.trial)
  const current = trial?.teamId === teamId ? trial : undefined
  const startTeamTrial = useSessionStore((s) => s.startTeamTrial)
  const listTeamTrials = useSessionStore((s) => s.listTeamTrials)
  const clearTeamTrials = useSessionStore((s) => s.clearTeamTrials)

  const start = useCallback(
    (input: TrialPanelStart) =>
      startTeamTrial({
        teamId,
        projectPath: input.projectPath,
        useAgentPermissions: input.useAgentPermissions,
        configKey: input.configKey,
      }),
    [startTeamTrial, teamId],
  )

  const listHistory = useCallback(async (): Promise<readonly TrialPanelHistoryEntry[]> => {
    const trials = await listTeamTrials(teamId)
    return (trials ?? []).map((item) => ({
      sessionId: item.sessionId,
      title: item.title,
      projectPath: item.projectPath,
      updatedAt: item.updatedAt,
    }))
  }, [listTeamTrials, teamId])

  const clearHistory = useCallback(() => clearTeamTrials(teamId), [clearTeamTrials, teamId])

  return (
    <TrialPanel
      open={open}
      onOpenChange={onOpenChange}
      title={t('trial.title')}
      intro={t('trial.intro')}
      current={current}
      configKey={configKey}
      start={start}
      restart={start}
      listHistory={listHistory}
      clearHistory={clearHistory}
    />
  )
}
