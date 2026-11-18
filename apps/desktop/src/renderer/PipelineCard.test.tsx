// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineView } from '@cairn/core'
import { createI18n } from '@cairn/i18n'
import { PipelineCard } from './PipelineCard.js'

const i18n = createI18n('zh-CN')

const pipeline = (patch: Partial<PipelineView> = {}): PipelineView => ({
  pipelineId: 'pl1',
  runId: 'r1',
  turnId: 't1',
  seq: 1,
  stages: [],
  status: undefined,
  skipped: [],
  summary: undefined,
  ...patch,
})

afterEach(cleanup)

describe('PipelineCard（M7-08）', () => {
  it('运行中显示进度与已完成阶段', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineCard
          pipeline={pipeline({
            stages: [
              { stage: 'build', agentRunId: 'run-build', status: 'completed', summary: '构建完成' },
            ],
          })}
        />
      </I18nextProvider>,
    )
    const card = screen.getByRole('region', { name: '流水线' })
    expect(card.textContent).toContain('进行中')
    expect(card.textContent).toContain('1/1 阶段')
    expect(card.textContent).toContain('build')
    expect(card.textContent).toContain('构建完成')
  })

  it('失败后显示跳过项与失败原因', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineCard
          pipeline={pipeline({
            stages: [
              { stage: 'build', agentRunId: 'run-build', status: 'completed', summary: '构建完成' },
              { stage: 'check', agentRunId: 'run-check', status: 'failed', summary: '检查失败' },
            ],
            status: 'failed',
            skipped: ['docs'],
            summary: '检查失败',
          })}
        />
      </I18nextProvider>,
    )
    const card = screen.getByRole('region', { name: '流水线' })
    expect(card.textContent).toContain('失败')
    expect(card.textContent).toContain('1/3 阶段')
    expect(card.textContent).toContain('跳过：docs')
  })

  it.each([
    ['completed', '已完成'],
    ['stopped', '已停止'],
    ['limit_reached', '触及限额'],
  ] as const)('结局 %s 显示为 %s', (status, text) => {
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineCard pipeline={pipeline({ status })} />
      </I18nextProvider>,
    )
    expect(screen.getByRole('region', { name: '流水线' }).textContent).toContain(text)
  })

  it('阶段被停止或触发限额时有对应文案', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineCard
          pipeline={pipeline({
            stages: [
              { stage: 'a', agentRunId: 'run-a', status: 'aborted' },
              { stage: 'b', agentRunId: 'run-b', status: 'limit_reached' },
              { stage: 'c', agentRunId: 'run-c', status: 'needs_input' },
            ],
            status: 'stopped',
          })}
        />
      </I18nextProvider>,
    )
    const card = screen.getByRole('region', { name: '流水线' })
    expect(card.textContent).toContain('已停止')
    expect(card.textContent).toContain('触及限额')
    expect(card.textContent).toContain('需要输入')
  })
})
