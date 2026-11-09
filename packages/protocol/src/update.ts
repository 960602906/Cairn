/**
 * 自动更新（M5-06，ADR-0036）：主进程更新服务的状态与错误码。
 *
 * - 更新源是公开只读的 generic HTTPS 静态源；客户端不携带仓库令牌或签名密码。
 * - 状态只描述更新器实际知道的事实：当前版本、通道、可用版本、下载进度、错误与是否需要重启。
 * - `signatureVerified` 为 false 时只允许 unsigned beta（ADR-0036）；stable 构建必须配置发布者 DN。
 */
import { z } from 'zod'
import { Timestamp } from './common.js'

/** 更新通道（ADR-0036）。`stable` 读取 `latest.yml`，`beta` 读取 `beta.yml`。 */
export const UpdateChannel = z.enum(['stable', 'beta'])
export type UpdateChannel = z.infer<typeof UpdateChannel>

/** 更新器状态。`disabled` 是构建配置结论，不是运行失败。 */
export const UpdatePhase = z.enum([
  'disabled',
  'idle',
  'checking',
  'up_to_date',
  'available',
  'downloading',
  'verifying',
  'downloaded',
  'installing',
  'skipped',
  'error',
])
export type UpdatePhase = z.infer<typeof UpdatePhase>

/** 更新被禁用的原因（用于界面与诊断；不含路径或凭据）。 */
export const UpdateDisabledReason = z.enum([
  'update.not_packaged',
  'update.disabled_by_env',
  'update.platform_unsupported',
  'update.source_missing',
  'update.source_insecure',
  'update.channel_invalid',
  'update.publisher_missing',
])
export type UpdateDisabledReason = z.infer<typeof UpdateDisabledReason>

/** 更新失败的错误码；界面按当前语言翻译，`message` 只作为诊断细节。 */
export const UpdateErrorCode = {
  NotPackaged: 'update.not_packaged',
  DisabledByEnv: 'update.disabled_by_env',
  PlatformUnsupported: 'update.platform_unsupported',
  SourceMissing: 'update.source_missing',
  SourceInsecure: 'update.source_insecure',
  ChannelInvalid: 'update.channel_invalid',
  PublisherMissing: 'update.publisher_missing',
  CheckFailed: 'update.check_failed',
  NotFound: 'update.not_found',
  Network: 'update.network',
  DownloadFailed: 'update.download_failed',
  VerificationFailed: 'update.verification_failed',
  SignatureInvalid: 'update.signature_invalid',
  InsufficientSpace: 'update.insufficient_space',
  Busy: 'update.busy',
  BackupFailed: 'update.backup_failed',
  InstallFailed: 'update.install_failed',
  NotDownloaded: 'update.not_downloaded',
  Cancelled: 'update.cancelled',
  InvalidManifest: 'update.invalid_manifest',
  VersionInvalid: 'update.version_invalid',
} as const
export type UpdateErrorCode = (typeof UpdateErrorCode)[keyof typeof UpdateErrorCode]

export const UpdateError = z.object({
  code: z.string().min(1),
  /** 诊断细节；不包含更新源凭据或用户路径。 */
  message: z.string().min(1).max(4000),
  retryable: z.boolean(),
})
export type UpdateError = z.infer<typeof UpdateError>

/** 下载进度；`percent` 只在总大小已知时有意义（否则为 0）。 */
export const UpdateProgress = z.object({
  percent: z.number().min(0).max(100),
  transferred: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  bytesPerSecond: z.number().nonnegative().optional(),
})
export type UpdateProgress = z.infer<typeof UpdateProgress>

/**
 * 更新器当前状态。所有字段都只来自更新器与设置；`source` 是去掉查询串与凭据的公开地址。
 * `blockedReason` 表示“已下载但当前不能安装”，例如仍有运行中的任务。
 */
export const UpdateStatus = z.object({
  phase: UpdatePhase,
  currentVersion: z.string().min(1),
  channel: UpdateChannel,
  enabled: z.boolean(),
  autoCheck: z.boolean(),
  /** 公开只读更新源（不含查询串、用户名或密码）。 */
  source: z.string().optional(),
  lastCheckedAt: Timestamp.optional(),
  availableVersion: z.string().optional(),
  releaseDate: Timestamp.optional(),
  /** 用户选择跳过的版本；检查仍会报告它，界面据此显示“跳过此版本”。 */
  skippedVersion: z.string().optional(),
  progress: UpdateProgress.optional(),
  error: UpdateError.optional(),
  disabledReason: UpdateDisabledReason.optional(),
  /** 更新前备份目录；只在安装流程中写入。 */
  backupPath: z.string().optional(),
  /** 更新包是否通过 Authenticode 验证；未配置发布者 DN 的 unsigned beta 为 false。 */
  signatureVerified: z.boolean(),
  /** 下载完成且校验通过，等待用户确认重启。 */
  requiresRestart: z.boolean(),
  /** 已下载但当前不能安装的原因。 */
  blockedReason: z.enum(['update.busy']).optional(),
  /** 本次检查看到的灰度比例（M5 只使用 0 或 100）。 */
  stagingPercentage: z.number().min(0).max(100).optional(),
})
export type UpdateStatus = z.infer<typeof UpdateStatus>

/** 一次备份的描述（诊断包用，不包含项目内容或凭据）。 */
export const UpdateBackupInfo = z.object({
  path: z.string().min(1),
  createdAt: Timestamp,
  files: z.array(z.string()),
})
export type UpdateBackupInfo = z.infer<typeof UpdateBackupInfo>

/** 诊断包中的更新摘要。 */
export const UpdateDiagnostics = z.object({
  status: UpdateStatus,
  backups: z.array(UpdateBackupInfo),
})
export type UpdateDiagnostics = z.infer<typeof UpdateDiagnostics>
