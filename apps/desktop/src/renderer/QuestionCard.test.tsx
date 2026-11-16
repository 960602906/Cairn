// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { PendingQuestion } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { QuestionCard } from './QuestionCard.js'
import type { SessionStore } from './session-store.js'
import { SessionStoreProvider } from './store-context.js'

const i18n = createI18n('zh-CN')

const single: PendingQuestion = {
  questionId: 'call-1',
  toolCallId: 'call-1',
  questions: [
    {
      id: 'q1',
      question: '用哪种方案？',
      options: [{ label: '方案 A', description: '改动小', recommended: true }, { label: '方案 B' }],
    },
  ],
}

const multiple: PendingQuestion = {
  questionId: 'call-2',
  toolCallId: 'call-2',
  questions: [
    {
      id: 'q1',
      question: '要改哪些文件？',
      multiple: true,
      options: [{ label: 'a.ts' }, { label: 'b.ts' }],
    },
    {
      id: 'q2',
      question: '怎么验证？',
      options: [{ label: '跑单测', recommended: true }, { label: '手测' }],
    },
  ],
}

const makeStore = (resolveQuestion = vi.fn(async () => true)) =>
  createStore<Record<string, unknown>>(() => ({
    activeSessionId: 's1',
    resolveQuestion,
  })) as unknown as SessionStore

const wrap = (ui: ReactNode, store = makeStore()) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SessionStoreProvider store={store}>{ui}</SessionStoreProvider>
    </I18nextProvider>,
  )

afterEach(cleanup)

describe('QuestionCard', () => {
  it('shows the question, options and the recommended mark', () => {
    wrap(<QuestionCard question={single} active />)
    expect(screen.getByText('用哪种方案？')).toBeTruthy()
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('改动小')).toBeTruthy()
    expect(screen.getByRole('button', { name: /方案 A/ })).toBeTruthy()
  })

  it('submits immediately when a single question has one answer', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    await userEvent.click(screen.getByRole('button', { name: /方案 B/ }))
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', [
      { questionId: 'q1', selected: ['方案 B'] },
    ])
  })

  it('collects selections and a custom answer before submitting', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={multiple} active />, makeStore(resolveQuestion))
    const submit = screen.getByRole('button', { name: '提交' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: /a\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: /b\.ts/ }))
    await userEvent.type(screen.getAllByRole('textbox')[1]!, '再看 CI')
    expect((submit as HTMLButtonElement).disabled).toBe(false)

    await userEvent.click(submit)
    expect(resolveQuestion).toHaveBeenCalledWith('call-2', [
      { questionId: 'q1', selected: ['a.ts', 'b.ts'] },
      { questionId: 'q2', selected: [], custom: '再看 CI' },
    ])
  })

  it('uses a custom answer as the only answer', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    await userEvent.type(screen.getByPlaceholderText(/推荐：方案 A/), '两个都要')
    await userEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', [
      { questionId: 'q1', selected: [], custom: '两个都要' },
    ])
  })
})
