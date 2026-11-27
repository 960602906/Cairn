/**
 * 设置页「Agents」分区：把原来侧栏顶部的 Agent 管理移到这里，沿用设置分区的标题与纸面排版。
 *
 * - 列表页头部只有「新建 Agent」与「从空白开始」两个入口：新建 Agent 直接复制内置编程助手并进入编辑器，
 *   一步到位，不再弹选择框；复制其他 Agent 走列表行进入编辑器后的「复制」。
 * - 列表与编辑器沿用 `agents/` 下的组件，只负责列表 ↔ 编辑器切换。
 */
import { Bot, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILTIN_CODER_ID } from '@cairn/core'
import { AgentEditor } from '../agents/AgentEditor.js'
import { AgentsPage } from '../agents/AgentsPage.js'
import { useSessionStore } from '../store-context.js'
import { Button } from '../ui/index.js'
import { SettingsHeader } from './SettingsPage.js'

export function AgentsSettings() {
  const { t } = useTranslation('settings')
  const { t: ta } = useTranslation('agents')
  const duplicateAgent = useSessionStore((s) => s.duplicateAgent)
  const refreshAgents = useSessionStore((s) => s.refreshAgents)
  /** `undefined` 为列表；`'new'` 为空白草稿；其他为 Agent id。 */
  const [open, setOpen] = useState<string | 'new' | undefined>(undefined)

  const create = async (mode: 'blank' | 'copy') => {
    if (mode === 'blank') {
      setOpen('new')
      return
    }
    const created = await duplicateAgent(BUILTIN_CODER_ID)
    await refreshAgents({ includeArchived: true })
    setOpen(created?.agentId ?? 'new')
  }

  if (open === undefined) {
    return (
      <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SettingsHeader
            icon={<Bot />}
            title={t('section.agents.title')}
            description={t('section.agents.description')}
          />
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button variant="ghost" onClick={() => void create('blank')}>
              {ta('new.blank')}
            </Button>
            <Button variant="primary" onClick={() => void create('copy')}>
              <Plus />
              {ta('action.new')}
            </Button>
          </div>
        </div>
        <AgentsPage onOpen={setOpen} />
      </>
    )
  }

  return (
    <AgentEditor
      key={open}
      agentId={open === 'new' ? undefined : open}
      onBack={() => setOpen(undefined)}
      onOpenAgent={setOpen}
      onChanged={() => void refreshAgents({ includeArchived: true })}
    />
  )
}
