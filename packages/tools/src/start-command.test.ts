import { ToolError } from '@cairn/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStartCommandTool } from './start-command.js'
import { createFixture, runTool, toolContext, type Fixture } from './testing/fixture.js'

let fx: Fixture
beforeEach(async () => {
  fx = await createFixture()
})
afterEach(() => fx.dispose())

const command = {
  commandId: 'cmd1',
  sessionId: 's1',
  runId: 'r1',
  command: 'server',
  cwd: '/work',
  startedAt: 1,
  status: 'running' as const,
}

describe('start_command', () => {
  it('starts in the workspace root and returns the command id', async () => {
    const start = vi.fn(async () => command)
    const result = await runTool(
      createStartCommandTool({ start }),
      { command: 'server' },
      toolContext(fx.root),
    )
    expect(start).toHaveBeenCalledWith({ command: 'server', cwd: fx.root })
    expect(result).toBe(
      `Started background command cmd1 in ${fx.root}. It keeps running after this tool returns.`,
    )
  })

  it('resolves an explicit workspace-relative directory for approval and execution', async () => {
    const start = vi.fn(async () => command)
    const tool = createStartCommandTool({ start })
    const ctx = toolContext(fx.root)
    await expect(tool.describeForApproval!({ command: 'server', cwd: '.' }, ctx)).resolves.toEqual({
      summary: `Start a background command in ${fx.root}; it keeps running until stopped or the app exits`,
      command: 'server',
    })
    await runTool(tool, { command: 'server', cwd: '.', timeoutSeconds: 30 }, ctx)
    expect(start).toHaveBeenCalledWith({ command: 'server', cwd: fx.root, timeoutSeconds: 30 })
  })

  it('describes the default workspace for approval', async () => {
    const tool = createStartCommandTool({ start: async () => command })
    await expect(
      tool.describeForApproval!({ command: 'server' }, toolContext(fx.root)),
    ).resolves.toEqual({
      summary: `Start a background command in ${fx.root}; it keeps running until stopped or the app exits`,
      command: 'server',
    })
  })

  it('rejects paths outside the workspace and reports start failures', async () => {
    const tool = createStartCommandTool({
      start: async () => {
        throw new Error('full')
      },
    })
    const ctx = toolContext(fx.root)
    await expect(
      tool.normalize!({ command: 'server', cwd: '../outside' }, ctx),
    ).rejects.toBeInstanceOf(ToolError)
    await expect(runTool(tool, { command: 'server' }, ctx)).rejects.toMatchObject({
      code: 'command.start_failed',
      message: 'Cannot start the background command: full',
    })
  })
})
