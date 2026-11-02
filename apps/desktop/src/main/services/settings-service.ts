/**
 * 应用设置（M0-15d，架构 §14.1、§19）：保存在数据目录的 `settings.json`，只由主进程读写。
 *
 * - 没有保存过的项取默认值：语言按系统语言检测（首次启动跟随系统，非中文默认英文）。
 * - 文件不存在、不是 JSON 或字段无效时按默认值处理，不阻止应用启动；文件中的未知字段原样保留，
 *   旧版本应用不会丢掉新版本写入的设置。
 * - 先写临时文件再改名替换，写入中途退出不会留下半个文件。写入失败报 `settings.write_failed`，
 *   内存中的设置不变。
 *
 * 不依赖 Electron：系统语言由调用方传入。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolveLocale } from '@nexus/i18n'
import { RpcError, type Settings } from '@nexus/protocol'

export const SettingsErrorCode = {
  WriteFailed: 'settings.write_failed',
} as const

export interface SettingsServiceOptions {
  readonly file: string
  /** 系统首选语言列表；用到默认语言时才调用（Electron 的语言接口需要在 `ready` 之后使用）。 */
  readonly systemLocales: () => readonly string[]
  /** 设置文件无法读取、解析或写入时调用（文件不存在不算）。 */
  readonly onError?: (error: unknown) => void
}

/** 要更新的设置项；值为 undefined 的项不改动。 */
export type SettingsPatch = { readonly [K in keyof Settings]?: Settings[K] | undefined }

export interface SettingsService {
  get(): Settings
  update(patch: SettingsPatch): Settings
}

type Stored = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Stored =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readStored(file: string, onError: ((error: unknown) => void) | undefined): Stored {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.(error)
    return {}
  }
  try {
    const value: unknown = JSON.parse(text)
    if (isRecord(value)) return value
    onError?.(new Error('settings file is not a JSON object'))
  } catch (error) {
    onError?.(error)
  }
  return {}
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const { file, systemLocales } = options
  let stored = readStored(file, options.onError)

  const current = (): Settings => ({ locale: resolveLocale(stored['locale'], systemLocales()) })

  return {
    get: current,
    update(patch) {
      const defined = Object.entries(patch).filter(([, value]) => value !== undefined)
      const next = { ...stored, ...Object.fromEntries(defined) }
      const temp = `${file}.tmp`
      try {
        writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        renameSync(temp, file)
      } catch (error) {
        options.onError?.(error)
        throw new RpcError(SettingsErrorCode.WriteFailed)
      }
      stored = next
      return current()
    },
  }
}
