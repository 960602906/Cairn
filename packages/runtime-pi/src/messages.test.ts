import type {
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
  Model,
  Usage,
} from '@earendil-works/pi-ai'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { CanonicalMessage, type ModelRef } from '@nexus/protocol'
import { describe, expect, it } from 'vitest'
import {
  FOREIGN_API,
  IMAGE_PLACEHOLDER,
  SUMMARY_PREFIX,
  fromPiAssistant,
  fromPiMessages,
  fromPiUsage,
  sameModel,
  toPiMessages,
  type PiModelIdentity,
} from './messages.js'

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...over,
})

/** 三种接口格式的目标模型，与 pi 实际产生的助手消息（字段取自 pi 各格式的解析代码）。 */
const FORMATS: {
  name: string
  target: PiModelIdentity
  message: PiAssistantMessage
}[] = [
  {
    name: 'openai（DeepSeek：签名记录回传推理用的字段名）',
    target: {
      ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
      provider: 'deepseek',
      api: 'openai-completions',
      id: 'deepseek-flash',
    },
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先查订单。', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: '我来查一下。' },
        { type: 'toolCall', id: 'call_0', name: 'get_order', arguments: { order_id: 'A-1024' } },
        { type: 'toolCall', id: 'call_1', name: 'get_weather', arguments: { city: '杭州' } },
      ],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: usage(),
      stopReason: 'toolUse',
      timestamp: 1000,
    },
  },
  {
    name: 'anthropic（thinking 签名与被隐去的块）',
    target: {
      ref: { providerId: 'claude', modelId: 'claude-x' },
      provider: 'nexus-claude',
      api: 'anthropic-messages',
      id: 'claude-x',
    },
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me check.', thinkingSignature: 'sig-abc' },
        { type: 'thinking', thinking: '', thinkingSignature: 'opaque-data', redacted: true },
        { type: 'toolCall', id: 'toolu_01', name: 'read_file', arguments: { path: 'a.ts' } },
      ],
      api: 'anthropic-messages',
      provider: 'nexus-claude',
      model: 'claude-x',
      usage: usage(),
      stopReason: 'toolUse',
      timestamp: 2000,
    },
  },
  {
    name: 'gemini（thought signature 在推理与工具调用上）',
    target: {
      ref: { providerId: 'gemini', modelId: 'gemini-y' },
      provider: 'google',
      api: 'google-generative-ai',
      id: 'gemini-y',
    },
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '需要读文件。', thinkingSignature: 'g-sig-1' },
        {
          type: 'toolCall',
          id: 'fc_1',
          name: 'read_file',
          arguments: { path: 'b.ts', options: { lines: [1, 2] } },
          thoughtSignature: 'g-sig-2',
        },
      ],
      api: 'google-generative-ai',
      provider: 'google',
      model: 'gemini-y',
      usage: usage(),
      stopReason: 'toolUse',
      timestamp: 3000,
    },
  },
]

/** 最小的 pi 模型定义，只含 `transformMessages` 用到的字段。 */
const piModel = (t: PiModelIdentity) =>
  ({ id: t.id, provider: t.provider, api: t.api, input: ['text'] }) as unknown as Model<string>

describe('助手消息往返（三种格式）', () => {
  for (const { name, target, message } of FORMATS) {
    describe(name, () => {
      const canonical = fromPiAssistant(message, target.ref)

      it('pi → 规范化 → pi 保留全部块、签名与参数', () => {
        const [back] = toPiMessages([canonical], target)
        expect(back).toMatchObject({
          role: 'assistant',
          provider: target.provider,
          api: target.api,
          model: target.id,
          stopReason: 'toolUse',
          timestamp: message.timestamp,
        })
        expect((back as PiAssistantMessage).content).toEqual(message.content)
      })

      it('规范化结果可以通过 schema 持久化，签名不丢失', () => {
        expect(CanonicalMessage.parse(canonical)).toEqual(canonical)
      })

      it('pi 把它当作同一模型的消息，推理与签名会发给模型', () => {
        const [back] = transformMessages(toPiMessages([canonical], target), piModel(target))
        expect((back as PiAssistantMessage).content).toEqual(message.content)
      })

      it('换了模型后，pi 去掉推理与签名', () => {
        const other: PiModelIdentity = {
          ...target,
          ref: { ...target.ref, modelId: 'other' },
          id: 'other',
        }
        const [back] = transformMessages(toPiMessages([canonical], other), piModel(other))
        const content = (back as PiAssistantMessage).content
        expect(content.some((c) => c.type === 'thinking')).toBe(false)
        expect(content.some((c) => c.type === 'toolCall' && c.thoughtSignature)).toBe(false)
        expect(content.filter((c) => c.type === 'toolCall')).toHaveLength(
          message.content.filter((c) => c.type === 'toolCall').length,
        )
      })
    })
  }

  it('DeepSeek：单块推理记为 blocks，显示文本不变', () => {
    const { target, message } = FORMATS[0]!
    expect(fromPiAssistant(message, target.ref).reasoning).toEqual({
      text: '先查订单。',
      providerId: 'deepseek',
      blocks: [{ text: '先查订单。', signature: 'reasoning_content' }],
    })
  })

  it('Anthropic：显示文本不含被隐去的块', () => {
    const { target, message } = FORMATS[1]!
    expect(fromPiAssistant(message, target.ref).reasoning?.text).toBe('Let me check.')
  })
})

describe('规范化历史往返', () => {
  const target = FORMATS[0]!.target
  const model: ModelRef = target.ref
  const history: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '查订单 A-1024' }], ts: 1 },
    {
      role: 'assistant',
      content: [],
      reasoning: { text: '想一想', providerId: 'deepseek' },
      toolCalls: [
        { id: 'c1', name: 'get_order', input: { order_id: 'A-1024' } },
        { id: 'c2', name: 'write_file', input: { path: 'x' } },
        { id: 'c3', name: 'run_command', input: { command: 'ls' } },
        { id: 'c4', name: 'run_command', input: { command: 'pwd' } },
        { id: 'c5', name: 'read_file', input: { path: 'y' } },
      ],
      model,
      ts: 2,
    },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: '{}' }],
      status: 'ok',
      ts: 3,
    },
    {
      role: 'tool',
      toolCallId: 'c2',
      content: [{ type: 'text', text: 'denied' }],
      status: 'denied',
      ts: 4,
    },
    {
      role: 'tool',
      toolCallId: 'c3',
      content: [{ type: 'text', text: 'cancelled' }],
      status: 'cancelled',
      ts: 5,
    },
    {
      role: 'tool',
      toolCallId: 'c4',
      content: [{ type: 'text', text: 'boom' }],
      status: 'error',
      ts: 6,
    },
    {
      role: 'tool',
      toolCallId: 'c5',
      content: [{ type: 'text', text: '?' }],
      status: 'unknown',
      ts: 7,
    },
    { role: 'assistant', content: [{ type: 'text', text: '完成' }], model, ts: 8 },
  ]

  it('规范化 → pi → 规范化 不变', () => {
    expect(fromPiMessages(toPiMessages(history, target), model)).toEqual(history)
  })

  it('工具结果带上工具名，非 ok 状态标为错误', () => {
    const pi = toPiMessages(history, target)
    const results = pi.filter((m) => m.role === 'toolResult')
    expect(results.map((m) => [m.toolName, m.isError])).toEqual([
      ['get_order', false],
      ['write_file', true],
      ['run_command', true],
      ['run_command', true],
      ['read_file', true],
    ])
    expect(pi[1]).toMatchObject({ stopReason: 'toolUse' })
    expect(pi.at(-1)).toMatchObject({ stopReason: 'stop' })
  })
})

describe('转换细节', () => {
  const target = FORMATS[0]!.target

  it('其他提供方的推理不发给模型，外来消息不冒充当前模型', () => {
    const [pi] = toPiMessages(
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          reasoning: { text: 'other thoughts', providerId: 'claude' },
          model: { providerId: 'claude', modelId: 'claude-x' },
          ts: 1,
        },
      ],
      target,
    )
    expect(pi).toMatchObject({
      provider: 'claude',
      api: FOREIGN_API,
      model: 'claude-x',
      content: [{ type: 'text', text: 'hi' }],
    })
  })

  it('同一提供方的其他模型：推理保留，由 pi 按模型决定是否发送', () => {
    const [pi] = toPiMessages(
      [
        {
          role: 'assistant',
          content: [],
          reasoning: { text: 'r', providerId: 'deepseek' },
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          ts: 1,
        },
      ],
      target,
    )
    expect(pi).toMatchObject({ api: FOREIGN_API, content: [{ type: 'thinking', thinking: 'r' }] })
  })

  it('summary 转为带前缀的用户消息', () => {
    expect(
      toPiMessages(
        [{ role: 'summary', content: '之前做了 X', coversTurns: ['t1', 't2'], ts: 5 }],
        target,
      ),
    ).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${SUMMARY_PREFIX}之前做了 X` }],
        timestamp: 5,
      },
    ])
  })

  it('图片暂以文字占位', () => {
    const [user] = toPiMessages(
      [{ role: 'user', content: [{ type: 'image', blobRef: 'b1', mimeType: 'image/png' }], ts: 1 }],
      target,
    )
    expect(user).toMatchObject({ content: [{ type: 'text', text: IMAGE_PLACEHOLDER }] })
    const [back] = fromPiMessages(
      [
        {
          role: 'user',
          content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          timestamp: 1,
        },
      ],
      target.ref,
    )
    expect(back).toEqual({
      role: 'user',
      content: [{ type: 'text', text: IMAGE_PLACEHOLDER }],
      ts: 1,
    })
  })

  it('工具参数不是对象时传空对象；找不到调用时工具名为 unknown', () => {
    const pi = toPiMessages(
      [
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ id: 'c1', name: 'f', input: 'not-an-object' }],
          model: target.ref,
          ts: 1,
        },
        { role: 'tool', toolCallId: 'zz', content: [], status: 'ok', ts: 2 },
      ],
      target,
    )
    expect(pi[0]).toMatchObject({ content: [{ type: 'toolCall', arguments: {} }] })
    expect(pi[1]).toMatchObject({ toolName: 'unknown' })
  })

  it('pi 的字符串用户消息、系统消息、没有状态的工具结果', () => {
    const messages: PiMessage[] = [
      { role: 'system', content: 'sys', timestamp: 0 },
      { role: 'user', content: '你好', timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 'a',
        toolName: 'f',
        content: [],
        isError: true,
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'b',
        toolName: 'f',
        content: [],
        details: { nexusStatus: 'bogus' },
        isError: false,
        timestamp: 3,
      },
    ]
    expect(fromPiMessages(messages, target.ref)).toEqual([
      { role: 'user', content: [{ type: 'text', text: '你好' }], ts: 1 },
      { role: 'tool', toolCallId: 'a', content: [], status: 'error', ts: 2 },
      { role: 'tool', toolCallId: 'b', content: [], status: 'ok', ts: 3 },
    ])
  })

  it('没有签名的单块推理不记 blocks；多块用空行连接', () => {
    const base = FORMATS[0]!.message
    const one = fromPiAssistant(
      { ...base, content: [{ type: 'thinking', thinking: 'a' }] },
      target.ref,
    )
    expect(one).toEqual({
      role: 'assistant',
      content: [],
      reasoning: { text: 'a', providerId: 'deepseek' },
      model: target.ref,
      ts: base.timestamp,
    })
    const two = fromPiAssistant(
      {
        ...base,
        content: [
          { type: 'thinking', thinking: 'a' },
          { type: 'thinking', thinking: 'b' },
        ],
      },
      target.ref,
    )
    expect(two.reasoning).toEqual({
      text: 'a\n\nb',
      providerId: 'deepseek',
      blocks: [{ text: 'a' }, { text: 'b' }],
    })
    const none = fromPiAssistant({ ...base, content: [] }, target.ref)
    expect(none).not.toHaveProperty('reasoning')
    expect(none).not.toHaveProperty('toolCalls')
  })

  it('sameModel 比较提供方与模型', () => {
    expect(sameModel({ providerId: 'a', modelId: 'm' }, { providerId: 'a', modelId: 'm' })).toBe(
      true,
    )
    expect(sameModel({ providerId: 'a', modelId: 'm' }, { providerId: 'b', modelId: 'm' })).toBe(
      false,
    )
  })
})

describe('fromPiUsage', () => {
  it('输入含缓存部分，推理是输出的一部分', () => {
    expect(
      fromPiUsage(usage({ input: 100, cacheRead: 30, cacheWrite: 5, output: 40, reasoning: 25 })),
    ).toEqual({ inputTokens: 135, outputTokens: 40, cacheReadTokens: 30, reasoningTokens: 25 })
  })

  it('没有缓存与推理数据时省略对应字段', () => {
    expect(fromPiUsage(usage({ input: 10, output: 2 }))).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    })
  })
})
