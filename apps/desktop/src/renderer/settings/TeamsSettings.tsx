/**
 * 设置页「团队模板」分区（M7-09）：列表 ↔ 编辑器切换，创建入口在设置页头部。
 *
 * 团队模板把一个主控 Agent、可委派的成员与协作模式打包；列表展示状态与版本，
 * 编辑器负责基本信息、成员、协作模式、校验、发布与试运行。
 */
import { Plus, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TeamEditor } from '../teams/TeamEditor.js'
import { TeamsPage } from '../teams/TeamsPage.js'
import { useSessionStore } from '../store-context.js'
import { Button } from '../ui/index.js'
import { SettingsHeader } from './SettingsPage.js'

export function TeamsSettings() {
  const { t } = useTranslation('settings')
  const { t: tt } = useTranslation('teams')
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  /** `undefined` 为列表；`'new'` 为空白草稿；其他为团队 id。 */
  const [open, setOpen] = useState<string | 'new' | undefined>(undefined)

  const create = async () => {
    // 新建草稿默认引用内置 Agent，先确保列表已读取。
    await refreshAgents({ includeArchived: true })
    setOpen('new')
  }

  if (open === undefined) {
    return (
      <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SettingsHeader
            icon={<UsersRound />}
            title={t('section.teams.title')}
            description={t('section.teams.description')}
          />
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button variant="primary" onClick={() => void create()}>
              <Plus />
              {tt('action.new')}
            </Button>
          </div>
        </div>
        <TeamsPage onOpen={setOpen} />
      </>
    )
  }

  return (
    <TeamEditor
      key={open}
      teamId={open === 'new' ? undefined : open}
      onBack={() => setOpen(undefined)}
      onChanged={() => undefined}
    />
  )
}
