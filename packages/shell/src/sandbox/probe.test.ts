import { describe, expect, it } from 'vitest'
import type { JobObject } from '../job-object.js'
import { probeCapability } from './probe.js'
import type { SandboxNativeApi } from './windows-api.js'

const job = (): JobObject => ({
  assign: () => true,
  terminate: () => true,
  close: () => undefined,
})

function api(overrides: Partial<SandboxNativeApi> = {}): SandboxNativeApi {
  return {
    currentUserSid: () => 'S-1-5-21-1',
    createRestrictedToken: () => 1n,
    openInheritableFile: () => 2n,
    openNul: () => 3n,
    closeHandle: () => undefined,
    resumeThread: () => undefined,
    spawn: () => ({ pid: 1, process: 4n, thread: 5n }),
    hasExited: () => true,
    exitCode: () => 0,
    terminate: () => undefined,
    appContainer: () => ({ sid: 6n, sidString: 'S-1-15-2-1' }),
    deriveAppContainer: () => 6n,
    deleteAppContainer: () => undefined,
    sidFromString: () => 7n,
    sidToString: () => 'S-1-15-2-1',
    ...overrides,
  }
}

describe('probeCapability', () => {
  it('reports unsupported on non-Windows platforms', async () => {
    const capability = await probeCapability({ platform: 'linux' })
    expect(capability).toMatchObject({
      supported: false,
      available: false,
      mechanism: 'none',
      reason: 'sandbox.platform_unsupported',
    })
  })

  it('reports native API load failure on Windows', async () => {
    const capability = await probeCapability({ platform: 'win32', api: null })
    expect(capability).toMatchObject({
      supported: true,
      available: false,
      reason: 'sandbox.native_unavailable',
    })
  })

  it('requires the restricted token, low integrity and job object', async () => {
    const capability = await probeCapability({
      platform: 'win32',
      api: api(),
      jobFactory: async () => job(),
    })
    expect(capability).toMatchObject({
      available: true,
      mechanism: 'restricted-token',
      networkIsolated: false,
      checks: {
        restrictedToken: true,
        lowIntegrity: true,
        jobObject: true,
        appContainer: true,
      },
    })
  })

  it('fails closed without a token or job object', async () => {
    const noToken = await probeCapability({
      platform: 'win32',
      api: api({
        createRestrictedToken: () => {
          throw new Error('denied')
        },
      }),
      jobFactory: async () => job(),
    })
    expect(noToken).toMatchObject({
      available: false,
      mechanism: 'none',
      reason: 'sandbox.restricted_token_unavailable',
      checks: { restrictedToken: false, jobObject: true },
    })
    const noJob = await probeCapability({
      platform: 'win32',
      api: api(),
      jobFactory: async () => undefined,
    })
    expect(noJob).toMatchObject({ available: false, checks: { jobObject: false } })
  })

  it('selects AppContainer only when requested and available', async () => {
    const appcontainer = await probeCapability({
      platform: 'win32',
      api: api(),
      mechanism: 'appcontainer',
      jobFactory: async () => job(),
    })
    expect(appcontainer).toMatchObject({
      available: true,
      mechanism: 'appcontainer',
      networkIsolated: true,
    })
    const unavailable = await probeCapability({
      platform: 'win32',
      api: api({
        deriveAppContainer: () => {
          throw new Error('missing')
        },
      }),
      mechanism: 'appcontainer',
      jobFactory: async () => job(),
    })
    expect(unavailable).toMatchObject({
      available: true,
      mechanism: 'restricted-token',
      reason: 'sandbox.appcontainer_unavailable',
    })
  })

  it('reports AppContainer unavailable when restricted token also fails', async () => {
    const capability = await probeCapability({
      platform: 'win32',
      api: api({
        createRestrictedToken: () => {
          throw new Error('denied')
        },
        deriveAppContainer: () => {
          throw new Error('missing')
        },
      }),
      mechanism: 'appcontainer',
      jobFactory: async () => job(),
    })
    expect(capability).toMatchObject({
      available: false,
      reason: 'sandbox.appcontainer_unavailable',
    })
  })
})
