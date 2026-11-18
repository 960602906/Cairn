// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReviewLoopView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import { ReviewLoopCard } from './ReviewLoopCard.js'

const i18n = createI18n('zh-CN')

const loop = (patch: Partial<ReviewLoopView> = {}): ReviewLoopView => ({
  reviewId: 'rv1',
  runId: 'r1',
  turnId: 't1',
  seq: 1,
  rounds: [],
  status: undefined,
  summary: undefined,
  ...patch,
})

afterEach(cleanup)

describe('ReviewLoopCard（M7-07）', () => {
  it('运行中显示进行状态与已完成的轮次', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ReviewLoopCard
          loop={loop({
            rounds: [
              {
                round: 1,
                makerRunId: 'maker-1',
                checkerRunId: 'checker-1',
                verdict: 'revise',
                feedback: '补充测试',
              },
            ],
          })}
        />
      </I18nextProvider>,
    )
    const card = screen.getByRole('region', { name: '审查循环' })
    expect(card.textContent).toContain('进行中')
    expect(card.textContent).toContain('1 轮')
    expect(card.textContent).toContain('第 1 轮')
    expect(card.textContent).toContain('需要修改')
    expect(card.textContent).toContain('补充测试')
  })

  it('通过后显示结局与摘要', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ReviewLoopCard
          loop={loop({
            rounds: [{ round: 1, makerRunId: 'm1', checkerRunId: 'c1', verdict: 'pass' }],
            status: 'passed',
            summary: '可以合并',
          })}
        />
      </I18nextProvider>,
    )
    const card = screen.getByRole('region', { name: '审查循环' })
    expect(card.textContent).toContain('已通过')
    expect(card.textContent).toContain('可以合并')
    expect(card.textContent).toContain('通过')
  })

  it.each([
    ['exhausted', '轮次用尽'],
    ['failed', '失败'],
    ['stopped', '已停止'],
    ['limit_reached', '触及限额'],
  ] as const)('结局 %s 显示为 %s', (status, text) => {
    render(
      <I18nextProvider i18n={i18n}>
        <ReviewLoopCard loop={loop({ status })} />
      </I18nextProvider>,
    )
    expect(screen.getByRole('region', { name: '审查循环' }).textContent).toContain(text)
  })
})
