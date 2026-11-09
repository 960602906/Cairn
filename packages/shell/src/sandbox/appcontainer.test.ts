import { describe, expect, it, vi } from 'vitest'
import { appContainerName, createContainerAcl, networkCapabilities } from './appcontainer.js'
import { SandboxError } from './types.js'

describe('networkCapabilities', () => {
  it('maps policies to capability SIDs', () => {
    expect(networkCapabilities('none')).toEqual([])
    expect(networkCapabilities('internet')).toEqual(['S-1-15-3-1'])
    expect(networkCapabilities('private')).toEqual(['S-1-15-3-3'])
  })
})

describe('appContainerName', () => {
  it('keeps a stable, lowercase, length-limited name', () => {
    expect(appContainerName('ABC-123')).toBe('com.cairn.sandbox.abc123')
    expect(appContainerName('x'.repeat(80))).toBe(`com.cairn.sandbox.${'x'.repeat(50)}`)
  })

  it('rejects an empty identity', () => {
    expect(() => appContainerName('---')).toThrow(SandboxError)
  })
})

describe('createContainerAcl', () => {
  it('grants read or modify and revokes the SID', async () => {
    const run = vi.fn(async () => 0)
    const acl = createContainerAcl({ run })
    await acl.grant('C:\\work', 'S-1-15-2-1', 'read')
    await acl.grant('C:\\work', 'S-1-15-2-1', 'modify')
    await acl.revoke('C:\\work', 'S-1-15-2-1')
    expect(run.mock.calls).toEqual([
      [['C:\\work', '/grant', '*S-1-15-2-1:(OI)(CI)(RX)']],
      [['C:\\work', '/grant', '*S-1-15-2-1:(OI)(CI)(M)']],
      [['C:\\work', '/remove:g', '*S-1-15-2-1']],
    ])
  })

  it('fails closed on errors', async () => {
    const acl = createContainerAcl({
      run: async () => {
        throw new Error('boom')
      },
    })
    const error = await acl.grant('C:\\work', 'S-1-15-2-1', 'read').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxError)
    expect((error as SandboxError).message).toContain('boom')
    const failed = createContainerAcl({ run: async () => 9 })
    const codeError = await failed.revoke('C:\\work', 'S-1').catch((e: unknown) => e)
    expect(codeError).toMatchObject({ params: { exitCode: '9' } })
  })
})
