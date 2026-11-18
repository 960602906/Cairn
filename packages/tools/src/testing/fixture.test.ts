import type { ToolDefinition } from '@cairn/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixture, runTool, toolContext, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => {
  fx = await createFixture()
})
afterAll(() => fx.dispose())

const base = {
  description: 'fixture tool',
  inputSchema: { type: 'object' as const },
  category: 'read' as const,
  source: { kind: 'builtin' as const },
  trust: 'builtin' as const,
}

describe('tools/testing/fixture', () => {
  it('toolContext 的日志器、检查点与进度都是空实现', async () => {
    const ctx = toolContext(fx.root)
    expect(await ctx.checkpoints.create('turn_start')).toBe('cp')
    ctx.log.setLevel('debug')
    expect(ctx.log.isEnabled('debug')).toBe(false)
    ctx.log.debug('d')
    ctx.log.info('i')
    ctx.log.warn('w')
    ctx.log.error('e')
    expect(ctx.log.child({ sessionId: 's' })).toBe(ctx.log)
    expect(() => ctx.progress('chunk')).not.toThrow()
  })

  it('runTool 在没有 normalize 时直接执行', async () => {
    const tool: ToolDefinition<{ value: string }> = {
      ...base,
      name: 'no-normalize',
      execute: async (input) => ({ content: [{ type: 'text', text: input.value }] }),
    }
    await expect(runTool(tool, { value: 'hello' }, toolContext(fx.root))).resolves.toBe('hello')
  })

  it('runTool 先执行 normalize，并只拼接文本部分', async () => {
    const tool: ToolDefinition<{ value: string }> = {
      ...base,
      name: 'with-normalize',
      normalize: async (input) => ({ input: { value: `${input.value}!` }, targets: { paths: [] } }),
      execute: async (input) => ({
        content: [
          { type: 'text', text: input.value },
          { type: 'image', blobRef: 'x', mimeType: 'image/png' },
        ],
      }),
    }
    await expect(runTool(tool, { value: 'hi' }, toolContext(fx.root))).resolves.toBe('hi!')
  })
})
