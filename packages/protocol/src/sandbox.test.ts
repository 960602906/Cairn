import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_PROFILE,
  DEFAULT_SANDBOX_UNAVAILABLE,
  SandboxCapability,
  SandboxPolicy,
  sandboxExecution,
} from './sandbox.js'
import { Settings, SettingsPatch } from './contracts/renderer-main.js'

const capability = (
  options: {
    available?: boolean
    mechanism?: 'restricted-token' | 'appcontainer' | 'none'
    networkIsolated?: boolean
  } = {},
) => ({
  available: options.available ?? true,
  mechanism: options.mechanism ?? ('restricted-token' as const),
  networkIsolated: options.networkIsolated ?? false,
})

describe('sandbox protocol', () => {
  it('has conservative defaults', () => {
    expect(DEFAULT_SANDBOX_PROFILE).toBe('workspace-write')
    expect(DEFAULT_SANDBOX_NETWORK).toBe('none')
    expect(DEFAULT_SANDBOX_UNAVAILABLE).toBe('deny')
  })

  it('parses policies, capability and executions', () => {
    expect(SandboxPolicy.parse({ profile: 'read-only', network: 'none' })).toEqual({
      profile: 'read-only',
      network: 'none',
    })
    expect(
      SandboxCapability.parse({
        available: true,
        supported: true,
        mechanism: 'restricted-token',
        networkIsolated: false,
        checks: {
          restrictedToken: true,
          lowIntegrity: true,
          jobObject: true,
          appContainer: false,
        },
      }).available,
    ).toBe(true)
    expect(() => SandboxPolicy.parse({ profile: 'workspace-write', network: 'all' })).toThrow()
  })

  it('describes full access as not enforced', () => {
    expect(
      sandboxExecution({ profile: 'danger-full-access', network: 'internet' }, capability()),
    ).toEqual({
      profile: 'danger-full-access',
      network: 'internet',
      mechanism: 'none',
      enforced: false,
      networkIsolated: false,
      reason: 'sandbox.full_access',
    })
  })

  it('describes an unavailable sandbox as not enforced', () => {
    expect(
      sandboxExecution(
        { profile: 'workspace-write', network: 'none' },
        capability({ available: false }),
      ),
    ).toMatchObject({ mechanism: 'none', enforced: false, reason: 'sandbox.unavailable' })
    expect(
      sandboxExecution(
        { profile: 'workspace-write', network: 'none' },
        capability({ mechanism: 'none' }),
      ).reason,
    ).toBe('sandbox.unavailable')
  })

  it('reports whether the mechanism isolates the network', () => {
    expect(
      sandboxExecution(
        { profile: 'workspace-write', network: 'internet' },
        capability({ networkIsolated: false }),
      ),
    ).toMatchObject({ mechanism: 'restricted-token', enforced: true, networkIsolated: false })
    expect(
      sandboxExecution(
        { profile: 'read-only', network: 'internet' },
        capability({ mechanism: 'appcontainer', networkIsolated: true }),
      ),
    ).toMatchObject({ mechanism: 'appcontainer', enforced: true, networkIsolated: true })
  })

  it('cannot persist danger-full-access or an unknown profile in settings', () => {
    expect(
      Settings.safeParse({ locale: 'zh-CN', providers: [], sandboxProfile: 'read-only' }).success,
    ).toBe(true)
    expect(
      Settings.safeParse({ locale: 'zh-CN', providers: [], sandboxProfile: 'danger-full-access' })
        .success,
    ).toBe(false)
    expect(SettingsPatch.safeParse({ sandboxProfile: 'danger-full-access' }).success).toBe(false)
    expect(
      SettingsPatch.safeParse({
        sandboxNetwork: 'private',
        sandboxUnavailable: 'ask',
      }).success,
    ).toBe(true)
  })
})
