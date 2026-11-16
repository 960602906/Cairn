import { describe, expect, it, vi } from 'vitest'
import { ASK_USER_TOOL, registerAskUserTool, renderAnswers } from './ask-user.js'
import { createToolRegistry, ToolError, type ToolContext } from './tools.js'

const ctx = (askUser: ToolContext['askUser']): ToolContext =>
  ({ toolCallId: 'call-1', askUser }) as ToolContext

const questions = [
  {
    question: '用哪种方案？',
    options: [{ label: '方案 A', description: '改动小', recommended: true }, { label: '方案 B' }],
  },
]

describe('ask_user tool', () => {
  it('registers and has a non-parallel read category', () => {
    const registry = createToolRegistry()
    registerAskUserTool(registry)
    const definition = registry.get(ASK_USER_TOOL)
    expect(definition).toMatchObject({
      name: ASK_USER_TOOL,
      category: 'read',
      parallel: false,
      source: { kind: 'builtin' },
      trust: 'builtin',
    })
    expect(registry.specs()[0]?.parallel).toBeUndefined()
  })

  it('assigns question ids and returns the answers as JSON', async () => {
    const askUser = vi.fn(async () => ({
      answers: [
        { questionId: 'q1', selected: ['方案 A'] },
        { questionId: 'q2', selected: [], custom: '用 Docker' },
      ],
    }))
    const registry = createToolRegistry()
    registerAskUserTool(registry)
    const definition = registry.get(ASK_USER_TOOL)!
    const output = await definition.execute(
      {
        questions: [
          ...questions,
          {
            question: '部署方式？',
            multiple: true,
            options: [{ label: '本地' }, { label: '远程' }],
          },
        ],
      },
      ctx(askUser),
    )
    expect(askUser).toHaveBeenCalledWith({
      questionId: 'call-1',
      questions: [
        { id: 'q1', question: '用哪种方案？', options: questions[0]!.options },
        {
          id: 'q2',
          question: '部署方式？',
          options: [{ label: '本地' }, { label: '远程' }],
          multiple: true,
        },
      ],
    })
    const part = output.content[0]
    const text = part?.type === 'text' ? part.text : ''
    expect(JSON.parse(text)).toEqual({
      answers: [
        { question: '用哪种方案？', selected: ['方案 A'] },
        { question: '部署方式？', selected: [], custom: '用 Docker' },
      ],
    })
  })

  it('rejects duplicate labels and more than one recommended option', async () => {
    const registry = createToolRegistry()
    registerAskUserTool(registry)
    const definition = registry.get(ASK_USER_TOOL)!
    await expect(
      definition.execute(
        {
          questions: [
            {
              question: '选一个',
              options: [{ label: 'A' }, { label: 'A' }],
            },
          ],
        },
        ctx(async () => ({ answers: [] })),
      ),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
    await expect(
      definition.execute(
        {
          questions: [
            {
              question: '选一个',
              options: [
                { label: 'A', recommended: true },
                { label: 'B', recommended: true },
              ],
            },
          ],
        },
        ctx(async () => ({ answers: [] })),
      ),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
  })

  it('needs a gate and a valid question list', async () => {
    const registry = createToolRegistry()
    registerAskUserTool(registry)
    const definition = registry.get(ASK_USER_TOOL)!
    await expect(
      definition.execute({ questions }, { toolCallId: 'c' } as ToolContext),
    ).rejects.toBeInstanceOf(ToolError)
    await expect(
      definition.execute(
        { questions: [] },
        ctx(async () => ({ answers: [] })),
      ),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
    // 顶层字段类型不对：错误没有路径，直接给出 zod 的说明。
    await expect(
      definition.execute(
        { questions: 'x' } as never,
        ctx(async () => ({ answers: [] })),
      ),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
  })

  it('tells the model when the user dismissed the questions', async () => {
    const registry = createToolRegistry()
    registerAskUserTool(registry)
    const tool = registry.get(ASK_USER_TOOL)!
    const result = await tool.execute(
      { questions: [{ question: 'A?', options: [{ label: 'one' }, { label: 'two' }] }] },
      ctx(async () => ({ answers: [], cancelled: true })),
    )
    const text = result.content[0]
    expect(text?.type).toBe('text')
    expect(JSON.parse((text as { text: string }).text)).toMatchObject({
      cancelled: true,
      note: expect.stringContaining('dismissed'),
    })
  })

  it('renders answers in question order and tolerates missing answers', () => {
    expect(
      renderAnswers(
        [
          { id: 'q1', question: 'A?' },
          { id: 'q2', question: 'B?' },
        ],
        { answers: [{ questionId: 'q2', selected: ['two'] }] },
      ),
    ).toBe(
      JSON.stringify(
        {
          answers: [
            { question: 'A?', selected: [] },
            { question: 'B?', selected: ['two'] },
          ],
        },
        null,
        2,
      ),
    )
  })
})
