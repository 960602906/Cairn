import type { MemoryScope } from '@cairn/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_CONTENT_MAX,
  REMEMBER_TOOL,
  createRememberTool,
  createToolRegistry,
  registerRememberTool,
  type ToolContext,
} from './index.js'

const ctx = {} as ToolContext

function harness(
  options: {
    readonly scopes?: readonly MemoryScope[]
    readonly write?: 'never' | 'propose' | 'auto'
    readonly mode?: 'interactive' | 'unattended'
    readonly remember?: (input: { scope: MemoryScope; content: string }) => Promise<{
      memoryId: string
      status: 'proposed' | 'active'
    }>
  } = {},
) {
  const remember =
    options.remember ?? vi.fn(async () => ({ memoryId: 'mem-1', status: 'proposed' as const }))
  const registry = createToolRegistry()
  registerRememberTool(registry, {
    scopes: options.scopes ?? ['session', 'project'],
    write: options.write ?? 'propose',
    mode: options.mode ?? 'interactive',
    remember,
  })
  return {
    remember,
    tool: registry.get(REMEMBER_TOOL)!,
    run: async (input: unknown) => {
      const result = await registry.get(REMEMBER_TOOL)!.execute(input, ctx)
      return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    },
  }
}

describe('remember 工具（M7-03）', () => {
  it('按 Agent 的写入方式与范围提交给主进程', async () => {
    const h = harness()
    const text = await h.run({ scope: 'project', content: '  提交信息用中文  ' })
    expect(h.remember).toHaveBeenCalledWith({ scope: 'project', content: '提交信息用中文' })
    expect(text).toContain('Proposed a note for this project')
    expect(text).toContain('mem-1')
  })

  it('自动写入时告诉模型已经保存', async () => {
    const h = harness({
      write: 'auto',
      remember: vi.fn(async () => ({ memoryId: 'mem-2', status: 'active' as const })),
    })
    const text = await h.run({ scope: 'session', content: '下次先跑测试' })
    expect(text).toContain('Saved a note for this session')
    expect(text).toContain('mem-2')
  })

  it('写入方式为 never 时拒绝，不调用主进程', async () => {
    const h = harness({ write: 'never' })
    await expect(h.run({ scope: 'session', content: 'x' })).rejects.toMatchObject({
      code: 'tool.execution_failed',
    })
    expect(h.remember).not.toHaveBeenCalled()
  })

  it('范围不在 Agent 声明里时拒绝，并说明可用范围', async () => {
    const h = harness({ scopes: ['session'] })
    await expect(h.run({ scope: 'project', content: 'x' })).rejects.toMatchObject({
      code: 'tool.invalid_input',
      message: expect.stringContaining('session'),
    })
    const none = harness({ scopes: [] })
    await expect(none.run({ scope: 'session', content: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('cannot read any memory scope'),
    })
    expect(h.remember).not.toHaveBeenCalled()
  })

  it('无人值守运行不能 propose，只有 auto 能写', async () => {
    const h = harness({ mode: 'unattended' })
    await expect(h.run({ scope: 'session', content: 'x' })).rejects.toMatchObject({
      code: 'tool.execution_failed',
      message: expect.stringContaining('no user to confirm'),
    })
    expect(h.remember).not.toHaveBeenCalled()

    const auto = harness({
      mode: 'unattended',
      write: 'auto',
      remember: vi.fn(async () => ({ memoryId: 'mem-3', status: 'active' as const })),
    })
    await expect(auto.run({ scope: 'session', content: 'x' })).resolves.toContain('Saved a note')
  })

  it('校验参数：缺少内容、未知范围与超长内容', async () => {
    const h = harness()
    await expect(h.run(null)).rejects.toMatchObject({ code: 'tool.invalid_input' })
    await expect(h.run({ scope: 'project' })).rejects.toMatchObject({ code: 'tool.invalid_input' })
    await expect(h.run({ scope: 'team', content: 'x' })).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(h.run({ scope: 'project', content: '   ' })).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(
      h.run({ scope: 'project', content: 'x'.repeat(MEMORY_CONTENT_MAX + 1) }),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
    expect(h.remember).not.toHaveBeenCalled()
  })

  it('主进程拒绝时原样抛出（由运行时转成工具失败）', async () => {
    const h = harness({
      remember: vi.fn(async () => {
        throw new Error('memory.disabled')
      }),
    })
    await expect(h.run({ scope: 'session', content: 'x' })).rejects.toThrow('memory.disabled')
  })

  it('工具声明为内置只读工具，参数 schema 不开放额外字段', () => {
    const tool = createRememberTool({
      scopes: ['session'],
      write: 'propose',
      mode: 'interactive',
      remember: vi.fn(),
    })
    expect(tool).toMatchObject({
      name: REMEMBER_TOOL,
      category: 'read',
      trust: 'builtin',
      source: { kind: 'builtin' },
    })
    expect(tool.inputSchema).toMatchObject({
      required: ['scope', 'content'],
      additionalProperties: false,
    })
  })
})
