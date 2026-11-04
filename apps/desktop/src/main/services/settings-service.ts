/**
 * 应用设置（M0-15d，架构 §14.1、§16.1、§19；M1-04a 加入模型配置）。只由主进程读写。
 *
 * - 界面语言、默认模型等保存在数据目录的 `settings.json`；模型提供方配置保存在数据库的
 *   `provider_configs` 表中（`ProviderStore`），两者一起经 `settings.get` / `settings.update` 读写。
 *   配置中只有凭据引用，没有 Key。
 * - 没有保存过的项取默认值：语言按系统语言检测（首次启动跟随系统，非中文默认英文）。
 * - 文件不存在、不是 JSON 或字段无效时按默认值处理，不阻止应用启动；文件中的未知字段原样保留，
 *   旧版本应用不会丢掉新版本写入的设置。
 * - 默认模型必须是已配置的模型，否则报 `settings.invalid_default_model`；更新提供方后默认模型
 *   不再存在时一并清除。文件中的默认模型无效时视为没有设置。
 * - 先写临时文件再改名替换，写入中途退出不会留下半个文件。写入失败报 `settings.write_failed`，
 *   设置（包括提供方配置）保持更新前的状态。
 *
 * 不依赖 Electron：系统语言由调用方传入。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostModelConfig } from '@nexus/core'
import { resolveLocale } from '@nexus/i18n'
import {
  ModelRef,
  RpcError,
  type HostModelConfig,
  type ProviderConfig,
  type Settings,
  type SettingsPatch as ProtocolSettingsPatch,
} from '@nexus/protocol'
import type { ProviderStore, Storage } from '@nexus/storage'

export const SettingsErrorCode = {
  WriteFailed: 'settings.write_failed',
  /** 默认模型不在已配置的提供方与模型中。 */
  InvalidDefaultModel: 'settings.invalid_default_model',
  /** 会话的模型不在提供方配置中（提供方还在，模型被删除了）。 */
  UnknownModel: 'session.unknown_model',
} as const

export interface SettingsServiceOptions {
  readonly file: string
  /** 提供方配置的存储；更新时与设置文件一起提交。 */
  readonly storage: { readonly providers: ProviderStore } & Pick<Storage, 'transaction'>
  /** 系统首选语言列表；用到默认语言时才调用（Electron 的语言接口需要在 `ready` 之后使用）。 */
  readonly systemLocales: () => readonly string[]
  /** 设置文件无法读取、解析或写入时调用（文件不存在不算）。 */
  readonly onError?: (error: unknown) => void
}

/** 要更新的设置项；值为 undefined 的项不改动，`defaultModel` 为 null 时清除。 */
export type SettingsPatch = {
  readonly [K in keyof ProtocolSettingsPatch]?: ProtocolSettingsPatch[K]
}

export interface SettingsService {
  get(): Settings
  update(patch: SettingsPatch): Settings
  /** 按 id 查找提供方配置。 */
  provider(providerId: string): ProviderConfig | undefined
  /** 模型是否已配置。 */
  hasModel(model: ModelRef): boolean
  /**
   * 启动宿主时用的模型配置（M1-04b）。提供方没有配置时为 undefined（如 FakeRuntime 的模型）；
   * 提供方存在而模型不在其中时报 `session.unknown_model`。
   */
  hostModelConfig(model: ModelRef): HostModelConfig | undefined
  /** 模型所属提供方的凭据引用；提供方没有配置或不需要 Key 时为 undefined。 */
  credentialRef(model: ModelRef): string | undefined
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

const modelIn = (providers: readonly ProviderConfig[], model: ModelRef): boolean =>
  providers.some((p) => p.id === model.providerId && p.models.some((m) => m.id === model.modelId))

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const { file, storage, systemLocales } = options
  let stored = readStored(file, options.onError)

  /** 文件中的默认模型；格式无效或不在配置中时为 undefined。 */
  const storedDefault = (providers: readonly ProviderConfig[]): ModelRef | undefined => {
    const parsed = ModelRef.safeParse(stored['defaultModel'])
    return parsed.success && modelIn(providers, parsed.data) ? parsed.data : undefined
  }

  const current = (): Settings => {
    const providers = storage.providers.list()
    const defaultModel = storedDefault(providers)
    return {
      locale: resolveLocale(stored['locale'], systemLocales()),
      providers,
      ...(defaultModel ? { defaultModel } : {}),
    }
  }

  const writeFile = (next: Stored) => {
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  }

  return {
    get: current,

    update(patch) {
      const providers = patch.providers ?? storage.providers.list()
      if (patch.defaultModel && !modelIn(providers, patch.defaultModel)) {
        throw new RpcError(SettingsErrorCode.InvalidDefaultModel, {
          providerId: patch.defaultModel.providerId,
          modelId: patch.defaultModel.modelId,
        })
      }

      const next: Record<string, unknown> = { ...stored }
      if (patch.locale !== undefined) next['locale'] = patch.locale
      if (patch.defaultModel !== undefined) next['defaultModel'] = patch.defaultModel ?? undefined
      // 默认模型所在的提供方或模型被删除时一并清除
      const keptDefault = ModelRef.safeParse(next['defaultModel'])
      if (keptDefault.success && !modelIn(providers, keptDefault.data)) {
        next['defaultModel'] = undefined
      }
      const nextStored = JSON.parse(JSON.stringify(next)) as Stored

      try {
        storage.transaction(() => {
          if (patch.providers) storage.providers.replaceAll(patch.providers)
          // 文件写入失败时抛出，提供方配置随事务回滚
          writeFile(nextStored)
        })
      } catch (error) {
        options.onError?.(error)
        throw new RpcError(SettingsErrorCode.WriteFailed)
      }
      stored = nextStored
      return current()
    },

    provider: (providerId) => storage.providers.get(providerId),
    hasModel: (model) => {
      const provider = storage.providers.get(model.providerId)
      return provider !== undefined && provider.models.some((m) => m.id === model.modelId)
    },
    hostModelConfig(model) {
      const provider = storage.providers.get(model.providerId)
      if (!provider) return undefined
      const config = hostModelConfig(provider, model.modelId)
      if (!config) throw new RpcError(SettingsErrorCode.UnknownModel, { ...model })
      return config
    },
    credentialRef: (model) => storage.providers.get(model.providerId)?.credentialRef,
  }
}
