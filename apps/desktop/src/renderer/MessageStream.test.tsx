// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionView, reduceSessionEvents } from '@cairn/core'
import type { EventEnvelope } from '@cairn/protocol'
import { Markdown } from './Markdown.js'
import { turnFooters } from './MessageStream.js'

afterEach(cleanup)

const model = { providerId: 'fake', modelId: 'fake-1' }
const limits = { maxStepsPerTurn: 50, maxTurnDurationMs: 1_800_000, maxConsecutiveToolErrors: 5 }
const text = (t: string) => [{ type: 'text' as const, text: t }]

const ev = (seq: number, type: string, payload: object, turnId = 't1'): EventEnvelope =>
  ({ v: 1, sessionId: 's1', runId: 'r1', turnId, ts: seq, seq, type, payload }) as EventEnvelope

const view = (events: EventEnvelope[]) => reduceSessionEvents(createSessionView('s1'), events)

const START: EventEnvelope[] = [
  ev(1, 'session.created', { projectId: 'p1', projectPath: '/w', workspacePath: '/w', title: 'x' }),
  ev(2, 'run.created', { agent: { id: 'a', version: 1 }, model, mode: 'interactive', limits }),
  ev(3, 'message.user', { messageId: 'u1', content: text('你好') }),
  ev(4, 'turn.started', {}),
]

describe('turnFooters（M2-03）', () => {
  it('本轮结束后在最后一条助手消息下汇总本轮文本与 token 数', () => {
    const footers = turnFooters(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('第一段'), model }),
        ev(6, 'usage.reported', { model, usage: { inputTokens: 100, outputTokens: 20 } }),
        ev(7, 'message.assistant.completed', { messageId: 'a2', content: text('第二段'), model }),
        ev(8, 'usage.reported', { model, usage: { inputTokens: 200, outputTokens: 30 } }),
        ev(9, 'turn.completed', { durationMs: 10 }),
      ]),
    )
    expect([...footers.keys()]).toEqual(['a2'])
    expect(footers.get('a2')).toEqual({ text: '第一段\n\n第二段', model, tokens: 350 })
  })

  it('进行中的一轮没有轮次操作', () => {
    const footers = turnFooters(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('先看看'), model }),
      ]),
    )
    expect(footers.size).toBe(0)
  })

  it('没有用量时 token 数为 undefined；每轮各有一个', () => {
    const footers = turnFooters(
      view([
        ...START,
        ev(5, 'message.assistant.completed', { messageId: 'a1', content: text('一'), model }),
        ev(6, 'turn.completed', { durationMs: 10 }),
        ev(7, 'message.user', { messageId: 'u2', content: text('再来') }, 't2'),
        ev(8, 'turn.started', {}, 't2'),
        ev(9, 'message.assistant.completed', { messageId: 'a2', content: text('二'), model }, 't2'),
        ev(10, 'usage.reported', { model, usage: { inputTokens: 1, outputTokens: 2 } }, 't2'),
        ev(11, 'turn.completed', { durationMs: 10 }, 't2'),
      ]),
    )
    expect(footers.get('a1')).toEqual({ text: '一', model, tokens: undefined })
    expect(footers.get('a2')).toEqual({ text: '二', model, tokens: 3 })
  })
})

describe('Markdown（M2-03）', () => {
  it('渲染 GFM：标题、列表、表格与行内代码', () => {
    render(
      <Markdown
        text={'# 标题\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n用 `pnpm test`'}
      />,
    )
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByText('pnpm test').tagName).toBe('CODE')
  })

  it('不渲染原始 HTML，去掉 javascript: 链接', () => {
    const { container } = render(
      <Markdown
        text={
          '<img src=x onerror="alert(1)">\n\n[点我](javascript:alert(1)) [官网](https://example.com)'
        }
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    const bad = screen.getByText('点我')
    expect(bad.getAttribute('href') ?? '').not.toContain('javascript')
    const good = screen.getByRole('link', { name: '官网' })
    expect(good.getAttribute('href')).toBe('https://example.com')
    expect(good.getAttribute('target')).toBe('_blank')
    expect(good.getAttribute('rel')).toBe('noreferrer')
  })
})
