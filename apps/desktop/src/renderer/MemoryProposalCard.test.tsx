// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import { createSessionView, reduceSession, type MessageView } from '@cairn/core'
import { createStore } from 'zustand/vanilla'
import { MemoryProposalList, shouldTuckMemoryProposal } from './MemoryProposalCard.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const proposalView = (ids: readonly string[], createdAt = 10) => {
  let view = createSessionView('s1')
  for (const [index, memoryId] of ids.entries()) {
    view = reduceSession(view, {
      v: 1,
      sessionId: 's1',
      runId: 'r1',
      seq: index + 1,
      ts: createdAt,
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
  messages: readonly MessageView[] = [],
) =>
  createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    views: { s1: { ...createSessionView('s1'), memoryProposals, messages } },
    resolveMemory,
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(cleanup)

describe('shouldTuckMemoryProposal', () => {
  const proposal = proposalView(['m1'], 100).memoryProposals[0]!

  it('stays expanded until the user sends a later message', () => {
    expect(shouldTuckMemoryProposal(proposal, [])).toBe(false)
    expect(
      shouldTuckMemoryProposal(proposal, [
        {
          role: 'user',
          messageId: 'u0',
          runId: 'r0',
          turnId: 't0',
          seq: 1,
          ts: 50,
          content: [{ type: 'text', text: 'earlier' }],
          mentions: [],
          skills: [],
          agents: [],
        },
      ]),
    ).toBe(false)
  })

  it('tucks after a later user message, ignoring goal auto-messages', () => {
    expect(
      shouldTuckMemoryProposal(proposal, [
        {
          role: 'user',
          messageId: 'u1',
          runId: 'r2',
          turnId: 't2',
          seq: 5,
          ts: 200,
          content: [{ type: 'text', text: 'follow up' }],
          mentions: [],
          skills: [],
          agents: [],
        },
      ]),
    ).toBe(true)
    expect(
      shouldTuckMemoryProposal(proposal, [
        {
          role: 'user',
          messageId: 'g1',
          runId: 'r2',
          turnId: 't2',
          seq: 5,
          ts: 200,
          origin: 'goal',
          goalId: 'goal-1',
          content: [{ type: 'text', text: 'auto' }],
          mentions: [],
          skills: [],
          agents: [],
        },
      ]),
    ).toBe(false)
  })
})

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
    expect(screen.getByText(/确认后会在之后的对话里/)).toBeTruthy()
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

  it('用户继续聊天后收成细条，仍可确认', async () => {
    const resolveMemory = vi.fn(async () => true)
    const followUp: MessageView = {
      role: 'user',
      messageId: 'u2',
      runId: 'r2',
      turnId: 't2',
      seq: 9,
      ts: 500,
      content: [{ type: 'text', text: '继续' }],
      mentions: [],
      skills: [],
      agents: [],
    }
    wrap(
      <MemoryProposalList />,
      makeStore(proposalView(['m1'], 10).memoryProposals, resolveMemory, [followUp]),
    )
    expect(screen.queryByText(/确认后会在之后的对话里/)).toBeNull()
    expect(screen.getByRole('button', { name: '展开记忆提议' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '记住' }))
    await waitFor(() => expect(resolveMemory).toHaveBeenCalledWith('m1', 'accept'))
  })
})
