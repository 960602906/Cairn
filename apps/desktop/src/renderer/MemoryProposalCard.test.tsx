// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { createSessionView, reduceSession } from '@cairn/core'
import { createStore } from 'zustand/vanilla'
import { MemoryProposalList } from './MemoryProposalCard.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const proposalView = (ids: readonly string[]) => {
  let view = createSessionView('s1')
  for (const [index, memoryId] of ids.entries()) {
    view = reduceSession(view, {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      seq: index + 1,
      ts: 10,
      type: 'memory.proposed',
      payload: {
        memoryId,
        scope: 'project',
        content: '提交信息用中文',
        sourceAgentId: 'builtin.coder',
      },
    })
  }
  return view
}

const makeStore = (
  memoryProposals = proposalView(['m1']).memoryProposals,
  resolveMemory = vi.fn(async () => true),
) =>
  createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    views: { s1: { ...createSessionView('s1'), memoryProposals } },
    resolveMemory,
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(cleanup)

describe('MemoryProposalList（M7-03）', () => {
  it('没有提议时什么都不渲染', () => {
    const { container } = wrap(<MemoryProposalList />, makeStore([]))
    expect(container.innerHTML).toBe('')
  })

  it('显示正文与范围，确认时把 memoryId 交给 store', async () => {
    const resolveMemory = vi.fn(async () => true)
    wrap(<MemoryProposalList />, makeStore(proposalView(['m1']).memoryProposals, resolveMemory))
    expect(screen.getByText('提交信息用中文')).toBeTruthy()
    expect(screen.getByText('本项目')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '记住' }))
    await waitFor(() => expect(resolveMemory).toHaveBeenCalledWith('m1', 'accept'))
  })

  it('忽略时传 reject', async () => {
    const resolveMemory = vi.fn(async () => true)
    wrap(<MemoryProposalList />, makeStore(proposalView(['m1']).memoryProposals, resolveMemory))
    await userEvent.click(screen.getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(resolveMemory).toHaveBeenCalledWith('m1', 'reject'))
  })

  it('多条提议逐条处理', async () => {
    const resolveMemory = vi.fn(async () => true)
    wrap(
      <MemoryProposalList />,
      makeStore(proposalView(['m1', 'm2']).memoryProposals, resolveMemory),
    )
    expect(screen.getAllByText('提交信息用中文')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '记住' })).toHaveLength(2)
  })
})
