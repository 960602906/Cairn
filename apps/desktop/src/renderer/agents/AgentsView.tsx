/**
 * Agents 入口的页面壳（M3-12）：列表 ↔ 编辑器切换，处理“从空白开始 / 复制编程助手”的创建流程。
 */
import { useState, type ReactNode } from 'react'
import { BUILTIN_CODER_ID } from '@cairn/core'
import { useSessionStore } from '../store-context.js'
import { AgentEditor } from './AgentEditor.js'
import { AgentsPage } from './AgentsPage.js'

export function AgentsView({ leading }: { readonly leading?: ReactNode }) {
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
        <div className="drag flex h-10 shrink-0 items-center gap-1.5 pl-3">{leading}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentsPage onOpen={setOpen} onCreate={(mode) => void create(mode)} />
        </div>
      </>
    )
  }

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-1.5 pl-3">{leading}</div>
      <AgentEditor
        key={open}
        agentId={open === 'new' ? undefined : open}
        onBack={() => setOpen(undefined)}
        onOpenAgent={setOpen}
        onChanged={() => void refreshAgents({ includeArchived: true })}
      />
    </>
  )
}
