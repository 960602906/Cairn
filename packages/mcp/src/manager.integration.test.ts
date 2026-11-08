import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { McpManager } from './index.js'

const fixture = fileURLToPath(new URL('./testing/fixture-server.mjs', import.meta.url))

describe('McpManager with a real stdio server', () => {
  let manager: McpManager | undefined

  afterEach(async () => {
    await manager?.close()
    manager = undefined
  })

  it('连接、列出工具并调用', async () => {
    manager = new McpManager()
    const state = await manager.add({
      serverId: 'fixture',
      name: 'Fixture',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [fixture],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      },
      connectTimeoutMs: 15_000,
      callTimeoutMs: 15_000,
    })
    expect(state.status).toBe('connected')
    expect(state.tools.map((tool) => tool.name)).toEqual(['echo', 'structured', 'empty', 'nodesc'])

    const result = await manager.call(
      'fixture',
      'echo',
      { text: 'hi' },
      {
        signal: new AbortController().signal,
      },
    )
    expect(result).toEqual({ text: 'echo:hi', isError: false })
    const structured = await manager.call('fixture', 'structured', {})
    expect(structured.text).toContain('"value": 42')
    const empty = await manager.call('fixture', 'empty', {})
    expect(empty.text).toBe('')
    const nodesc = await manager.call('fixture', 'nodesc', {})
    expect(nodesc.text).toBe('nodesc')
    expect(manager.logs('fixture').some((entry) => entry.message.includes('fixture ready'))).toBe(
      true,
    )
  }, 30_000)
})
