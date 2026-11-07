// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@cairn/i18n'
import type { PlanView } from '@cairn/core'
import { PlanCard } from './PlanCard.js'

const i18n = createI18n('zh-CN')
const wrap = (ui: ReactNode) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

const plan: PlanView = {
  planId: 'pl1',
  content: {
    goal: '读代码',
    files: ['src/a.ts'],
    steps: [{ id: 'read', title: '读 src/a.ts' }],
    risks: '',
    verification: '单测通过',
    markdown: '1. 读代码',
  },
  steps: [{ id: 'read', title: '读 src/a.ts', status: 'pending' }],
  status: 'proposed',
  seq: 1,
  runId: 'r1',
  turnId: 't1',
}

afterEach(() => cleanup())

describe('PlanCard', () => {
  it('approves as written, or with edited step titles', async () => {
    const user = userEvent.setup()
    const onApprove = vi.fn()
    wrap(
      <PlanCard
        plan={plan}
        busy={false}
        onApprove={onApprove}
        onReplan={vi.fn()}
        onAbandon={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: '批准执行' }))
    expect(onApprove).toHaveBeenCalledWith(undefined)
    const title = screen.getByRole('textbox', { name: '步骤 1' })
    await user.clear(title)
    await user.type(title, '先读测试')
    await user.click(screen.getByRole('button', { name: '修改后批准' }))
    expect(onApprove).toHaveBeenLastCalledWith([{ id: 'read', title: '先读测试' }])
  })

  it('replans with a note and can abandon', async () => {
    const user = userEvent.setup()
    const onReplan = vi.fn()
    const onAbandon = vi.fn()
    wrap(
      <PlanCard
        plan={plan}
        busy={false}
        onApprove={vi.fn()}
        onReplan={onReplan}
        onAbandon={onAbandon}
      />,
    )
    await user.click(screen.getByRole('button', { name: '重新规划' }))
    await user.type(screen.getByRole('textbox', { name: '重新规划' }), '换个做法')
    await user.click(screen.getByRole('button', { name: '按说明重新规划' }))
    expect(onReplan).toHaveBeenCalledWith('换个做法')
    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '放弃' }))
    expect(onAbandon).toHaveBeenCalledOnce()
  })

  it('shows step progress and a deviation note after approval', () => {
    wrap(
      <PlanCard
        plan={{
          ...plan,
          status: 'approved',
          steps: [{ id: 'read', title: '读 src/a.ts', status: 'done', note: '改了测试' }],
        }}
        busy={false}
        onApprove={vi.fn()}
        onReplan={vi.fn()}
        onAbandon={vi.fn()}
      />,
    )
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('说明：改了测试')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '批准执行' })).toBeNull()
  })
})
