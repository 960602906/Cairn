import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIcaclsRunner, icaclsPath } from './icacls.js'
import { createIntegrityController } from './integrity.js'
import { SandboxError } from './types.js'

describe('icaclsPath', () => {
  it('uses SystemRoot and defaults to C:\\Windows', () => {
    expect(icaclsPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\icacls.exe')
    expect(icaclsPath({ SYSTEMROOT: 'E:\\Win' })).toBe('E:\\Win\\System32\\icacls.exe')
    expect(icaclsPath({})).toBe('C:\\Windows\\System32\\icacls.exe')
  })
})

describe('createIcaclsRunner', () => {
  it('spawns the executable and resolves its exit code', async () => {
    const runner = createIcaclsRunner({ exe: process.execPath })
    await expect(runner(['-e', 'process.exit(3)'])).resolves.toBe(3)
  })

  it('rejects when the executable cannot start', async () => {
    const runner = createIcaclsRunner({
      exe: path.join(tmpdir(), 'cairn-missing-icacls.exe'),
    })
    await expect(runner([])).rejects.toThrow()
  })
})

describe('createIntegrityController', () => {
  it('sets low and medium labels on the directory', async () => {
    const run = vi.fn(async () => 0)
    const controller = createIntegrityController({ run })
    await controller.setLevel('C:\\work', 'low')
    await controller.setLevel('C:\\work', 'medium')
    expect(run).toHaveBeenNthCalledWith(1, ['C:\\work', '/setintegritylevel', '(OI)(CI)L'])
    expect(run).toHaveBeenNthCalledWith(2, ['C:\\work', '/setintegritylevel', '(OI)(CI)M'])
  })

  it('fails closed when icacls exits non-zero', async () => {
    const controller = createIntegrityController({ run: async () => 5 })
    const error = await controller.setLevel('C:\\work', 'low').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).toMatchObject({
      code: 'sandbox.setup_failed',
      params: { level: 'low', exitCode: '5' },
    })
  })

  it('wraps execution errors', async () => {
    const controller = createIntegrityController({
      run: async () => {
        throw new Error('spawn failed')
      },
    })
    const error = await controller.setLevel('C:\\work', 'medium').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxError)
    expect((error as SandboxError).message).toContain('spawn failed')
    expect((error as SandboxError).params).toEqual({ level: 'medium' })
  })
})
