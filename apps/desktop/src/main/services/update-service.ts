/**
 * 自动更新服务（M5-06，ADR-0036）。
 *
 * 设计要点：
 * - **失败关闭**：更新源必须是公开只读 HTTPS；开发模式、`CAIRN_UPDATE_DISABLE=1`、
 *   未配置源或 stable 通道缺少发布者 DN 时直接禁用。
 * - **不静默重启**：`autoDownload=false`、`autoInstallOnAppQuit=false`；安装前必须确认没有运行中会话、
 *   待审批或检查点恢复。安装前备份数据库、设置与凭据元数据。
 * - **完整校验**：SHA512/大小由 electron-updater 校验；配置发布者 DN 后再做严格的 Authenticode 验证
 *   （签名、时间戳、信任链与 DN），失败删除临时包。
 * - **可测试**：更新器、签名验证、磁盘空间、时钟与活动状态都可注入；单元测试不依赖 Electron。
 * - **不降级**：`allowDowngrade=false`，并在状态机里再比较一次版本，旧版本不会被当作可用更新。
 */
import { rmSync, statfsSync } from 'node:fs'
import type {
  UpdateBackupInfo,
  UpdateChannel,
  UpdateDiagnostics,
  UpdateDisabledReason,
  UpdateError,
  UpdateProgress,
  UpdateStatus,
  SettingsPatch,
} from '@cairn/protocol'
import { createAuthenticodeVerifier, type SignatureVerifier } from './update-signature.js'
import {
  backupBeforeUpdate,
  listUpdateBackups,
  type UpdateBackupOptions,
  type UpdateBackupResult,
} from './update-backup.js'

/** 首次自动检查延迟（ADR-0036）。 */
export const AUTO_CHECK_INITIAL_MS = 30_000
/** 自动检查间隔：6 小时。 */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 下载前的磁盘余量。 */
export const DEFAULT_DISK_MARGIN_BYTES = 64 * 1024 * 1024

export interface UpdateInfoLike {
  readonly version: string
  readonly releaseDate?: string | undefined
  readonly stagingPercentage?: number | undefined
  readonly files?: readonly { readonly size?: number | undefined }[] | undefined
}

export interface UpdateCheckOutcome {
  readonly isUpdateAvailable: boolean
  readonly info: UpdateInfoLike
}

export interface UpdateProgressInfo {
  readonly percent?: number
  readonly transferred?: number
  readonly total?: number
  readonly bytesPerSecond?: number
}

/** 对 electron-updater 的最小适配层；测试注入假实现。 */
export interface UpdaterAdapter {
  configure(input: {
    readonly url: string
    readonly channel: UpdateChannel
    readonly allowDevelopment: boolean
  }): void | Promise<void>
  check(): Promise<UpdateCheckOutcome | null>
  download(): Promise<readonly string[]>
  cancel(): void
  quitAndInstall(): void
  onProgress(listener: (progress: UpdateProgressInfo) => void): void
}

export interface UpdateBusyState {
  /** 已启动宿主或正在运行的会话。 */
  readonly runningSessions: number
  readonly pendingApprovals: number
  readonly restoringCheckpoints: number
}

export interface UpdateSettings {
  get(): {
    readonly updateAutoCheck?: boolean | undefined
    readonly updateChannel?: UpdateChannel | undefined
    readonly updateLastCheckedAt?: number | undefined
    readonly updateSkippedVersion?: string | undefined
  }
  update(patch: SettingsPatch): unknown
}

export interface UpdateServiceOptions {
  readonly currentVersion: string
  /** 构建通道；设置中没有选择通道时使用。 */
  readonly buildChannel: UpdateChannel
  readonly packaged: boolean
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly settings: UpdateSettings
  /** 公开只读更新源；来自 `CAIRN_UPDATE_URL`。 */
  readonly sourceUrl?: string | undefined
  /** 发布者完整 DN；来自 `CAIRN_UPDATE_PUBLISHER`。 */
  readonly publisherName?: string | undefined
  /** 测试或本地打包验证用；正式构建不允许在开发模式启用。 */
  readonly allowDevelopment?: boolean
  readonly backup: Omit<UpdateBackupOptions, 'now'>
  /** 下载目录所在卷；用于安装前磁盘检查。 */
  readonly dataDir: string
  readonly freeBytes?: (directory: string) => number | undefined
  readonly diskMarginBytes?: number
  readonly isBusy?: () => UpdateBusyState
  readonly verifier?: SignatureVerifier
  readonly createUpdater?: (input: {
    readonly verifier: SignatureVerifier
  }) => Promise<UpdaterAdapter>
  readonly now?: () => number
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancelSchedule?: (handle: unknown) => void
  readonly onStatus?: (status: UpdateStatus) => void
  readonly onError?: (error: unknown) => void
  readonly logger?: (message: string) => void
}

export interface UpdateService {
  status(): UpdateStatus
  check(params?: { readonly force?: boolean | undefined }): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  install(): Promise<UpdateStatus>
  cancel(): Promise<UpdateStatus>
  /** 设置变化后重新读取通道与自动检查开关。 */
  applySettings(patch?: SettingsPatch): UpdateStatus
  subscribe(listener: (status: UpdateStatus) => void): () => void
  start(): void
  stop(): void
  diagnostics(): UpdateDiagnostics
}

interface Configuration {
  readonly enabled: boolean
  readonly disabledReason?: UpdateDisabledReason
  readonly source?: string
  readonly channel: UpdateChannel
  readonly publisherName?: string
  readonly autoCheck: boolean
}

interface InternalState {
  phase: UpdateStatus['phase']
  availableVersion?: string | undefined
  releaseDate?: number | undefined
  progress?: UpdateProgress | undefined
  error?: UpdateError | undefined
  backupPath?: string | undefined
  signatureVerified: boolean
  stagingPercentage?: number | undefined
  lastCheckedAt?: number | undefined
}

const SUPPORTED_CHANNELS: readonly UpdateChannel[] = ['stable', 'beta']

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本；只接受 `x.y.z[-prerelease][+build]`。 */
export function parseVersion(
  version: string,
): readonly [number, number, number, readonly string[]] | undefined {
  const match = VERSION_PATTERN.exec(version.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? match[4].split('.') : []]
}

function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) {
    const value = Number(a) - Number(b)
    return value === 0 ? 0 : value < 0 ? -1 : 1
  }
  if (numericA) return -1
  if (numericB) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** 语义化版本比较；无法解析时返回 undefined。 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
  }
  const leftPre = left[3]
  const rightPre = right[3]
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const length = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index]
    const rightPart = rightPre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const compared = compareIdentifier(leftPart, rightPart)
    if (compared !== 0) return compared
  }
  return 0
}

function normalizeSource(
  value: string | undefined,
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: UpdateDisabledReason } {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return { ok: false, reason: 'update.source_missing' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'update.source_insecure' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'update.source_insecure' }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'update.source_insecure' }
  }
  // 公开静态源不需要查询串或片段；带这些内容通常意味着令牌，不允许进入客户端。
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: 'update.source_insecure' }
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`
  return { ok: true, url: parsed.toString() }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4000)
  return String(error).slice(0, 4000)
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

function isNetworkError(code: string, message: string): boolean {
  const markers = [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPROTO',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_CONNECTION_',
    'ERR_CERT_',
  ]
  return (
    markers.some((item) => code.startsWith(item) || message.includes(item)) ||
    /proxy|offline|network|timed out/i.test(message)
  )
}

/** 把 electron-updater 的错误映射成稳定错误码；界面不解析英文错误文本。 */
export function classifyUpdateError(error: unknown, fallback: string): UpdateError {
  const code = errorCode(error)
  const message = errorMessage(error)
  const statusCode =
    typeof error === 'object' && error !== null
      ? (error as { statusCode?: unknown }).statusCode
      : undefined
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') {
    return { code: 'update.signature_invalid', message, retryable: true }
  }
  if (/sha512|checksum|size mismatch|invalid checksum/i.test(`${code} ${message}`)) {
    return { code: 'update.verification_failed', message, retryable: true }
  }
  if (code === 'ENOSPC' || /no space left|insufficient disk/i.test(message)) {
    return { code: 'update.insufficient_space', message, retryable: true }
  }
  if (
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    statusCode === 404 ||
    /\b404\b/.test(message)
  ) {
    return { code: 'update.not_found', message, retryable: true }
  }
  if (code === 'ERR_UPDATER_INVALID_VERSION') {
    return { code: 'update.version_invalid', message, retryable: false }
  }
  if (/cancel/i.test(`${code} ${message}`)) {
    return { code: 'update.cancelled', message, retryable: true }
  }
  if (isNetworkError(code, message)) {
    return { code: 'update.network', message, retryable: true }
  }
  return { code: fallback, message, retryable: true }
}

function defaultFreeBytes(directory: string): number | undefined {
  try {
    const stats = statfsSync(directory)
    return stats.bavail * stats.bsize
  } catch {
    return undefined
  }
}

function defaultSchedule(fn: () => void, ms: number): unknown {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

function defaultCancelSchedule(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** `electron-updater` 的 CJS 导出形状；ESM 与默认导出两种加载方式都要兼容。 */
interface ElectronUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  forceDevUpdateConfig?: boolean
  verifyUpdateCodeSignature?: (publisherNames: string[], path: string) => Promise<string | null>
  setFeedURL(options: {
    readonly provider: 'generic'
    readonly url: string
    readonly channel: string
  }): void
  checkForUpdates(): Promise<{
    readonly isUpdateAvailable: boolean
    readonly updateInfo: UpdateInfoLike
  } | null>
  downloadUpdate(token: { cancel(): void }): Promise<readonly string[]>
  quitAndInstall(silent: boolean, forceRunAfter: boolean): void
  on(event: 'download-progress', handler: (info: UpdateProgressInfo) => void): unknown
}

interface ElectronUpdaterModule {
  readonly autoUpdater?: ElectronUpdaterLike
  readonly CancellationToken?: new () => { cancel(): void }
  readonly default?: {
    readonly autoUpdater?: ElectronUpdaterLike
    readonly CancellationToken?: new () => { cancel(): void }
  }
}

/** 兼容具名导出与默认导出；缺少任一必需成员时返回 undefined（调用方失败关闭）。 */
export function resolveElectronUpdater(module: ElectronUpdaterModule):
  | {
      readonly updater: ElectronUpdaterLike
      readonly CancellationToken: new () => { cancel(): void }
    }
  | undefined {
  const updater = module.autoUpdater ?? module.default?.autoUpdater
  const CancellationToken = module.CancellationToken ?? module.default?.CancellationToken
  return updater && CancellationToken ? { updater, CancellationToken } : undefined
}

/** 生产环境的 electron-updater 适配器。只在第一次检查时加载。 */
async function createElectronUpdater(input: {
  readonly verifier: SignatureVerifier
}): Promise<UpdaterAdapter> {
  const module = (await import('electron-updater')) as unknown as ElectronUpdaterModule
  // `autoUpdater` 在 CJS 里是延迟 getter，Node 的具名导出检测可能只暴露默认导出。
  const resolved = resolveElectronUpdater(module)
  if (!resolved) {
    throw new Error('electron-updater did not expose autoUpdater or CancellationToken')
  }
  const { updater, CancellationToken } = resolved
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false

  const native = updater
  if ('verifyUpdateCodeSignature' in native) {
    native.verifyUpdateCodeSignature = async (publisherNames, path) => {
      const result = await input.verifier(publisherNames, path)
      if (result !== null) {
        try {
          rmSync(path, { force: true })
        } catch {
          // 删除失败不改变“校验失败”的结论。
        }
      }
      return result
    }
  }

  let token: { cancel(): void } | undefined
  return {
    configure({ url, channel, allowDevelopment }) {
      if (allowDevelopment) native.forceDevUpdateConfig = true
      updater.setFeedURL({
        provider: 'generic',
        url,
        // stable 使用 latest.yml，beta 使用 beta.yml（electron-updater 的通道名）。
        channel: channel === 'stable' ? 'latest' : 'beta',
      })
    },
    async check() {
      const result = await updater.checkForUpdates()
      if (!result) return null
      return { isUpdateAvailable: result.isUpdateAvailable, info: result.updateInfo }
    },
    async download() {
      token = new CancellationToken()
      return updater.downloadUpdate(token)
    },
    cancel() {
      token?.cancel()
    },
    quitAndInstall() {
      updater.quitAndInstall(false, true)
    },
    onProgress(listener) {
      const handler = (info: UpdateProgressInfo) => listener(info)
      updater.on('download-progress', handler)
    },
  }
}

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const schedule = options.schedule ?? defaultSchedule
  const cancelSchedule = options.cancelSchedule ?? defaultCancelSchedule
  const freeBytes = options.freeBytes ?? defaultFreeBytes
  const diskMargin = options.diskMarginBytes ?? DEFAULT_DISK_MARGIN_BYTES
  const listeners = new Set<(status: UpdateStatus) => void>()
  const verifier = options.verifier ?? createAuthenticodeVerifier()

  let started = false
  let timer: unknown
  let updaterPromise: Promise<UpdaterAdapter> | undefined
  let checkPromise: Promise<UpdateStatus> | undefined
  let downloadPromise: Promise<UpdateStatus> | undefined
  let downloadGeneration = 0
  let activeChannel: UpdateChannel | undefined
  let downloadedFiles: string[] = []
  let checkInfo: UpdateInfoLike | undefined
  let cancelToken: (() => void) | undefined
  let state: InternalState = {
    phase: 'idle',
    signatureVerified: false,
    ...(options.settings.get().updateLastCheckedAt !== undefined
      ? { lastCheckedAt: options.settings.get().updateLastCheckedAt }
      : {}),
  }

  const envDisabled = env['CAIRN_UPDATE_DISABLE'] === '1'
  const allowDevelopment = options.allowDevelopment === true
  const pinnedChannel = env['CAIRN_UPDATE_CHANNEL']

  const configuration = (): Configuration => {
    const settings = options.settings.get()
    const autoCheck = settings.updateAutoCheck !== false
    if (envDisabled)
      return {
        enabled: false,
        disabledReason: 'update.disabled_by_env',
        channel: 'stable',
        autoCheck,
      }
    if (platform !== 'win32') {
      return {
        enabled: false,
        disabledReason: 'update.platform_unsupported',
        channel: 'stable',
        autoCheck,
      }
    }
    if (!options.packaged && !allowDevelopment) {
      return {
        enabled: false,
        disabledReason: 'update.not_packaged',
        channel: 'stable',
        autoCheck,
      }
    }
    let channel: UpdateChannel
    if (pinnedChannel !== undefined) {
      if (!SUPPORTED_CHANNELS.includes(pinnedChannel as UpdateChannel)) {
        return {
          enabled: false,
          disabledReason: 'update.channel_invalid',
          channel: 'stable',
          autoCheck,
        }
      }
      channel = pinnedChannel as UpdateChannel
    } else {
      channel = settings.updateChannel ?? options.buildChannel
    }
    const source = normalizeSource(options.sourceUrl ?? env['CAIRN_UPDATE_URL'])
    if (!source.ok) {
      return { enabled: false, disabledReason: source.reason, channel, autoCheck }
    }
    const publisherName = (options.publisherName ?? env['CAIRN_UPDATE_PUBLISHER'] ?? '').trim()
    if (channel === 'stable' && publisherName === '') {
      return {
        enabled: false,
        disabledReason: 'update.publisher_missing',
        source: source.url,
        channel,
        autoCheck,
      }
    }
    return {
      enabled: true,
      source: source.url,
      channel,
      autoCheck,
      ...(publisherName !== '' ? { publisherName } : {}),
    }
  }

  const busy = (): UpdateBusyState =>
    options.isBusy?.() ?? { runningSessions: 0, pendingApprovals: 0, restoringCheckpoints: 0 }

  const blocked = (): 'update.busy' | undefined => {
    const active = busy()
    return active.runningSessions + active.pendingApprovals + active.restoringCheckpoints > 0
      ? 'update.busy'
      : undefined
  }

  const snapshot = (): UpdateStatus => {
    const config = configuration()
    const skippedVersion = options.settings.get().updateSkippedVersion
    const phase =
      !config.enabled &&
      !['downloading', 'verifying', 'downloaded', 'installing'].includes(state.phase)
        ? 'disabled'
        : state.phase
    return {
      phase,
      currentVersion: options.currentVersion,
      channel: config.channel,
      channelPinned: pinnedChannel !== undefined,
      enabled: config.enabled,
      autoCheck: config.autoCheck,
      ...(config.source ? { source: config.source } : {}),
      ...(state.lastCheckedAt !== undefined ? { lastCheckedAt: state.lastCheckedAt } : {}),
      ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
      ...(state.releaseDate !== undefined ? { releaseDate: state.releaseDate } : {}),
      ...(skippedVersion ? { skippedVersion } : {}),
      ...(state.progress ? { progress: state.progress } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(config.disabledReason ? { disabledReason: config.disabledReason } : {}),
      ...(state.backupPath ? { backupPath: state.backupPath } : {}),
      signatureVerified: state.signatureVerified,
      requiresRestart: state.phase === 'downloaded',
      ...(state.phase === 'downloaded' && blocked()
        ? { blockedReason: 'update.busy' as const }
        : {}),
      ...(state.stagingPercentage !== undefined
        ? { stagingPercentage: state.stagingPercentage }
        : {}),
    }
  }

  const emit = (): void => {
    const status = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(status)
      } catch (error) {
        options.onError?.(error)
      }
    }
    options.onStatus?.(status)
  }

  const fail = (
    code: string,
    message: string,
    retryable: boolean,
    phase: UpdateStatus['phase'] = 'error',
  ): UpdateStatus => {
    state.phase = phase
    state.error = { code, message: message.slice(0, 4000), retryable }
    emit()
    return snapshot()
  }

  const clearTimer = (): void => {
    if (timer === undefined) return
    cancelSchedule(timer)
    timer = undefined
  }

  const scheduleNext = (delay: number): void => {
    clearTimer()
    if (!started) return
    const config = configuration()
    if (!config.enabled || !config.autoCheck) return
    timer = schedule(() => {
      timer = undefined
      void check({})
    }, delay)
  }

  const persistLastChecked = (): void => {
    try {
      options.settings.update({ updateLastCheckedAt: state.lastCheckedAt })
    } catch (error) {
      options.onError?.(error)
    }
  }

  const updater = (): Promise<UpdaterAdapter> => {
    updaterPromise ??= (async () => {
      const adapter = await (options.createUpdater ?? createElectronUpdater)({ verifier })
      adapter.onProgress((progress) => {
        if (state.phase !== 'downloading') return
        const total = Math.max(0, progress.total ?? 0)
        const transferred = Math.max(0, progress.transferred ?? 0)
        state.progress = {
          percent:
            total > 0
              ? Math.min(100, Math.max(0, progress.percent ?? (transferred / total) * 100))
              : 0,
          transferred,
          total,
          ...(progress.bytesPerSecond !== undefined
            ? { bytesPerSecond: Math.max(0, progress.bytesPerSecond) }
            : {}),
        }
        emit()
      })
      return adapter
    })().catch((error: unknown) => {
      updaterPromise = undefined
      options.onError?.(error)
      throw error
    })
    return updaterPromise
  }

  /** 删除下载产物；即使失败也不把未校验的包标记为可安装。 */
  const removeFiles = (files: readonly string[]): void => {
    for (const file of files) {
      try {
        rmSync(file, { force: true })
      } catch {
        // 失败关闭：清理失败不改变“不可安装”的结论。
      }
    }
  }

  const resetAvailable = (remove: boolean): void => {
    if (remove) removeFiles(downloadedFiles)
    downloadedFiles = []
    checkInfo = undefined
    state = {
      phase: 'idle',
      signatureVerified: false,
      ...(state.lastCheckedAt !== undefined ? { lastCheckedAt: state.lastCheckedAt } : {}),
    }
  }

  const runCheck = async (force: boolean): Promise<UpdateStatus> => {
    try {
      state.phase = 'checking'
      state.error = undefined
      state.progress = undefined
      emit()
      const config = configuration()
      if (!config.enabled) {
        state.phase = 'disabled'
        state.lastCheckedAt = now()
        persistLastChecked()
        emit()
        return snapshot()
      }
      const adapter = await updater()
      activeChannel = config.channel
      await adapter.configure({
        url: config.source!,
        channel: config.channel,
        allowDevelopment: !options.packaged && allowDevelopment,
      })
      const result = await adapter.check()
      state.lastCheckedAt = now()
      persistLastChecked()

      if (!result || !result.isUpdateAvailable) {
        resetAvailable(true)
        state.phase = 'up_to_date'
        emit()
        return snapshot()
      }

      const comparison = compareVersions(result.info.version, options.currentVersion)
      if (comparison === undefined) {
        return fail('update.version_invalid', `invalid version: ${result.info.version}`, false)
      }
      if (comparison <= 0) {
        // 禁止降级：旧版本或同版本不当作更新。
        resetAvailable(true)
        state.phase = 'up_to_date'
        emit()
        return snapshot()
      }

      const staging = result.info.stagingPercentage
      if (staging !== undefined && (!Number.isFinite(staging) || staging < 0 || staging > 100)) {
        return fail('update.invalid_manifest', 'invalid staging percentage', false)
      }
      state.stagingPercentage = staging
      if (staging !== undefined && staging < 100) {
        // M5 只发布 0 或 100；1–99 视为未对本机开放，不做随机抽样。
        resetAvailable(true)
        state.stagingPercentage = staging
        state.phase = 'up_to_date'
        emit()
        return snapshot()
      }

      checkInfo = result.info
      state.availableVersion = result.info.version
      const release = result.info.releaseDate ? Date.parse(result.info.releaseDate) : Number.NaN
      state.releaseDate = Number.isFinite(release) ? release : undefined
      const skipped = options.settings.get().updateSkippedVersion
      state.phase = !force && skipped === result.info.version ? 'skipped' : 'available'
      emit()
      return snapshot()
    } catch (error) {
      state.lastCheckedAt = now()
      persistLastChecked()
      const mapped = classifyUpdateError(error, 'update.check_failed')
      return fail(mapped.code, mapped.message, mapped.retryable)
    } finally {
      scheduleNext(AUTO_CHECK_INTERVAL_MS)
    }
  }

  const check = (params?: { readonly force?: boolean | undefined }): Promise<UpdateStatus> => {
    if (checkPromise) return checkPromise
    const config = configuration()
    if (!config.enabled) {
      state.phase = 'disabled'
      emit()
      return Promise.resolve(snapshot())
    }
    if (
      state.phase === 'downloading' ||
      state.phase === 'installing' ||
      state.phase === 'verifying'
    ) {
      return Promise.resolve(snapshot())
    }
    checkPromise = runCheck(params?.force === true).finally(() => {
      checkPromise = undefined
    })
    return checkPromise
  }

  const runDownload = async (generation: number, info: UpdateInfoLike): Promise<UpdateStatus> => {
    const total = (info.files ?? []).reduce((sum, file) => sum + (file.size ?? 0), 0)
    if (total > 0) {
      const available = freeBytes(options.dataDir)
      if (available !== undefined && available < total + diskMargin) {
        return fail(
          'update.insufficient_space',
          `need ${total + diskMargin} bytes, ${available} available`,
          true,
          'available',
        )
      }
    }

    const config = configuration()
    state.phase = 'downloading'
    state.progress = { percent: 0, transferred: 0, total }
    state.error = undefined
    state.backupPath = undefined
    state.signatureVerified = false
    emit()

    try {
      const adapter = await updater()
      await adapter.configure({
        url: config.source!,
        channel: config.channel,
        allowDevelopment: !options.packaged && allowDevelopment,
      })
      cancelToken = () => adapter.cancel()
      const files = [...(await adapter.download())]
      if (generation !== downloadGeneration) {
        removeFiles(files)
        return snapshot()
      }
      if (files.length === 0) {
        return fail('update.download_failed', 'updater returned no files', true, 'available')
      }

      state.phase = 'verifying'
      emit()
      if (config.publisherName) {
        const executable = files.find((file) => file.toLowerCase().endsWith('.exe'))
        if (!executable) {
          removeFiles(files)
          return fail(
            'update.verification_failed',
            'downloaded package has no executable',
            true,
            'available',
          )
        }
        const signatureError = await verifier([config.publisherName], executable)
        if (signatureError !== null) {
          removeFiles(files)
          return fail('update.signature_invalid', signatureError, true, 'available')
        }
        state.signatureVerified = true
      }
      downloadedFiles = files
      state.phase = 'downloaded'
      state.progress = { percent: 100, transferred: total, total }
      state.error = undefined
      emit()
      return snapshot()
    } catch (error) {
      if (generation !== downloadGeneration) return snapshot()
      const mapped = classifyUpdateError(error, 'update.download_failed')
      return fail(
        mapped.code,
        mapped.message,
        mapped.retryable,
        mapped.code === 'update.cancelled' ? 'available' : 'error',
      )
    } finally {
      cancelToken = undefined
    }
  }

  const download = (): Promise<UpdateStatus> => {
    if (downloadPromise) return downloadPromise
    const config = configuration()
    if (!config.enabled) {
      state.phase = 'disabled'
      emit()
      return Promise.resolve(snapshot())
    }
    if (state.phase === 'downloaded') return Promise.resolve(snapshot())
    if (!checkInfo || !state.availableVersion) {
      return Promise.resolve(
        fail('update.not_downloaded', 'check for an update before downloading', true, 'idle'),
      )
    }
    const generation = ++downloadGeneration
    downloadPromise = runDownload(generation, checkInfo).finally(() => {
      downloadPromise = undefined
    })
    return downloadPromise
  }

  const cancel = (): Promise<UpdateStatus> => {
    if (state.phase !== 'downloading') return Promise.resolve(snapshot())
    downloadGeneration += 1
    cancelToken?.()
    cancelToken = undefined
    state.phase = 'available'
    state.progress = undefined
    state.error = { code: 'update.cancelled', message: 'download cancelled', retryable: true }
    emit()
    return Promise.resolve(snapshot())
  }

  const install = async (): Promise<UpdateStatus> => {
    const config = configuration()
    if (!config.enabled) {
      state.phase = 'disabled'
      emit()
      return snapshot()
    }
    if (state.phase !== 'downloaded' || downloadedFiles.length === 0) {
      return fail('update.not_downloaded', 'no downloaded update', true, state.phase)
    }
    if (blocked()) {
      return fail('update.busy', 'tasks are still running', true, 'downloaded')
    }
    state.phase = 'installing'
    state.error = undefined
    emit()
    let backup: UpdateBackupResult
    try {
      backup = backupBeforeUpdate(options.backup, {
        from: options.currentVersion,
        to: state.availableVersion!,
      })
    } catch (error) {
      return fail('update.backup_failed', errorMessage(error), true, 'downloaded')
    }
    state.backupPath = backup.path
    emit()
    try {
      const adapter = await updater()
      adapter.quitAndInstall()
      return snapshot()
    } catch (error) {
      return fail('update.install_failed', errorMessage(error), true, 'downloaded')
    }
  }

  const applySettings = (patch?: SettingsPatch): UpdateStatus => {
    const next = configuration()
    if (patch?.updateChannel !== undefined || pinnedChannel !== undefined) {
      if (activeChannel !== undefined && activeChannel !== next.channel) {
        resetAvailable(true)
        emit()
      }
    }
    activeChannel = next.channel
    if (state.availableVersion && (state.phase === 'available' || state.phase === 'skipped')) {
      const skipped = options.settings.get().updateSkippedVersion
      state.phase = skipped === state.availableVersion ? 'skipped' : 'available'
    }
    if (!next.enabled && state.phase !== 'downloaded' && state.phase !== 'installing') {
      state.phase = 'disabled'
    } else if (next.enabled && state.phase === 'disabled') {
      state.phase = 'idle'
    }
    if (started) scheduleNext(AUTO_CHECK_INITIAL_MS)
    emit()
    return snapshot()
  }

  return {
    status: snapshot,
    check,
    download,
    install,
    cancel,
    applySettings,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (started) return
      started = true
      scheduleNext(AUTO_CHECK_INITIAL_MS)
    },
    stop() {
      started = false
      clearTimer()
    },
    diagnostics() {
      const backups: UpdateBackupInfo[] = listUpdateBackups(options.backup.root)
      return { status: snapshot(), backups }
    },
  }
}
