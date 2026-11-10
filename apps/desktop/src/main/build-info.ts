/**
 * 读取构建信息（M5-01）：`out/build-info.json` 由 `scripts/build-info.mjs` 在构建时写入。
 *
 * 读取必须失败关闭、安静降级：
 * - 文件缺失（开发模式尚未构建）或内容损坏时，使用运行时版本与安全默认值；
 * - 不把文件路径、解析错误原文或文件里的任意字段直接放到 `AppInfo`；
 * - Electron / Node / 数据库 schema 版本以运行时为准，文件中的值只作缺省。
 */
import { readFileSync } from 'node:fs'
import { BuildInfo, type AppInfo, type BuildChannel, type GitRuntimeInfo } from '@cairn/protocol'
import { APP_IDENTITY } from './app-identity.js'

export interface AppInfoRuntime {
  /** `app.getVersion()`。 */
  readonly version: string
  readonly electronVersion: string
  readonly nodeVersion: string
  readonly databaseSchemaVersion: number
  readonly packaged: boolean
  /** 检查点使用的 Git（M5-03）；探测失败时不带该字段。 */
  readonly git?: GitRuntimeInfo
}

export interface ReadAppInfoOptions {
  readonly file: string
  readonly runtime: AppInfoRuntime
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly readFile?: (file: string) => string
  /** 文件存在但无法读取/解析时报告；路径错误不会进入 `AppInfo`。 */
  readonly onError?: (error: Error) => void
}

/**
 * 解析通道：显式 `stable` / `beta` 优先，否则 0.x 视为 beta，1.0 起视为 stable。
 * 与 `scripts/build-info.mjs` 的规则保持一致。
 */
export function resolveChannel(raw: string | undefined, version: string): BuildChannel {
  if (raw === 'stable' || raw === 'beta') return raw
  return version.startsWith('0.') ? 'beta' : 'stable'
}

/** 解析构建信息文本；格式不合法时返回 undefined。 */
export function parseBuildInfo(text: string): BuildInfo | undefined {
  try {
    const parsed = BuildInfo.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** 读取构建信息；任何失败都降级为运行时能提供的最小信息。 */
export function readAppInfo({
  file,
  runtime,
  env = {},
  readFile = (path) => readFileSync(path, 'utf8'),
  onError,
}: ReadAppInfoOptions): AppInfo {
  let build: BuildInfo | undefined
  try {
    build = parseBuildInfo(readFile(file))
    if (!build) onError?.(new Error('build-info.json is malformed'))
  } catch (error) {
    // 开发模式下文件不存在是正常情况，不作为错误上报
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const version = runtime.version
  const update = build?.update
  return {
    schemaVersion: 1,
    version,
    channel: resolveChannel(env['CAIRN_CHANNEL'] ?? build?.channel, version),
    commit: build?.commit ?? 'unknown',
    buildTime: build?.buildTime ?? '',
    electronVersion: runtime.electronVersion || build?.electronVersion || '',
    nodeVersion: runtime.nodeVersion || build?.nodeVersion || '',
    name: APP_IDENTITY.productName,
    appId: APP_IDENTITY.appId,
    copyright: APP_IDENTITY.copyright,
    packaged: runtime.packaged,
    databaseSchemaVersion: runtime.databaseSchemaVersion,
    ...(runtime.git ? { git: runtime.git } : {}),
    ...(update ? { update } : {}),
  }
}
