import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, ToolError } from '@cairn/core'
import { RpcError } from '@cairn/protocol'
import { GIT_COMMIT_TOOL, GIT_PUSH_TOOL, registerAutoFixGitTools } from './git-tools.js'

function register(tools: Parameters<typeof registerAutoFixGitTools>[1]) {
  const registry = createToolRegistry()
  registerAutoFixGitTools(registry, tools)
  return registry
}

const execute = (registry: ReturnType<typeof createToolRegistry>, name: string, input: unknown) =>
  registry.get(name)!.execute(input, undefined as never)

describe('auto-fix git tools (M8-03)', () => {
  it('registers both tools as builtin execute tools', () => {
    const registry = register({ commit: vi.fn(), push: vi.fn() })
    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([GIT_COMMIT_TOOL, GIT_PUSH_TOOL])
    const commit = registry.get(GIT_COMMIT_TOOL)!
    expect(commit).toMatchObject({
      category: 'execute',
      trust: 'builtin',
      source: { kind: 'builtin' },
    })
    expect(commit.inputSchema).toMatchObject({ required: ['message'], additionalProperties: false })
    expect(commit.description).toContain('does not push')
    expect(registry.get(GIT_PUSH_TOOL)!.description).toContain('Cannot force push')
  })

  it('proxies commit and push and reports the results', async () => {
    const commit = vi.fn(async () => ({ sha: 'abc1234' }))
    const push = vi.fn(async () => ({ sha: 'abc1234', branch: 'fix' }))
    const registry = register({ commit, push })

    await expect(execute(registry, GIT_COMMIT_TOOL, { message: 'fix: test' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Committed abc1234.' }],
    })
    expect(commit).toHaveBeenCalledWith({ message: 'fix: test' })
    await expect(execute(registry, GIT_PUSH_TOOL, {})).resolves.toEqual({
      content: [{ type: 'text', text: 'Pushed abc1234 to fix.' }],
    })
  })

  it('prefers the reason from the main process and falls back to the default text', async () => {
    const commit = vi.fn(async () => {
      throw new RpcError('autofix.commit_failed', { reason: 'Nothing staged.' })
    })
    const registry = register({ commit, push: vi.fn() })
    await expect(execute(registry, GIT_COMMIT_TOOL, { message: 'x' })).rejects.toMatchObject({
      code: 'autofix.commit_failed',
      message: 'Nothing staged.',
    })

    const denied = register({
      commit: vi.fn(),
      push: vi.fn(async () => {
        throw new RpcError('autofix.push_denied')
      }),
    })
    const error = await execute(denied, GIT_PUSH_TOOL, {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect(error).toMatchObject({ code: 'autofix.push_denied' })
    expect((error as ToolError).message).toContain('branch guard')

    const unknown = register({
      commit: vi.fn(),
      push: vi.fn(async () => {
        throw new RpcError('autofix.some_new_code')
      }),
    })
    await expect(execute(unknown, GIT_PUSH_TOOL, {})).rejects.toMatchObject({
      code: 'autofix.some_new_code',
      message: 'autofix.some_new_code',
    })
  })

  it('turns unexpected errors into execution failures', async () => {
    const registry = register({
      commit: vi.fn(),
      push: vi.fn(async () => {
        throw new Error('socket closed')
      }),
    })
    await expect(execute(registry, GIT_PUSH_TOOL, {})).rejects.toMatchObject({
      code: 'tool.execution_failed',
      message: 'socket closed',
    })

    const text = register({
      commit: vi.fn(),
      push: vi.fn(async () => {
        throw 'offline'
      }),
    })
    await expect(execute(text, GIT_PUSH_TOOL, {})).rejects.toMatchObject({
      code: 'tool.execution_failed',
      message: 'offline',
    })
  })
})
