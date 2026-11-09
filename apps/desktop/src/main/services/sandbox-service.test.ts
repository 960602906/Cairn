import { describe, expect, it, vi } from 'vitest'
import type { SandboxCapability, SandboxNativeApi, SandboxRunner } from '@cairn/shell'
import type { Settings } from '@cairn/protocol'
import { createSandboxService } from './sandbox-service.js'

const capability = (overrides: Partial<SandboxCapability> = {}): SandboxCapability => ({
  available: true,
  supported: true,
  mechanism: 'restricted-token',
  networkIsolated: false,
  checks: { restrictedToken: true, lowIntegrity: true, jobObject: true, appContainer: false },
  ...overrides,
})

const runner: SandboxRunner = {
  capability: capability(),
  executionFor: () => ({
    profile: 'workspace-write',
    network: 'none',
    mechanism: 'restricted-token',
    enforced: true,
    networkIsolated: false,
  }),
  run: async () => {
    throw new Error('not used')
  },
}

const nativeApi = (deleted: string[]): SandboxNativeApi =>
  ({
    deleteAppContainer: (name: string) => deleted.push(name),
  }) as unknown as SandboxNativeApi

function setup(
  options: {
    settings?: Partial<Settings>
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    probe?: (mechanism: 'restricted-token' | 'appcontainer') => Promise<SandboxCapability>
    createRunner?: () => Promise<SandboxRunner>
    api?: () => Promise<SandboxNativeApi | undefined>
  } = {},
) {
  const onError = vi.fn()
  const settings: Settings = {
    locale: 'zh-CN',
    providers: [],
    ...options.settings,
  }
  const probe = vi.fn(options.probe ?? (async () => capability()))
  const createRunner = vi.fn(options.createRunner ?? (async () => runner))
  const service = createSandboxService({
    platform: options.platform ?? 'win32',
    env: options.env ?? {},
    settings: () => settings,
    identity: 'Cairn|C:\\Users\\someone\\AppData',
    probe,
    createRunner,
    onError,
    ...(options.api ? { api: options.api } : {}),
  })
  return { service, probe, createRunner, onError, settings }
}

describe('createSandboxService', () => {
  it('defaults the platform and environment to the current process', async () => {
    const probe = vi.fn(async () => capability())
    const service = createSandboxService({
      settings: () => ({ locale: 'zh-CN', providers: [] }),
      identity: 'Cairn|C:\\Users\\someone\\AppData',
      probe,
    })
    await expect(service.capability()).resolves.toEqual(capability())
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('uses the built-in probe and runner when none are injected', async () => {
    const unsupported = createSandboxService({
      platform: 'linux',
      settings: () => ({ locale: 'zh-CN', providers: [] }),
      identity: 'x',
    })
    expect(await unsupported.capability()).toMatchObject({
      available: false,
      supported: false,
      reason: 'sandbox.platform_unsupported',
    })

    const supported = createSandboxService({
      platform: 'linux',
      env: { CAIRN_SANDBOX_MECHANISM: 'appcontainer' },
      settings: () => ({ locale: 'zh-CN', providers: [] }),
      identity: 'x',
      probe: async () => capability({ mechanism: 'appcontainer', networkIsolated: true }),
    })
    const commands = await supported.forCommands()
    expect(commands?.runner.capability.mechanism).toBe('appcontainer')
    expect(commands?.policy).toEqual({ profile: 'workspace-write', network: 'none' })
    await expect(supported.cleanup()).resolves.toBeUndefined()

    const plain = createSandboxService({
      platform: 'linux',
      env: {},
      settings: () => ({ locale: 'zh-CN', providers: [] }),
      identity: 'x',
      probe: async () => capability(),
    })
    expect((await plain.forCommands())?.runner.capability.mechanism).toBe('restricted-token')
  })

  it('uses workspace-write with no network and deny-on-unavailable by default', async () => {
    const { service } = setup()
    expect(service.policy()).toEqual({ profile: 'workspace-write', network: 'none' })
    expect(service.unavailable()).toBe('deny')
    expect(await service.execution()).toMatchObject({
      profile: 'workspace-write',
      mechanism: 'restricted-token',
      enforced: true,
    })
  })

  it('reads the sandbox settings and ignores nothing silently', async () => {
    const { service } = setup({
      settings: {
        sandboxProfile: 'read-only',
        sandboxNetwork: 'private',
        sandboxUnavailable: 'ask',
      },
    })
    expect(service.policy()).toEqual({ profile: 'read-only', network: 'private' })
    expect(service.unavailable()).toBe('ask')
    expect(await service.hostInit()).toMatchObject({
      policy: { profile: 'read-only', network: 'private' },
      unavailable: 'ask',
    })
  })

  it('probes the capability once and reuses it', async () => {
    const { service, probe } = setup()
    await service.capability()
    await service.capability()
    await service.execution()
    await service.hostInit()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('fails closed with a diagnosable reason when probing throws', async () => {
    const { service, onError, probe } = setup({
      probe: async () => {
        throw new Error('probe boom')
      },
    })
    const result = await service.capability()
    expect(result).toMatchObject({
      available: false,
      supported: true,
      mechanism: 'none',
      reason: 'sandbox.probe_failed',
    })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'probe boom' }))
    expect(await service.execution()).toMatchObject({
      mechanism: 'none',
      enforced: false,
      reason: 'sandbox.probe_failed',
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
  })

  it('marks a non-Windows platform as unsupported when probing throws', async () => {
    const { service } = setup({
      platform: 'linux',
      probe: async () => {
        throw new Error('nope')
      },
    })
    expect(await service.capability()).toMatchObject({ supported: false })
  })

  it('does not hand out a runner when the sandbox is unavailable', async () => {
    const { service, createRunner } = setup({
      probe: async () =>
        capability({ available: false, mechanism: 'none', reason: 'sandbox.native_unavailable' }),
    })
    expect(await service.forCommands()).toBeUndefined()
    expect(createRunner).not.toHaveBeenCalled()
    expect(await service.execution()).toMatchObject({
      mechanism: 'none',
      enforced: false,
      reason: 'sandbox.native_unavailable',
    })
  })

  it('creates the runner from the probed capability for background commands', async () => {
    const { service, createRunner } = setup()
    const commands = await service.forCommands()
    expect(commands).toEqual({
      runner,
      policy: { profile: 'workspace-write', network: 'none' },
    })
    expect(createRunner).toHaveBeenCalledWith({
      mechanism: 'restricted-token',
      capability: capability(),
    })
    await service.forCommands()
    expect(createRunner).toHaveBeenCalledTimes(1)
  })

  it('retries runner creation after a failure and reports the error', async () => {
    const createRunner = vi
      .fn<() => Promise<SandboxRunner>>()
      .mockRejectedValueOnce(new Error('koffi missing'))
      .mockResolvedValue(runner)
    const { service, onError } = setup({ createRunner })
    await expect(service.forCommands()).rejects.toThrow('koffi missing')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'koffi missing' }))
    expect(await service.forCommands()).toMatchObject({ runner })
  })

  it('derives a stable, opaque AppContainer name only for the experimental mechanism', async () => {
    const first = setup({ env: { CAIRN_SANDBOX_MECHANISM: 'appcontainer' } })
    const second = setup({ env: { CAIRN_SANDBOX_MECHANISM: 'appcontainer' } })
    const init = await first.service.hostInit()
    expect(init.appContainerName).toBe((await second.service.hostInit()).appContainerName)
    expect(init.appContainerName).toMatch(/^com\.cairn\.sandbox\.[a-f0-9]{1,50}$/)
    expect(init.appContainerName).not.toContain('someone')
    await first.service.forCommands()
    expect(first.createRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        mechanism: 'appcontainer',
        appContainerName: init.appContainerName,
      }),
    )

    const otherIdentity = createSandboxService({
      platform: 'win32',
      env: { CAIRN_SANDBOX_MECHANISM: 'appcontainer' },
      settings: () => ({ locale: 'zh-CN', providers: [] }),
      identity: 'Cairn|D:\\other',
      probe: async () => capability(),
      createRunner: async () => runner,
    })
    expect((await otherIdentity.hostInit()).appContainerName).not.toBe(init.appContainerName)
    expect((await setup().service.hostInit()).appContainerName).toBeUndefined()
  })

  it('reports diagnostics without paths or user names', async () => {
    const { service } = setup()
    const diagnostics = await service.diagnostics()
    expect(diagnostics).toEqual({
      platform: 'win32',
      mechanism: 'restricted-token',
      policy: { profile: 'workspace-write', network: 'none' },
      unavailable: 'deny',
      capability: capability(),
    })
    const text = JSON.stringify(diagnostics)
    expect(text).not.toContain('someone')
    expect(text).not.toContain('AppData')
    expect((await setup({ platform: 'linux' }).service.diagnostics()).platform).toBe('other')
  })

  it('deletes the experimental AppContainer profile on cleanup only when named', async () => {
    const deleted: string[] = []
    const appContainer = setup({
      env: { CAIRN_SANDBOX_MECHANISM: 'appcontainer' },
      api: async () => nativeApi(deleted),
    })
    await appContainer.service.cleanup()
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatch(/^com\.cairn\.sandbox\./)

    const restricted = setup({ api: async () => nativeApi(deleted) })
    await restricted.service.cleanup()
    expect(deleted).toHaveLength(1)

    const missingApi = setup({
      env: { CAIRN_SANDBOX_MECHANISM: 'appcontainer' },
      api: async () => undefined,
    })
    await expect(missingApi.service.cleanup()).resolves.toBeUndefined()
  })
})
