import { describe, expect, it, vi } from 'vitest'
import { createShellInfo } from './shell-info.js'

describe('createShellInfo', () => {
  it('describes the automatic choice and offers cmd only on Windows', async () => {
    const select = vi.fn(async () => ({ kind: 'pwsh' as const, exe: 'pwsh.exe', version: '7.5.4' }))
    const info = createShellInfo({ platform: 'win32', select })
    await expect(info()).resolves.toEqual({
      detected: 'PowerShell 7.5.4',
      options: ['auto', 'cmd'],
    })
    await info()
    expect(select).toHaveBeenCalledTimes(1)

    const linux = createShellInfo({
      platform: 'linux',
      select: async () => ({ kind: 'bash', exe: '/bin/bash' }),
    })
    await expect(linux()).resolves.toEqual({ detected: 'bash', options: ['auto'] })
  })

  it('probes again after a failure', async () => {
    const select = vi
      .fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue({ kind: 'cmd', exe: 'cmd.exe' })
    const info = createShellInfo({ platform: 'win32', select })
    await expect(info()).rejects.toThrow('probe failed')
    await expect(info()).resolves.toEqual({ detected: 'cmd.exe', options: ['auto', 'cmd'] })
  })

  it('uses the real selection by default', async () => {
    const result = await createShellInfo()()
    expect(result.detected.length).toBeGreaterThan(0)
  })
})
