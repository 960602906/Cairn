import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsPatch, UpdateChannel } from '@cairn/protocol'
import {
  AUTO_CHECK_INITIAL_MS,
  AUTO_CHECK_INTERVAL_MS,
  classifyUpdateError,
  compareVersions,
  createUpdateService,
  parseVersion,
  resolveElectronUpdater,
  type UpdaterAdapter,
  type UpdateBusyState,
  type UpdateProgressInfo,
} from './update-service.js'
import { listUpdateBackups } from './update-backup.js'

const electronUpdater = vi.hoisted(() => {
  const handlers = new Map<string, Set<(info: unknown) => void>>()
  class CancellationToken {
    readonly cancel = vi.fn()
  }
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    forceDevUpdateConfig: false,
    verifyUpdateCodeSignature: undefined as
      ((publisherNames: string[], path: string) => Promise<string | null>) | undefined,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, handler: (info: unknown) => void) => {
      const set = handlers.get(event) ?? new Set<(info: unknown) => void>()
      set.add(handler)
      handlers.set(event, set)
      return autoUpdater
    }),
    removeListener: vi.fn((event: string, handler: (info: unknown) => void) => {
      handlers.get(event)?.delete(handler)
      return autoUpdater
    }),
  }
  return { autoUpdater, CancellationToken, handlers }
})

vi.mock('electron-updater', () => ({
  autoUpdater: electronUpdater.autoUpdater,
  CancellationToken: electronUpdater.CancellationToken,
}))

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cairn-update-'))
  roots.push(root)
  return root
}

class FakeUpdater implements UpdaterAdapter {
  readonly configure = vi.fn()
  readonly check = vi.fn()
  readonly download = vi.fn()
  readonly cancel = vi.fn()
  readonly quitAndInstall = vi.fn()
  readonly progress = new Set<(progress: UpdateProgressInfo) => void>()

  onProgress(listener: (progress: UpdateProgressInfo) => void): () => void {
    this.progress.add(listener)
    return () => this.progress.delete(listener)
  }

  emitProgress(progress: UpdateProgressInfo): void {
    for (const listener of this.progress) listener(progress)
  }
}

interface HarnessOptions {
  readonly packaged?: boolean
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly sourceUrl?: string
  /** 让配置在运行时读取 `CAIRN_UPDATE_URL`，便于测试环境变化。 */
  readonly sourceFromEnv?: boolean
  readonly publisherName?: string
  readonly settings?: {
    updateAutoCheck?: boolean
    updateChannel?: UpdateChannel
    updateLastCheckedAt?: number
    updateSkippedVersion?: string
  }
  readonly busy?: Partial<UpdateBusyState>
  readonly free?: number | undefined
  readonly defaultFreeBytes?: boolean
  readonly defaultTimers?: boolean
  /** 使用真实的 `createElectronUpdater` 适配器（配合 `electron-updater` mock）。 */
  readonly defaultUpdater?: boolean
  readonly noIsBusy?: boolean
  readonly dataDir?: string
  readonly verifier?: (names: readonly string[], file: string) => Promise<string | null>
  readonly allowDevelopment?: boolean
}

function setup(options: HarnessOptions = {}) {
  const root = tempRoot()
  const databaseFile = join(root, 'cairn.db')
  const settingsFile = join(root, 'settings.json')
  const credentialsFile = join(root, 'credentials.json')
  writeFileSync(databaseFile, 'database')
  writeFileSync(settingsFile, '{"locale":"zh-CN"}\n')
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      version: 1,
      credentials: {
        openai: { kind: 'local-key', ciphertext: 'ciphertext-value', updatedAt: 10 },
      },
    }),
  )

  const settingsState: {
    updateAutoCheck?: boolean
    updateChannel?: UpdateChannel
    updateLastCheckedAt?: number
    updateSkippedVersion?: string | undefined
  } = { ...options.settings }
  const settings = {
    get: vi.fn(() => ({ ...settingsState })),
    update: vi.fn((patch: SettingsPatch) => {
      if (patch.updateLastCheckedAt !== undefined) {
        settingsState.updateLastCheckedAt = patch.updateLastCheckedAt
      }
      if (patch.updateChannel !== undefined) settingsState.updateChannel = patch.updateChannel
      if (patch.updateSkippedVersion !== undefined) {
        settingsState.updateSkippedVersion = patch.updateSkippedVersion ?? undefined
      }
      return settingsState
    }),
  }
  const busy = { runningSessions: 0, pendingApprovals: 0, restoringCheckpoints: 0, ...options.busy }
  const updater = new FakeUpdater()
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const onError = vi.fn()
  let time = 1_000
  const service = createUpdateService({
    currentVersion: '0.1.0',
    buildChannel: 'beta',
    packaged: options.packaged ?? true,
    platform: options.platform ?? 'win32',
    env: options.env ?? {},
    ...(options.sourceFromEnv
      ? {}
      : { sourceUrl: options.sourceUrl ?? 'https://updates.example/cairn/' }),
    ...(options.publisherName !== undefined ? { publisherName: options.publisherName } : {}),
    ...(options.allowDevelopment !== undefined
      ? { allowDevelopment: options.allowDevelopment }
      : {}),
    settings,
    backup: {
      root: join(root, 'backups'),
      databaseFile,
      settingsFile,
      credentialsFile,
      backupDatabase: (destination) => writeFileSync(destination, 'backup-database'),
    },
    dataDir: options.dataDir ?? root,
    ...(options.defaultFreeBytes ? {} : { freeBytes: () => options.free }),
    ...(options.noIsBusy ? {} : { isBusy: () => busy }),
    verifier: options.verifier ?? (async () => null),
    ...(options.defaultUpdater ? {} : { createUpdater: async () => updater }),
    now: () => (time += 1),
    ...(options.defaultTimers
      ? {}
      : {
          schedule: (fn: () => void, ms: number) => {
            const entry = { fn, ms, cancelled: false }
            scheduled.push(entry)
            return entry
          },
          cancelSchedule: (handle: unknown) => {
            ;(handle as { cancelled: boolean }).cancelled = true
          },
        }),
    onError,
  })
  return {
    root,
    service,
    updater,
    settings,
    settingsState,
    busy,
    scheduled,
    onError,
    databaseFile,
    settingsFile,
    credentialsFile,
  }
}

const available = (version = '0.1.1', extra: Record<string, unknown> = {}) => ({
  isUpdateAvailable: true,
  info: {
    version,
    releaseDate: '2026-11-10T00:00:00.000Z',
    files: [{ size: 1024 }],
    ...extra,
  },
})

describe('version helpers', () => {
  it('parses and compares semantic versions', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0, []])
    expect(parseVersion('v1.2.3-beta.1+abc')).toEqual([1, 2, 3, ['beta', '1']])
    expect(parseVersion('1.2')).toBeUndefined()
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0)
    expect(compareVersions('bad', '1.0.0')).toBeUndefined()
  })

  it('classifies updater and network errors', () => {
    expect(classifyUpdateError({ code: 'ERR_UPDATER_INVALID_SIGNATURE' }, 'x').code).toBe(
      'update.signature_invalid',
    )
    expect(classifyUpdateError(new Error('sha512 checksum mismatch'), 'x').code).toBe(
      'update.verification_failed',
    )
    expect(classifyUpdateError({ code: 'ENOSPC' }, 'x').code).toBe('update.insufficient_space')
    expect(classifyUpdateError({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }, 'x').code).toBe(
      'update.not_found',
    )
    expect(classifyUpdateError({ statusCode: 404 }, 'x').code).toBe('update.not_found')
    expect(classifyUpdateError({ code: 'ERR_UPDATER_INVALID_VERSION' }, 'x').code).toBe(
      'update.version_invalid',
    )
    expect(classifyUpdateError(new Error('download cancelled'), 'x').code).toBe('update.cancelled')
    expect(classifyUpdateError({ code: 'ECONNREFUSED' }, 'x').code).toBe('update.network')
    expect(classifyUpdateError(new Error('proxy failure'), 'x').code).toBe('update.network')
    expect(classifyUpdateError(new Error('boom'), 'update.check_failed')).toMatchObject({
      code: 'update.check_failed',
      retryable: true,
    })
    expect(classifyUpdateError('boom', 'update.check_failed')).toMatchObject({
      code: 'update.check_failed',
      retryable: true,
    })
  })
})

describe('resolveElectronUpdater', () => {
  const updater = {} as never
  class CancellationToken {
    readonly cancel = vi.fn()
  }

  it('accepts both named and default export shapes', () => {
    expect(resolveElectronUpdater({ autoUpdater: updater, CancellationToken })).toEqual({
      updater,
      CancellationToken,
    })
    expect(
      resolveElectronUpdater({ default: { autoUpdater: updater, CancellationToken } }),
    ).toEqual({ updater, CancellationToken })
  })

  it('fails closed when autoUpdater or CancellationToken is missing', () => {
    expect(resolveElectronUpdater({})).toBeUndefined()
    expect(resolveElectronUpdater({ autoUpdater: updater })).toBeUndefined()
    expect(resolveElectronUpdater({ default: { CancellationToken } })).toBeUndefined()
  })
})

describe('createUpdateService: configuration', () => {
  it('disables updates in development mode and with CAIRN_UPDATE_DISABLE=1', () => {
    const development = setup({ packaged: false })
    expect(development.service.status()).toMatchObject({
      phase: 'disabled',
      enabled: false,
      disabledReason: 'update.not_packaged',
    })
    const disabled = setup({ env: { CAIRN_UPDATE_DISABLE: '1' } })
    expect(disabled.service.status()).toMatchObject({
      enabled: false,
      disabledReason: 'update.disabled_by_env',
    })
    const allowed = setup({ packaged: false, allowDevelopment: true })
    expect(allowed.service.status()).toMatchObject({ enabled: true, phase: 'idle' })
  })

  it('rejects unsupported platforms, missing or insecure sources', () => {
    expect(setup({ platform: 'linux' }).service.status()).toMatchObject({
      enabled: false,
      disabledReason: 'update.platform_unsupported',
    })
    expect(setup({ sourceUrl: '' }).service.status()).toMatchObject({
      disabledReason: 'update.source_missing',
    })
    for (const source of [
      'http://updates.example/cairn/',
      'not a url',
      ['https://user:secret', '@updates.example/cairn/'].join(''),
      'https://updates.example/cairn/?token=x',
      'https://updates.example/cairn/#x',
    ]) {
      expect(setup({ sourceUrl: source }).service.status()).toMatchObject({
        enabled: false,
        disabledReason: 'update.source_insecure',
      })
    }
  })

  it('validates the channel and requires a publisher DN for stable', () => {
    expect(setup({ env: { CAIRN_UPDATE_CHANNEL: 'nightly' } }).service.status()).toMatchObject({
      enabled: false,
      disabledReason: 'update.channel_invalid',
    })
    expect(setup({ settings: { updateChannel: 'stable' } }).service.status()).toMatchObject({
      enabled: false,
      disabledReason: 'update.publisher_missing',
    })
    expect(
      setup({
        settings: { updateChannel: 'stable' },
        publisherName: 'CN=Cairn, O=Cairn',
      }).service.status(),
    ).toMatchObject({ enabled: true, channel: 'stable' })
  })

  it('normalizes the source and respects a pinned environment channel', () => {
    const { service } = setup({
      sourceUrl: 'https://updates.example/cairn',
      env: { CAIRN_UPDATE_CHANNEL: 'beta' },
      settings: { updateChannel: 'stable' },
    })
    expect(service.status()).toMatchObject({
      enabled: true,
      channel: 'beta',
      source: 'https://updates.example/cairn/',
      autoCheck: true,
    })
  })

  it('reads the source from the environment and keeps the persisted check time', () => {
    const { service } = setup({
      sourceFromEnv: true,
      env: { CAIRN_UPDATE_URL: 'https://env.example/cairn' },
      settings: { updateLastCheckedAt: 1234 },
    })
    expect(service.status()).toMatchObject({
      enabled: true,
      source: 'https://env.example/cairn/',
      lastCheckedAt: 1234,
    })
  })

  it('disables updates when neither options nor the environment provide a source', () => {
    const { service } = setup({ sourceFromEnv: true, env: {} })
    expect(service.status()).toMatchObject({
      enabled: false,
      disabledReason: 'update.source_missing',
    })
  })
})

describe('createUpdateService: checking', () => {
  it('reports up to date and persists the check time', async () => {
    const { service, updater, settings, scheduled } = setup()
    service.start()
    updater.check.mockResolvedValue({ isUpdateAvailable: false, info: { version: '0.1.0' } })
    const status = await service.check({})
    expect(status.phase).toBe('up_to_date')
    expect(status.lastCheckedAt).toBeGreaterThan(0)
    expect(settings.update).toHaveBeenCalledWith({ updateLastCheckedAt: status.lastCheckedAt })
    expect(scheduled.at(-1)?.ms).toBe(AUTO_CHECK_INTERVAL_MS)
  })

  it('reports an available update with release date and staging 100', async () => {
    const { service, updater } = setup()
    updater.check.mockResolvedValue(available('0.1.1', { stagingPercentage: 100 }))
    const status = await service.check({})
    expect(status).toMatchObject({
      phase: 'available',
      availableVersion: '0.1.1',
      releaseDate: Date.parse('2026-11-10T00:00:00.000Z'),
      stagingPercentage: 100,
      requiresRestart: false,
    })
  })

  it('allows updates without a release date or with an invalid one', async () => {
    const missing = setup()
    missing.updater.check.mockResolvedValue(available('0.1.1', { releaseDate: undefined }))
    const withoutDate = await missing.service.check({})
    expect(withoutDate.phase).toBe('available')
    expect(withoutDate.releaseDate).toBeUndefined()

    const invalid = setup()
    invalid.updater.check.mockResolvedValue(available('0.1.1', { releaseDate: 'not-a-date' }))
    const withInvalidDate = await invalid.service.check({})
    expect(withInvalidDate.phase).toBe('available')
    expect(withInvalidDate.releaseDate).toBeUndefined()
  })

  it('skips a skipped version unless forced', async () => {
    const { service, updater } = setup({ settings: { updateSkippedVersion: '0.1.1' } })
    updater.check.mockResolvedValue(available())
    await expect(service.check({})).resolves.toMatchObject({ phase: 'skipped' })
    await expect(service.check({ force: true })).resolves.toMatchObject({ phase: 'available' })
  })

  it('does not offer old versions or invalid versions', async () => {
    const downgrade = setup()
    downgrade.updater.check.mockResolvedValue(available('0.0.9'))
    await expect(downgrade.service.check({})).resolves.toMatchObject({ phase: 'up_to_date' })

    const same = setup()
    same.updater.check.mockResolvedValue(available('0.1.0'))
    await expect(same.service.check({})).resolves.toMatchObject({ phase: 'up_to_date' })

    const invalid = setup()
    invalid.updater.check.mockResolvedValue(available('not-a-version'))
    await expect(invalid.service.check({})).resolves.toMatchObject({
      phase: 'error',
      error: { code: 'update.version_invalid' },
    })
  })

  it('treats staging below 100 as not offered and rejects invalid staging', async () => {
    const staged = setup()
    staged.updater.check.mockResolvedValue(available('0.1.1', { stagingPercentage: 10 }))
    await expect(staged.service.check({})).resolves.toMatchObject({
      phase: 'up_to_date',
      stagingPercentage: 10,
    })
    const invalid = setup()
    invalid.updater.check.mockResolvedValue(available('0.1.1', { stagingPercentage: 101 }))
    await expect(invalid.service.check({})).resolves.toMatchObject({
      phase: 'error',
      error: { code: 'update.invalid_manifest' },
    })
  })

  it('maps check failures and keeps the service usable', async () => {
    const { service, updater } = setup()
    updater.check.mockRejectedValue({ statusCode: 404, message: 'missing' })
    await expect(service.check({})).resolves.toMatchObject({
      phase: 'error',
      error: { code: 'update.not_found' },
    })
    updater.check.mockResolvedValue(available())
    await expect(service.check({})).resolves.toMatchObject({ phase: 'available' })
  })

  it('does not run overlapping checks and ignores checks while downloading', async () => {
    const { service, updater } = setup()
    let resolveCheck: ((value: unknown) => void) | undefined
    updater.check.mockImplementation(() => new Promise((resolve) => (resolveCheck = resolve)))
    const first = service.check({})
    const second = service.check({})
    expect(second).toBe(first)
    await vi.waitFor(() => expect(resolveCheck).toBeDefined())
    resolveCheck?.(available())
    await expect(first).resolves.toMatchObject({ phase: 'available' })
    expect(updater.check).toHaveBeenCalledTimes(1)
  })

  it('returns disabled without calling the updater when disabled', async () => {
    const { service, updater } = setup({ packaged: false })
    await expect(service.check({})).resolves.toMatchObject({ phase: 'disabled' })
    expect(updater.check).not.toHaveBeenCalled()
  })

  it('keeps the last check time when a later check finds nothing', async () => {
    const { service, updater } = setup()
    updater.check.mockResolvedValue({ isUpdateAvailable: false, info: { version: '0.1.0' } })
    const first = await service.check({})
    const second = await service.check({})
    expect(second.lastCheckedAt).toBeGreaterThanOrEqual(first.lastCheckedAt!)
  })

  it('rechecks its configuration after listeners observe the checking phase', async () => {
    const env: NodeJS.ProcessEnv = { CAIRN_UPDATE_URL: 'https://updates.example/cairn/' }
    const harness = setup({ sourceFromEnv: true, env })
    harness.service.subscribe((status) => {
      if (status.phase === 'checking') env['CAIRN_UPDATE_URL'] = ''
    })
    await expect(harness.service.check({})).resolves.toMatchObject({
      phase: 'disabled',
      disabledReason: 'update.source_missing',
    })
    expect(harness.updater.check).not.toHaveBeenCalled()
  })

  it('ignores checks while verifying or installing', async () => {
    let resolveSignature: ((value: string | null) => void) | undefined
    const verifying = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn',
      verifier: () =>
        new Promise<string | null>((resolve) => {
          resolveSignature = resolve
        }),
    })
    const file = join(verifying.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    verifying.updater.check.mockResolvedValue(available())
    verifying.updater.download.mockResolvedValue([file])
    await verifying.service.check({})
    const download = verifying.service.download()
    await vi.waitFor(() => expect(verifying.service.status().phase).toBe('verifying'))
    await expect(verifying.service.check({})).resolves.toMatchObject({ phase: 'verifying' })
    expect(verifying.updater.check).toHaveBeenCalledTimes(1)
    resolveSignature!(null)
    await expect(download).resolves.toMatchObject({ phase: 'downloaded' })

    const installing = setup()
    const packageFile = join(installing.root, 'Cairn-0.1.1.exe')
    writeFileSync(packageFile, 'package')
    installing.updater.check.mockResolvedValue(available())
    installing.updater.download.mockResolvedValue([packageFile])
    await installing.service.check({})
    await installing.service.download()
    const install = installing.service.install()
    await expect(installing.service.check({})).resolves.toMatchObject({ phase: 'installing' })
    await install
    expect(installing.updater.check).toHaveBeenCalledTimes(1)
  })
})

describe('createUpdateService: downloading', () => {
  it('requires a check before downloading', async () => {
    const { service } = setup()
    await expect(service.download()).resolves.toMatchObject({
      error: { code: 'update.not_downloaded' },
    })
  })

  it('disables downloads when the source disappears after checking', async () => {
    const env: NodeJS.ProcessEnv = { CAIRN_UPDATE_URL: 'https://updates.example/cairn/' }
    const { service, updater } = setup({ sourceFromEnv: true, env })
    updater.check.mockResolvedValue(available())
    await service.check({})
    env['CAIRN_UPDATE_URL'] = ''
    await expect(service.download()).resolves.toMatchObject({
      phase: 'disabled',
      disabledReason: 'update.source_missing',
    })
    expect(updater.download).not.toHaveBeenCalled()
  })

  it('downloads, verifies and emits progress', async () => {
    const { service, updater, root } = setup()
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    updater.download.mockResolvedValue([file])
    await service.check({})
    const pending = service.download()
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalled())
    updater.emitProgress({ percent: 50, transferred: 512, total: 1024, bytesPerSecond: 10 })
    const status = await pending
    expect(status).toMatchObject({
      phase: 'downloaded',
      requiresRestart: true,
      signatureVerified: false,
      progress: { percent: 100, transferred: 1024, total: 1024 },
    })
  })

  it('verifies Authenticode when a publisher is configured', async () => {
    const verifier = vi.fn(async () => null)
    const { service, updater, root } = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn, O=Cairn',
      verifier,
    })
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    updater.download.mockResolvedValue([file])
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({
      phase: 'downloaded',
      signatureVerified: true,
    })
    expect(verifier).toHaveBeenCalledWith(['CN=Cairn, O=Cairn'], file)
  })

  it('deletes the package and fails closed on a bad signature', async () => {
    const { service, updater, root } = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn',
      verifier: async () => 'certificate mismatch',
    })
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    updater.download.mockResolvedValue([file])
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({
      phase: 'available',
      error: { code: 'update.signature_invalid' },
      signatureVerified: false,
    })
    expect(existsSync(file)).toBe(false)
  })

  it('rejects a package without an executable when a publisher is configured', async () => {
    const { service, updater, root } = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn',
    })
    const file = join(root, 'package.zip')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    updater.download.mockResolvedValue([file])
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({
      error: { code: 'update.verification_failed' },
    })
  })

  it('checks free disk space before downloading', async () => {
    const { service, updater } = setup({ free: 100 })
    updater.check.mockResolvedValue(available('0.1.1'))
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({
      error: { code: 'update.insufficient_space' },
    })
    expect(updater.download).not.toHaveBeenCalled()
  })

  it('maps download failures and retries', async () => {
    const { service, updater } = setup()
    updater.check.mockResolvedValue(available())
    updater.download.mockRejectedValueOnce({ code: 'ECONNRESET' })
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({
      phase: 'error',
      error: { code: 'update.network' },
    })
    const file = join(tempRoot(), 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.download.mockResolvedValueOnce([file])
    await expect(service.download()).resolves.toMatchObject({ phase: 'downloaded' })
  })

  it('derives progress when the updater omits totals and clamps percentages', async () => {
    const { service, updater, root } = setup()
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    let resolveDownload: ((files: string[]) => void) | undefined
    updater.download.mockImplementation(
      () => new Promise<string[]>((resolve) => (resolveDownload = resolve)),
    )
    await service.check({})
    const pending = service.download()
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalled())
    updater.emitProgress({})
    expect(service.status().progress).toEqual({ percent: 0, transferred: 0, total: 0 })
    updater.emitProgress({ bytesPerSecond: -5 })
    expect(service.status().progress?.bytesPerSecond).toBe(0)
    updater.emitProgress({ transferred: 25, total: 100 })
    expect(service.status().progress).toEqual({ percent: 25, transferred: 25, total: 100 })
    updater.emitProgress({ percent: 500, transferred: 150, total: 100 })
    expect(service.status().progress?.percent).toBe(100)
    resolveDownload?.([file])
    await expect(pending).resolves.toMatchObject({ phase: 'downloaded' })
  })

  it('fails when the updater returns no files and tolerates missing file sizes', async () => {
    const empty = setup()
    empty.updater.check.mockResolvedValue(available())
    empty.updater.download.mockResolvedValue([])
    await empty.service.check({})
    await expect(empty.service.download()).resolves.toMatchObject({
      phase: 'available',
      error: { code: 'update.download_failed' },
    })

    const noFiles = setup()
    const file = join(noFiles.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    noFiles.updater.check.mockResolvedValue(available('0.1.1', { files: undefined }))
    noFiles.updater.download.mockResolvedValue([file])
    await noFiles.service.check({})
    await expect(noFiles.service.download()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(noFiles.service.status().progress).toEqual({
      percent: 100,
      transferred: 0,
      total: 0,
    })

    const unsized = setup()
    const second = join(unsized.root, 'Cairn-0.1.1.exe')
    writeFileSync(second, 'package')
    unsized.updater.check.mockResolvedValue(available('0.1.1', { files: [{}] }))
    unsized.updater.download.mockResolvedValue([second])
    await unsized.service.check({})
    await expect(unsized.service.download()).resolves.toMatchObject({ phase: 'downloaded' })
  })

  it('rounds a cancelled updater rejection back to available', async () => {
    const { service, updater } = setup()
    updater.check.mockResolvedValue(available())
    updater.download.mockRejectedValue(new Error('download cancelled'))
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({
      phase: 'available',
      error: { code: 'update.cancelled' },
    })
  })

  it('ignores a late rejection after the download is cancelled', async () => {
    const { service, updater } = setup()
    updater.check.mockResolvedValue(available())
    let rejectDownload: ((error: Error) => void) | undefined
    updater.download.mockImplementation(
      () => new Promise<string[]>((_resolve, reject) => (rejectDownload = reject)),
    )
    await service.check({})
    const pending = service.download()
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalled())
    await expect(service.cancel()).resolves.toMatchObject({ phase: 'available' })
    rejectDownload?.(new Error('aborted'))
    await expect(pending).resolves.toMatchObject({ phase: 'available' })
  })

  it('returns one promise for concurrent downloads', async () => {
    const { service, updater, root } = setup()
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    let resolveDownload: ((files: string[]) => void) | undefined
    updater.download.mockImplementation(
      () => new Promise<string[]>((resolve) => (resolveDownload = resolve)),
    )
    await service.check({})
    const first = service.download()
    const second = service.download()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(resolveDownload).toBeDefined())
    resolveDownload?.([file])
    await expect(first).resolves.toMatchObject({ phase: 'downloaded' })
    expect(updater.download).toHaveBeenCalledTimes(1)
  })

  it('continues when free disk space cannot be determined', async () => {
    const { service, updater, root } = setup({
      defaultFreeBytes: true,
      dataDir: join(tempRoot(), 'missing'),
    })
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    updater.download.mockResolvedValue([file])
    await service.check({})
    await expect(service.download()).resolves.toMatchObject({ phase: 'downloaded' })
  })

  it('removes downloaded files when a later check finds nothing', async () => {
    const { service, updater, root } = setup()
    const file = join(root, 'Cairn-0.1.1.exe')
    const directory = join(root, 'Cairn-0.1.1.d')
    writeFileSync(file, 'package')
    mkdirSync(directory)
    updater.check.mockResolvedValueOnce(available())
    updater.download.mockResolvedValue([file, directory])
    await service.check({})
    await service.download()
    updater.check.mockResolvedValueOnce({ isUpdateAvailable: false, info: { version: '0.1.0' } })
    await expect(service.check({})).resolves.toMatchObject({ phase: 'up_to_date' })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(directory)).toBe(true)
  })

  it('cancels a download and cleans up a late result', async () => {
    const { service, updater, root } = setup()
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    let resolveDownload: ((files: string[]) => void) | undefined
    updater.download.mockImplementation(
      () => new Promise<string[]>((resolve) => (resolveDownload = resolve)),
    )
    await service.check({})
    const pending = service.download()
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalled())
    await expect(service.cancel()).resolves.toMatchObject({
      phase: 'available',
      error: { code: 'update.cancelled' },
    })
    expect(updater.cancel).toHaveBeenCalled()
    resolveDownload?.([file])
    await expect(pending).resolves.toMatchObject({ phase: 'available' })
    expect(existsSync(file)).toBe(false)
  })

  it('ignores cancel when not downloading', async () => {
    const { service } = setup()
    await expect(service.cancel()).resolves.toMatchObject({ phase: 'idle' })
  })

  it('returns the downloaded status without downloading twice', async () => {
    const { service, updater, root } = setup()
    const file = join(root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    updater.check.mockResolvedValue(available())
    updater.download.mockResolvedValue([file])
    await service.check({})
    await service.download()
    await expect(service.download()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(updater.download).toHaveBeenCalledTimes(1)
  })
})

describe('createUpdateService: installing', () => {
  async function downloaded(options: HarnessOptions = {}) {
    const harness = setup(options)
    const file = join(harness.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    harness.updater.check.mockResolvedValue(available())
    harness.updater.download.mockResolvedValue([file])
    await harness.service.check({})
    await harness.service.download()
    return harness
  }

  it('requires a downloaded update', async () => {
    const { service } = setup()
    await expect(service.install()).resolves.toMatchObject({
      error: { code: 'update.not_downloaded' },
    })
  })

  it('blocks installation while tasks are running', async () => {
    const harness = await downloaded({ busy: { runningSessions: 1 } })
    await expect(harness.service.install()).resolves.toMatchObject({
      phase: 'downloaded',
      error: { code: 'update.busy' },
      blockedReason: 'update.busy',
    })
    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('backs up the database, settings and credential metadata before install', async () => {
    const harness = await downloaded()
    const status = await harness.service.install()
    expect(status).toMatchObject({ phase: 'installing' })
    expect(harness.updater.quitAndInstall).toHaveBeenCalled()
    expect(status.backupPath).toBeDefined()
    const backups = listUpdateBackups(join(harness.root, 'backups'))
    expect(backups).toHaveLength(1)
    expect(backups[0]!.files).toEqual(['cairn.db', 'settings.json', 'credentials-metadata.json'])
    const metadata = readFileSync(join(status.backupPath!, 'credentials-metadata.json'), 'utf8')
    expect(metadata).toContain('openai')
    expect(metadata).not.toContain('ciphertext-value')
  })

  it('fails closed when the backup cannot be written', async () => {
    const harness = await downloaded()
    const broken = createUpdateService({
      currentVersion: '0.1.0',
      buildChannel: 'beta',
      packaged: true,
      settings: {
        get: () => ({}),
        update: () => ({}),
      },
      backup: {
        root: join(harness.root, 'backups'),
        databaseFile: harness.databaseFile,
        settingsFile: harness.settingsFile,
        credentialsFile: harness.credentialsFile,
        backupDatabase: () => {
          throw new Error('database is locked')
        },
      },
      dataDir: harness.root,
      sourceUrl: 'https://updates.example/cairn/',
      createUpdater: async () => harness.updater,
      isBusy: () => ({ runningSessions: 0, pendingApprovals: 0, restoringCheckpoints: 0 }),
    })
    harness.updater.check.mockResolvedValue(available())
    harness.updater.download.mockResolvedValue([join(harness.root, 'Cairn-0.1.1.exe')])
    await broken.check({})
    await broken.download()
    await expect(broken.install()).resolves.toMatchObject({
      phase: 'downloaded',
      error: { code: 'update.backup_failed' },
    })
    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('reports installer failures without losing the downloaded state', async () => {
    const harness = await downloaded()
    harness.updater.quitAndInstall.mockImplementation(() => {
      throw new Error('installer failed')
    })
    await expect(harness.service.install()).resolves.toMatchObject({
      phase: 'downloaded',
      error: { code: 'update.install_failed' },
    })
  })

  it('disables installation when the source disappears after downloading', async () => {
    const env: NodeJS.ProcessEnv = { CAIRN_UPDATE_URL: 'https://updates.example/cairn/' }
    const harness = await downloaded({ sourceFromEnv: true, env })
    env['CAIRN_UPDATE_URL'] = ''
    await expect(harness.service.install()).resolves.toMatchObject({
      phase: 'disabled',
      disabledReason: 'update.source_missing',
    })
    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('createUpdateService: settings and scheduling', () => {
  it('reschedules when settings change and resets a channel switch', async () => {
    const { service, updater, settingsState, scheduled } = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn',
    })
    service.start()
    updater.check.mockResolvedValue(available())
    await service.check({})
    await service.download()
    settingsState.updateChannel = 'beta'
    const status = service.applySettings({ updateChannel: 'beta' })
    expect(status).toMatchObject({ phase: 'idle', channel: 'beta' })
    expect(status.availableVersion).toBeUndefined()
    expect(scheduled.at(-1)?.ms).toBe(AUTO_CHECK_INITIAL_MS)
  })

  it('reflects a skipped version from settings without rechecking', async () => {
    const { service, updater, settingsState } = setup()
    updater.check.mockResolvedValue(available())
    await service.check({})
    settingsState.updateSkippedVersion = '0.1.1'
    expect(service.applySettings({ updateSkippedVersion: '0.1.1' })).toMatchObject({
      phase: 'skipped',
    })
    settingsState.updateSkippedVersion = undefined
    expect(service.applySettings({ updateSkippedVersion: null })).toMatchObject({
      phase: 'available',
    })
  })

  it('schedules the first check after 30 seconds and stops cleanly', async () => {
    const { service, updater, scheduled } = setup()
    updater.check.mockResolvedValue({ isUpdateAvailable: false, info: { version: '0.1.0' } })
    service.start()
    expect(scheduled[0]?.ms).toBe(AUTO_CHECK_INITIAL_MS)
    scheduled[0]!.fn()
    await vi.waitFor(() => expect(updater.check).toHaveBeenCalledTimes(1))
    service.stop()
    expect(scheduled.at(-1)?.cancelled).toBe(true)
  })

  it('does not schedule when automatic checks are disabled', () => {
    const { service, scheduled } = setup({ settings: { updateAutoCheck: false } })
    service.start()
    expect(scheduled).toHaveLength(0)
  })

  it('follows the environment when settings disable and re-enable updates', () => {
    const env: NodeJS.ProcessEnv = { CAIRN_UPDATE_URL: 'https://updates.example/cairn/' }
    const { service } = setup({ sourceFromEnv: true, env })
    expect(service.status()).toMatchObject({ enabled: true, phase: 'idle' })
    env['CAIRN_UPDATE_URL'] = ''
    expect(service.applySettings()).toMatchObject({
      enabled: false,
      phase: 'disabled',
      disabledReason: 'update.source_missing',
    })
    env['CAIRN_UPDATE_URL'] = 'https://updates.example/cairn/'
    expect(service.applySettings()).toMatchObject({ enabled: true, phase: 'idle' })
  })

  it('applies a pinned channel without resetting before the first check', () => {
    const { service } = setup({ env: { CAIRN_UPDATE_CHANNEL: 'beta' } })
    expect(service.applySettings()).toMatchObject({ channel: 'beta', phase: 'idle' })
  })

  it('resets a pending check when the channel changes', async () => {
    const harness = setup({ publisherName: 'CN=Cairn' })
    let resolveCheck: ((value: unknown) => void) | undefined
    harness.updater.check.mockImplementation(
      () => new Promise((resolve) => (resolveCheck = resolve)),
    )
    const pending = harness.service.check({})
    await vi.waitFor(() => expect(harness.updater.configure).toHaveBeenCalled())
    harness.settingsState.updateChannel = 'stable'
    expect(harness.service.applySettings({ updateChannel: 'stable' })).toMatchObject({
      phase: 'idle',
      channel: 'stable',
    })
    resolveCheck?.(available())
    await expect(pending).resolves.toMatchObject({ phase: 'available', channel: 'stable' })
  })

  it('starts only once and uses the default timer functions', async () => {
    vi.useFakeTimers()
    try {
      const { service, updater } = setup({ defaultTimers: true })
      updater.check.mockResolvedValue({ isUpdateAvailable: false, info: { version: '0.1.0' } })
      service.start()
      service.start()
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_INITIAL_MS)
      expect(updater.check).toHaveBeenCalledTimes(1)
      service.stop()
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
      expect(updater.check).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats missing busy state as idle', async () => {
    const harness = await (async () => {
      const value = setup({ noIsBusy: true })
      const file = join(value.root, 'Cairn-0.1.1.exe')
      writeFileSync(file, 'package')
      value.updater.check.mockResolvedValue(available())
      value.updater.download.mockResolvedValue([file])
      await value.service.check({})
      await value.service.download()
      return value
    })()
    await expect(harness.service.install()).resolves.toMatchObject({ phase: 'installing' })
  })

  it('reports updater construction failures and retries on the next check', async () => {
    const harness = setup()
    const failing = createUpdateService({
      currentVersion: '0.1.0',
      buildChannel: 'beta',
      packaged: true,
      env: {},
      sourceUrl: 'https://updates.example/cairn/',
      settings: harness.settings,
      backup: {
        root: join(harness.root, 'backups'),
        databaseFile: harness.databaseFile,
        settingsFile: harness.settingsFile,
        credentialsFile: harness.credentialsFile,
        backupDatabase: () => {},
      },
      dataDir: harness.root,
      createUpdater: async () => {
        throw new Error('cannot load updater')
      },
      onError: harness.onError,
    })
    await expect(failing.check({})).resolves.toMatchObject({
      phase: 'error',
      error: { code: 'update.check_failed' },
    })
    expect(harness.onError).toHaveBeenCalled()
    await expect(failing.check({})).resolves.toMatchObject({ phase: 'error' })
    expect(harness.onError).toHaveBeenCalledTimes(2)
  })

  it('notifies subscribers and isolates listener errors', async () => {
    const { service, updater, onError } = setup()
    updater.check.mockResolvedValue({ isUpdateAvailable: false, info: { version: '0.1.0' } })
    const seen: string[] = []
    const off = service.subscribe((status) => {
      seen.push(status.phase)
      throw new Error('listener failed')
    })
    const offSecond = service.subscribe((status) => seen.push(status.phase))
    await service.check({})
    off()
    offSecond()
    expect(seen).toContain('up_to_date')
    expect(onError).toHaveBeenCalled()
  })

  it('lists backups in diagnostics', async () => {
    const harness = setup()
    const file = join(harness.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    harness.updater.check.mockResolvedValue(available())
    harness.updater.download.mockResolvedValue([file])
    await harness.service.check({})
    await harness.service.download()
    await harness.service.install()
    const diagnostics = harness.service.diagnostics()
    expect(diagnostics.status.phase).toBe('installing')
    expect(diagnostics.backups).toHaveLength(1)
  })

  it('handles settings persistence failures without breaking the check', async () => {
    const harness = setup()
    harness.settings.update.mockImplementation(() => {
      throw new Error('disk full')
    })
    harness.updater.check.mockResolvedValue({
      isUpdateAvailable: false,
      info: { version: '0.1.0' },
    })
    await expect(harness.service.check({})).resolves.toMatchObject({ phase: 'up_to_date' })
    expect(harness.onError).toHaveBeenCalled()
  })
})

describe('createUpdateService: electron-updater adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electronUpdater.handlers.clear()
    electronUpdater.autoUpdater.verifyUpdateCodeSignature = undefined
    electronUpdater.autoUpdater.forceDevUpdateConfig = false
    electronUpdater.autoUpdater.checkForUpdates.mockReset()
    electronUpdater.autoUpdater.downloadUpdate.mockReset()
    electronUpdater.autoUpdater.quitAndInstall.mockReset()
    electronUpdater.autoUpdater.setFeedURL.mockReset()
  })

  it('disables automatic behavior, configures the stable feed and maps check results', async () => {
    const harness = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn, O=Cairn',
      defaultUpdater: true,
    })
    electronUpdater.autoUpdater.checkForUpdates.mockResolvedValue(null)
    await expect(harness.service.check({})).resolves.toMatchObject({ phase: 'up_to_date' })
    expect(electronUpdater.autoUpdater.autoDownload).toBe(false)
    expect(electronUpdater.autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(electronUpdater.autoUpdater.allowDowngrade).toBe(false)
    expect(electronUpdater.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example/cairn/',
      channel: 'latest',
    })

    electronUpdater.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.1.1' },
    })
    await expect(harness.service.check({})).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '0.1.1',
    })
  })

  it('downloads with a cancellation token, forwards progress and installs', async () => {
    const harness = setup({ defaultUpdater: true })
    const file = join(harness.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    electronUpdater.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.1.1', files: [{ size: 10 }] },
    })
    await harness.service.check({})
    let resolveDownload: ((files: string[]) => void) | undefined
    electronUpdater.autoUpdater.downloadUpdate.mockImplementation(
      () => new Promise<string[]>((resolve) => (resolveDownload = resolve)),
    )
    const pending = harness.service.download()
    await vi.waitFor(() => expect(electronUpdater.autoUpdater.downloadUpdate).toHaveBeenCalled())
    const token = electronUpdater.autoUpdater.downloadUpdate.mock.calls[0]![0] as InstanceType<
      typeof electronUpdater.CancellationToken
    >
    expect(token).toBeInstanceOf(electronUpdater.CancellationToken)
    for (const handler of electronUpdater.handlers.get('download-progress') ?? []) {
      handler({ percent: 50, transferred: 5, total: 10 })
    }
    expect(harness.service.status().progress).toMatchObject({ percent: 50 })
    await expect(harness.service.cancel()).resolves.toMatchObject({ phase: 'available' })
    expect(token.cancel).toHaveBeenCalled()
    resolveDownload?.([file])
    await expect(pending).resolves.toMatchObject({ phase: 'available' })

    electronUpdater.autoUpdater.downloadUpdate.mockResolvedValue([file])
    await expect(harness.service.download()).resolves.toMatchObject({ phase: 'downloaded' })
    await expect(harness.service.install()).resolves.toMatchObject({ phase: 'installing' })
    expect(electronUpdater.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('installs the Authenticode verifier and deletes packages that fail it', async () => {
    const verifier = vi.fn(async () => 'certificate mismatch')
    const harness = setup({
      settings: { updateChannel: 'stable' },
      publisherName: 'CN=Cairn, O=Cairn',
      verifier,
      defaultUpdater: true,
    })
    electronUpdater.autoUpdater.checkForUpdates.mockResolvedValue(null)
    await harness.service.check({})
    const verify = electronUpdater.autoUpdater.verifyUpdateCodeSignature
    expect(verify).toBeDefined()
    const file = join(harness.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    await expect(verify!(['CN=Cairn'], file)).resolves.toBe('certificate mismatch')
    expect(existsSync(file)).toBe(false)

    const directory = join(harness.root, 'Cairn-directory.exe')
    mkdirSync(directory)
    await expect(verify!(['CN=Cairn'], directory)).resolves.toBe('certificate mismatch')
    expect(existsSync(directory)).toBe(true)
    expect(verifier).toHaveBeenCalledTimes(2)
  })

  it('enables the development feed only when explicitly allowed', async () => {
    const harness = setup({ packaged: false, allowDevelopment: true, defaultUpdater: true })
    const file = join(harness.root, 'Cairn-0.1.1.exe')
    writeFileSync(file, 'package')
    electronUpdater.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.1.1' },
    })
    electronUpdater.autoUpdater.downloadUpdate.mockResolvedValue([file])
    await harness.service.check({})
    await harness.service.download()
    expect(electronUpdater.autoUpdater.forceDevUpdateConfig).toBe(true)
    expect(electronUpdater.autoUpdater.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'beta' }),
    )
  })
})
