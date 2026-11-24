// @vitest-environment jsdom
import { createSessionView, type SessionView } from '@cairn/core'
import { describe, expect, it } from 'vitest'
import { propsEqualExceptLive, sameViewExceptLive } from './MessageStream.js'

const view = createSessionView('s1')

describe('已完成消息的 memo 比较', () => {
  it('只有 live 不同时视为相同', () => {
    expect(sameViewExceptLive(view, view)).toBe(true)
    expect(sameViewExceptLive(view, { ...view, live: { ...view.live } })).toBe(true)
  })

  it('其他字段换了引用或字段数不同时视为不同', () => {
    expect(sameViewExceptLive(view, { ...view, messages: [...view.messages] })).toBe(false)
    expect(sameViewExceptLive(view, { ...view, extra: 1 } as SessionView)).toBe(false)
  })

  it('tool.output.delta 只改 liveToolOutput：视为不同，memo 不跳过（不会显示旧输出）', () => {
    expect(sameViewExceptLive(view, { ...view, liveToolOutput: { ...view.liveToolOutput } })).toBe(
      false,
    )
  })

  it('其余属性按引用比较', () => {
    const next = { ...view, live: { ...view.live } }
    expect(propsEqualExceptLive({ view, a: 1 }, { view: next, a: 1 })).toBe(true)
    expect(propsEqualExceptLive({ view, a: 1 }, { view: next, a: 2 })).toBe(false)
    expect(propsEqualExceptLive<{ view: SessionView; a?: number }>({ view }, { view, a: 1 })).toBe(
      false,
    )
  })
})
