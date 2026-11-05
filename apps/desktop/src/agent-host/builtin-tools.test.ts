import { createToolRegistry } from '@nexus/core'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinTools } from './builtin-tools.js'

const shell = { kind: 'bash' as const, exe: '/bin/bash' }

describe('createBuiltinTools', () => {
  it('registers the built-in tools and selects the shell once', async () => {
    const selectShell = vi.fn(async () => shell)
    const register = createBuiltinTools({ binDir: '/app/out/bin', selectShell })
    const first = createToolRegistry()
    // 返回 shell 的名称，写入系统提示词（M1-13b）
    await expect(register(first)).resolves.toEqual({ shell: 'bash' })
    expect(first.list().map((t) => [t.name, t.category])).toEqual([
      ['read_file', 'read'],
      ['list_dir', 'read'],
      ['search', 'read'],
      ['write_file', 'write'],
      ['edit_file', 'write'],
      ['run_command', 'execute'],
    ])
    await register(createToolRegistry())
    expect(selectShell).toHaveBeenCalledTimes(1)
  })

  it('selects the shell again after a failure', async () => {
    const selectShell = vi
      .fn<() => Promise<typeof shell>>()
      .mockRejectedValueOnce(new Error('no shell'))
      .mockResolvedValue(shell)
    const register = createBuiltinTools({ binDir: '/bin', selectShell })
    await expect(register(createToolRegistry())).rejects.toThrow('no shell')
    await register(createToolRegistry())
    expect(selectShell).toHaveBeenCalledTimes(2)
  })
})
