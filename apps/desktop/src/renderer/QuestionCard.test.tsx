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
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', {
      answers: [{ questionId: 'q1', selected: ['方案 B'] }],
    })
  })

  it('uses a custom answer as the only answer', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    await userEvent.type(screen.getByPlaceholderText(/推荐：方案 A/), '两个都要')
    await userEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', {
      answers: [{ questionId: 'q1', selected: [], custom: '两个都要' }],
    })
  })

  it('cancels the whole question without answers', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', { cancelled: true })
  })

  it('walks through questions one at a time and can go back', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={multiple} active />, makeStore(resolveQuestion))

    // 第一个问题：没有回答时不能前进
    expect(screen.getByText('要改哪些文件？')).toBeTruthy()
    expect(screen.queryByText('怎么验证？')).toBeNull()
    const next = screen.getByRole('button', { name: '下一个' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '上一个' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /a\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: /b\.ts/ }))
    expect((next as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(next)

    // 第二个问题：自定义回答后提交；可以退回第一个问题
    expect(screen.getByText('怎么验证？')).toBeTruthy()
    expect(screen.queryByText('要改哪些文件？')).toBeNull()
    await userEvent.type(screen.getAllByRole('textbox')[0]!, '再看 CI')
    await userEvent.click(screen.getByRole('button', { name: '上一个' }))
    expect(screen.getByText('要改哪些文件？')).toBeTruthy()
    expect(screen.getByRole('button', { name: /a\.ts/ }).getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: '下一个' }))

    await userEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(resolveQuestion).toHaveBeenCalledWith('call-2', {
      answers: [
        { questionId: 'q1', selected: ['a.ts', 'b.ts'] },
        { questionId: 'q2', selected: [], custom: '再看 CI' },
      ],
    })
  })
})
