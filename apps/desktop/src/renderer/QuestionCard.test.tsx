// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { PendingQuestion } from '@cairn/protocol'
import { createStore } from 'zustand/vanilla'
import { QuestionCard, QuestionList } from './QuestionCard.js'
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

  it('picks an option with the number keys and ignores keys while typing', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))

    // 正在输入框里打字时不响应数字键
    await userEvent.type(screen.getByRole('textbox'), '2')
    expect(resolveQuestion).not.toHaveBeenCalled()
    // 超出选项数量的数字忽略
    ;(screen.getByRole('textbox') as HTMLInputElement).blur()
    await userEvent.keyboard('9')
    expect(resolveQuestion).not.toHaveBeenCalled()
    // 数字键选中后立即提交单选题
    await userEvent.keyboard('2')
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', {
      answers: [{ questionId: 'q1', selected: ['方案 B'] }],
    })
  })

  it('submits a typed answer with Enter once focus leaves the input', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    const input = screen.getByRole('textbox')
    await userEvent.type(input, '两个都要')
    ;(input as HTMLInputElement).blur()
    await userEvent.keyboard('{Enter}')
    expect(resolveQuestion).toHaveBeenCalledWith('call-1', {
      answers: [{ questionId: 'q1', selected: [], custom: '两个都要' }],
    })
  })

  it('does nothing on Enter before the question is answered', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    await userEvent.keyboard('{Enter}')
    expect(resolveQuestion).not.toHaveBeenCalled()
  })

  it('ignores a second answer while the first one is still being sent', async () => {
    let release!: (value: boolean) => void
    const resolveQuestion = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion as never))
    await userEvent.click(screen.getByRole('button', { name: /方案 A/ }))
    // 提交中按数字键不会重复提交
    await userEvent.keyboard('2')
    expect(resolveQuestion).toHaveBeenCalledTimes(1)
    release(true)
  })

  it('ignores the number keys while a dialog is open or when inactive', async () => {
    const resolveQuestion = vi.fn(async () => true)
    const view = wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    await userEvent.keyboard('1')
    dialog.remove()
    expect(resolveQuestion).not.toHaveBeenCalled()
    view.unmount()

    wrap(<QuestionCard question={single} active={false} />, makeStore(resolveQuestion))
    await userEvent.keyboard('1')
    expect(resolveQuestion).not.toHaveBeenCalled()
  })

  it('toggles a multi-select option off and keeps a custom answer', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={multiple} active />, makeStore(resolveQuestion))
    const first = screen.getByRole('button', { name: /a\.ts/ })
    await userEvent.click(first)
    expect(first.getAttribute('aria-pressed')).toBe('true')
    await userEvent.type(screen.getByRole('textbox'), '也看看 c.ts')
    await userEvent.click(first)
    expect(first.getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(screen.getByRole('button', { name: /b\.ts/ }))
    await userEvent.click(screen.getByRole('button', { name: '下一个' }))
    await userEvent.type(screen.getByRole('textbox'), '跑单测')
    await userEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(resolveQuestion).toHaveBeenCalledWith('call-2', {
      answers: [
        { questionId: 'q1', selected: ['b.ts'], custom: '也看看 c.ts' },
        { questionId: 'q2', selected: [], custom: '跑单测' },
      ],
    })
  })

  it('clears the picked option when a custom answer is typed for a single choice', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    const option = screen.getByRole('button', { name: /方案 A/ })
    await userEvent.click(option)
    expect(resolveQuestion).toHaveBeenCalledTimes(1)
    resolveQuestion.mockClear()
    // 重新渲染一份同样的卡片，改走「先选后打字」的路径
    cleanup()
    wrap(<QuestionCard question={single} active={false} />, makeStore(resolveQuestion))
    const picked = screen.getByRole('button', { name: /方案 A/ })
    await userEvent.click(picked)
    expect(picked.getAttribute('aria-pressed')).toBe('true')
    await userEvent.type(screen.getByRole('textbox'), '都不对')
    expect(picked.getAttribute('aria-pressed')).toBe('false')
  })

  it('advances with Enter inside the custom input and submits on the last question', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={multiple} active />, makeStore(resolveQuestion))
    await userEvent.type(screen.getByRole('textbox'), '两个文件')
    await userEvent.keyboard('{Enter}')
    // 第一题的自定义回答已记下，第二个问题出现
    expect(screen.getByText('怎么验证？')).toBeTruthy()
    await userEvent.type(screen.getByRole('textbox'), '跑单测')
    await userEvent.keyboard('{Enter}')
    expect(resolveQuestion).toHaveBeenCalledWith('call-2', {
      answers: [
        { questionId: 'q1', selected: [], custom: '两个文件' },
        { questionId: 'q2', selected: [], custom: '跑单测' },
      ],
    })
  })

  it('shows the plain placeholder when no option is recommended', () => {
    wrap(<QuestionCard question={multiple} active />)
    expect(screen.getByPlaceholderText('输入你的回答…')).toBeTruthy()
    expect(screen.getByText('可多选')).toBeTruthy()
  })

  it('ignores number keys with modifiers and while an IME is composing', () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={single} active />, makeStore(resolveQuestion))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', isComposing: true }))
    expect(resolveQuestion).not.toHaveBeenCalled()
  })

  it('does not advance from an unanswered question', async () => {
    const resolveQuestion = vi.fn(async () => true)
    wrap(<QuestionCard question={multiple} active />, makeStore(resolveQuestion))
    await userEvent.click(screen.getByRole('textbox'))
    await userEvent.keyboard('{Enter}')
    expect(screen.getByText('要改哪些文件？')).toBeTruthy()
    expect(resolveQuestion).not.toHaveBeenCalled()
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

describe('QuestionList', () => {
  const store = (overrides: Record<string, unknown> = {}) =>
    createStore<Record<string, unknown>>(() => ({
      activeSessionId: 's1',
      resolveQuestion: vi.fn(async () => true),
      questions: {},
      ...overrides,
    })) as unknown as SessionStore

  it('shows the pending questions of the active session', () => {
    wrap(<QuestionList />, store({ questions: { s1: [single] } }))
    expect(screen.getByRole('region', { name: '需要你回答' })).toBeTruthy()
    expect(screen.getByText('用哪种方案？')).toBeTruthy()
  })

  it('renders nothing without a session or without questions', () => {
    wrap(<QuestionList />, store({ activeSessionId: undefined, questions: { s1: [single] } }))
    expect(screen.queryByRole('region', { name: '需要你回答' })).toBeNull()
    cleanup()
    wrap(<QuestionList />, store())
    expect(screen.queryByRole('region', { name: '需要你回答' })).toBeNull()
  })
})
