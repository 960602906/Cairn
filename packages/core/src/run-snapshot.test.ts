import { describe, expect, it } from 'vitest'
import type { CanonicalMessage } from '@cairn/protocol'
import {
  RUN_SNAPSHOT_MAX_CHARS,
  buildRunSnapshot,
  fitSnapshot,
  splitSystemPrompt,
} from './run-snapshot.js'

const model = { providerId: 'fake', modelId: 'fake-1' }
const agent = { id: 'builtin.coder', version: 1 }
const text = (value: string) => [{ type: 'text' as const, text: value }]

const user = (value: string, ts = 1): CanonicalMessage => ({
  role: 'user',
  content: text(value),
  ts,
})
const assistant = (value: string, ts = 2): CanonicalMessage => ({
  role: 'assistant',
  content: text(value),
  model,
  ts,
})

describe('splitSystemPrompt', () => {
  it('按标题拆分并估算 token', () => {
    const sections = splitSystemPrompt(
      '# Base\nYou are Cairn.\n\n# Tools\n- read\n\n# Environment\n- OS',
    )
    expect(sections.map((section) => section.title)).toEqual(['Base', 'Tools', 'Environment'])
    expect(sections[0]!.tokens).toBeGreaterThan(0)
    expect(sections[1]!.text).toContain('# Tools')
  })

  it('没有标题时作为基础段', () => {
    expect(splitSystemPrompt('plain prompt')).toEqual([
      { title: 'Base prompt', text: 'plain prompt', tokens: 3 },
    ])
    expect(splitSystemPrompt('   ')).toEqual([])
  })
})

describe('buildRunSnapshot', () => {
  it('记录系统提示词、技能、工具、历史与压缩摘要', () => {
    const snapshot = buildRunSnapshot({
      runId: 'r1',
      parentRunId: 'p1',
      agent,
      model,
      turnId: 't1',
      stepId: 'st1',
      systemPrompt: '# Base\nYou are Cairn.\n\n# Tools\n- read',
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      skills: [{ name: 'review', description: 'Review code', pinned: true }],
      history: [user('hello'), assistant('hi')],
      compaction: {
        summary: 'Earlier work',
        coversTurns: ['t0', 't1'],
        tokensBefore: 100,
        tokensAfter: 20,
      },
    })
    expect(snapshot).toMatchObject({
      runId: 'r1',
      parentRunId: 'p1',
      turnId: 't1',
      stepId: 'st1',
      history: { messages: 2 },
      compaction: { summary: 'Earlier work', coversTurns: ['t0', 't1'] },
    })
    expect(snapshot.systemPrompt.map((section) => section.title)).toEqual(['Base', 'Tools'])
    expect(snapshot.tools[0]).toMatchObject({ name: 'read_file', description: 'Read a file' })
    expect(snapshot.skills[0]).toMatchObject({ name: 'review', pinned: true })
    expect(snapshot.tokens).toBeGreaterThan(0)
  })

  it('预览摘要、带工具调用的助手消息与空描述的工具', () => {
    const snapshot = buildRunSnapshot({
      runId: 'r1',
      agent,
      model,
      systemPrompt: '# Base\nx',
      tools: [{ name: 'empty_description', description: '', inputSchema: { type: 'object' } }],
      history: [
        { role: 'summary', content: 'Earlier context', coversTurns: ['t0', 't1'], ts: 1 },
        {
          role: 'assistant',
          content: text('calling'),
          toolCalls: [{ id: 'c1', name: 'read_file', input: {} }],
          model,
          ts: 2,
        },
      ],
      compaction: { summary: 'summary', coversTurns: ['t0', 't1'] },
    })
    expect(snapshot.tools[0]!.description).toBe('')
    expect(snapshot.history.preview[0]!.text).toBe('Summary: Earlier context')
    expect(snapshot.history.preview[1]!.text).toContain('Tool calls: read_file')
    expect(snapshot.compaction).toEqual({ summary: 'summary', coversTurns: ['t0', 't1'] })
  })

  it('历史预览只保留最近 20 条并截断单条文本', () => {
    const history = Array.from({ length: 25 }, (_, index) =>
      user(`${index}:${'x'.repeat(500)}`, index),
    )
    const snapshot = buildRunSnapshot({
      runId: 'r1',
      agent,
      model,
      systemPrompt: '# Base\nx',
      tools: [],
      history,
    })
    expect(snapshot.history.messages).toBe(25)
    expect(snapshot.history.preview).toHaveLength(20)
    expect(snapshot.history.preview[0]!.text.startsWith('5:')).toBe(true)
    expect(snapshot.history.preview[0]!.text.length).toBe(400)
  })

  it('超过大小上限时先丢历史预览再截断系统提示词', () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'x'.repeat(500),
      inputSchema: { type: 'object' },
    }))
    const snapshot = buildRunSnapshot({
      runId: 'r1',
      agent,
      model,
      systemPrompt: `# Base\n${'y'.repeat(20_000)}\n\n# Tools\n${'z'.repeat(20_000)}`,
      tools,
      history: Array.from({ length: 30 }, (_, index) => user('x'.repeat(400), index)),
    })
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(RUN_SNAPSHOT_MAX_CHARS)
    expect(snapshot.history.preview.length).toBeLessThan(20)
    expect(snapshot.tools.some((tool) => tool.description.length < 500)).toBe(true)
  })

  it('fitSnapshot 在仍有历史预览时保留系统提示词', () => {
    const base = buildRunSnapshot({
      runId: 'r1',
      agent,
      model,
      systemPrompt: '# Base\nshort',
      tools: [],
      history: [user('a'), user('b')],
    })
    const huge = {
      ...base,
      history: {
        ...base.history,
        preview: base.history.preview.map((message) => ({ ...message, text: 'x'.repeat(20_000) })),
      },
    }
    const fitted = fitSnapshot(huge)
    expect(fitted.history.preview).toHaveLength(1)
    expect(fitted.systemPrompt).toBe(base.systemPrompt)
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(RUN_SNAPSHOT_MAX_CHARS)
  })

  it('系统提示词清空后继续裁剪技能描述', () => {
    const snapshot = buildRunSnapshot({
      runId: 'r1',
      agent,
      model,
      systemPrompt: '',
      tools: [],
      skills: Array.from({ length: 80 }, (_, index) => ({
        name: `skill_${index}`,
        description: 'y'.repeat(500),
        pinned: false,
      })),
      history: [],
    })
    expect(snapshot.systemPrompt).toEqual([])
    expect(snapshot.skills.some((skill) => skill.description.length < 500)).toBe(true)
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(RUN_SNAPSHOT_MAX_CHARS)
  })

  it('没有可裁剪文本时停止而不是死循环', () => {
    const huge = {
      ...buildRunSnapshot({
        runId: 'r1',
        agent,
        model,
        systemPrompt: '',
        tools: [],
        history: [],
      }),
      agent: { id: 'a'.repeat(RUN_SNAPSHOT_MAX_CHARS + 1), version: 1 },
      systemPrompt: [],
      tools: [],
      skills: [],
    }
    expect(fitSnapshot(huge)).toEqual(huge)
  })
})
