import { createToolRegistry } from '@cairn/core'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinTools } from './builtin-tools.js'

const shell = { kind: 'bash' as const, exe: '/bin/bash' }

const capability = {
  available: true,
  supported: true,
  mechanism: 'restricted-token' as const,
  networkIsolated: false,
  checks: {
    restrictedToken: true,
    lowIntegrity: true,
    jobObject: true,
    appContainer: false,
  },
}

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
    expect(selectShell).toHaveBeenCalledWith('auto')
  })

  it('passes the shell preference from the settings (M2-09)', async () => {
    const selectShell = vi.fn(async () => ({ kind: 'cmd' as const, exe: 'cmd.exe' }))
    const register = createBuiltinTools({ binDir: '/bin', selectShell })
    await expect(register(createToolRegistry(), '/w', 'cmd')).resolves.toEqual({ shell: 'cmd.exe' })
    expect(selectShell).toHaveBeenCalledWith('cmd')
  })

  it('uses the real shell selection by default', async () => {
    const register = createBuiltinTools({ binDir: '/bin' })
    const result = await register(createToolRegistry())
    expect(result.shell.length).toBeGreaterThan(0)
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

  it('declares the sandbox on run_command when the capability is available (M5-04)', async () => {
    const register = createBuiltinTools({ binDir: '/bin', selectShell: async () => shell })
    const registry = createToolRegistry()
    await register(registry, '/w', 'auto', {
      policy: { profile: 'workspace-write', network: 'none' },
      capability,
      unavailable: 'deny',
    })
    expect(registry.get('run_command')?.sandbox).toEqual({
      profile: 'workspace-write',
      network: 'none',
      mechanism: 'restricted-token',
      enforced: true,
      networkIsolated: false,
    })
  })

  it('keeps the experimental AppContainer execution when the host selected it', async () => {
    const register = createBuiltinTools({ binDir: '/bin', selectShell: async () => shell })
    const registry = createToolRegistry()
    await register(registry, '/w', 'auto', {
      policy: { profile: 'read-only', network: 'internet' },
      capability: {
        ...capability,
        mechanism: 'appcontainer',
        networkIsolated: true,
        checks: { ...capability.checks, appContainer: true },
      },
      unavailable: 'deny',
      appContainerName: 'com.cairn.sandbox.test',
    })
    expect(registry.get('run_command')?.sandbox).toMatchObject({
      profile: 'read-only',
      network: 'internet',
      mechanism: 'appcontainer',
      networkIsolated: true,
    })
  })

  it('marks commands as unsandboxed when the sandbox is unavailable', async () => {
    const register = createBuiltinTools({ binDir: '/bin', selectShell: async () => shell })
    const registry = createToolRegistry()
    await register(registry, '/w', 'auto', {
      policy: { profile: 'workspace-write', network: 'none' },
      capability: {
        ...capability,
        available: false,
        mechanism: 'none',
        reason: 'sandbox.restricted_token_unavailable',
      },
      unavailable: 'deny',
    })
    expect(registry.get('run_command')?.sandbox).toEqual({
      profile: 'workspace-write',
      network: 'none',
      mechanism: 'none',
      enforced: false,
      networkIsolated: false,
      reason: 'sandbox.restricted_token_unavailable',
    })
  })
})
