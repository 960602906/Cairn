// @vitest-environment jsdom
import type { MessageView } from '@cairn/core'
import { describe, expect, it } from 'vitest'
import { groupMessages, type RenderItem } from './MessageStream.js'

interface AssistantOptions {
  readonly text?: string
  readonly tools?: readonly string[]
  readonly reasoning?: string
  readonly turnId?: string
  readonly runId?: string
}

const user = (messageId: string, turnId = 't1') =>
  ({
    role: 'user',
    messageId,
    runId: 'r1',
    turnId,
    seq: 0,
    content: [{ type: 'text', text: 'hi' }],
  }) as unknown as MessageView

const assistant = (messageId: string, options: AssistantOptions = {}) =>
  ({
    role: 'assistant',
    messageId,
    runId: options.runId ?? 'r1',
    turnId: options.turnId ?? 't1',
    seq: 0,
    content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
    toolCalls: (options.tools ?? []).map((name, i) => ({
      id: `${messageId}-${i}`,
      name,
      input: {},
    })),
    ...(options.reasoning === undefined ? {} : { reasoning: { text: options.reasoning } }),
  }) as unknown as MessageView

/** 条目的简写：`m:id`（`+tools` 表示工具在后面的组里）或 `g:key[步骤]`（`^` 表示接在正文后面）。 */
const describe_ = (items: readonly RenderItem[]) =>
  items.map((item) =>
    item.kind === 'message'
      ? `m:${item.message.messageId}${item.toolsFollow ? '+tools' : ''}`
      : `g:${item.key}[${item.steps.map((step) => step.key).join(',')}]${item.afterProse ? '^' : ''}`,
  )

const keyOf = (item: RenderItem) => (item.kind === 'message' ? item.message.messageId : item.key)

describe('groupMessages', () => {
  it('正文在折叠之外；连续的思考与工具调用归成一组', () => {
    const items = groupMessages([
      user('u1'),
      assistant('a1', { text: '我先看一下', tools: ['read_file'] }),
      assistant('a2', { tools: ['search'] }),
      assistant('a3', { reasoning: '想一想', tools: ['run_command'] }),
      assistant('a4', { text: '改好了' }),
    ])
    expect(describe_(items)).toEqual(['m:u1', 'm:a1+tools', 'g:a1:tools[a1,a2,a3]^', 'm:a4'])
  })

  it('正文 + 工具作为一轮最后一条：正文在组外，工具组成紧跟在后的活动组', () => {
    const items = groupMessages([
      user('u1'),
      assistant('a1', { text: '先检查', tools: ['read_file'] }),
    ])
    expect(describe_(items)).toEqual(['m:u1', 'm:a1+tools', 'g:a1:tools[a1]^'])
  })

  it('中途的说明把活动组切开，自己留在外面', () => {
    const items = groupMessages([
      user('u1'),
      assistant('a1', { tools: ['read_file'] }),
      assistant('a2', { text: '问题出在配置', tools: ['edit_file'] }),
      assistant('a3', { tools: ['run_command'] }),
      assistant('a4', { text: '完成' }),
    ])
    expect(describe_(items)).toEqual([
      'm:u1',
      'g:a1[a1]',
      'm:a2+tools',
      'g:a2:tools[a2,a3]^',
      'm:a4',
    ])
  })

  it('逐条追加消息时，已有条目的 key 不变', () => {
    const all = [
      user('u1'),
      assistant('a1', { tools: ['read_file'] }),
      assistant('a2', { tools: ['search'] }),
      assistant('a3', { text: '中途说明', tools: ['edit_file'] }),
      assistant('a4', { reasoning: '再想想', tools: ['run_command'] }),
      assistant('a5', { text: '完成' }),
      user('u2', 't2'),
      assistant('a6', { tools: ['list_dir'], turnId: 't2' }),
    ]
    const full = groupMessages(all).map(keyOf)
    for (let n = 1; n <= all.length; n++) {
      const keys = groupMessages(all.slice(0, n)).map(keyOf)
      expect(keys).toEqual(full.slice(0, keys.length))
    }
  })

  it('只有思考、没有工具调用时不归组', () => {
    const items = groupMessages([
      user('u1'),
      assistant('a1', { reasoning: '想一想' }),
      assistant('a2', { text: '答案' }),
    ])
    expect(describe_(items)).toEqual(['m:u1', 'm:a1', 'm:a2'])
  })

  it('轮次或运行不同就不并组；空回复照常一条', () => {
    expect(
      describe_(
        groupMessages([
          assistant('a1', { tools: ['read_file'] }),
          user('u2', 't2'),
          assistant('a2', { tools: ['read_file'], turnId: 't2' }),
          assistant('a3', { tools: ['read_file'], turnId: 't2', runId: 'r2' }),
          assistant('a4', { turnId: 't2', runId: 'r2' }),
        ]),
      ),
    ).toEqual(['g:a1[a1]', 'm:u2', 'g:a2[a2]', 'g:a3[a3]', 'm:a4'])
  })
})
