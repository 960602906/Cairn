/**
 * 官方供应商插件目录（ADR-0049）：只读 `https://github.com/960602906/cairn-provider-plugins` 默认分支上的文件。
 *
 * - `index.json` 列出插件（见 `docs/dev/provider-plugins.md`）；无效的项跳过，不影响其余插件。
 * - 插件文件只从同一仓库读取：`path` 是仓库内的相对路径，省略时为 `plugins/<id>.json`。下载到的插件 id
 *   必须与目录中的一致。
 * - 预览返回插件文件的 `sha256`；安装时内容必须与预览时相同，保证装的就是用户看过的服务与地址。
 * - 相对路径的图标按声明它的文件的地址解析成仓库中的 https 地址，写入插件目录的就是解析后的内容。
 * - 目录不可达时报 `providers.catalog.unreachable`，不影响内置服务与本地文件安装。
 */
import { createHash } from 'node:crypto'
import { PROVIDER_PLUGIN_MAX_BYTES, resolveAssetUrl } from '@cairn/core'
import {
  ProviderCatalogIndex,
  ProviderCatalogIndexEntry,
  RpcError,
  type ProviderCatalogItem,
  type ProviderPluginInfo,
} from '@cairn/protocol'
import type { ProviderPluginService } from './provider-plugin-service.js'
import { SafeFetchError, safeFetch } from './safe-fetch.js'

/** 官方目录：仓库网页与默认分支上文件的地址。 */
export const OFFICIAL_PROVIDER_CATALOG = {
  page: 'https://github.com/960602906/cairn-provider-plugins',
  files: 'https://raw.githubusercontent.com/960602906/cairn-provider-plugins/main/',
} as const

export const ProviderCatalogErrorCode = {
  Unreachable: 'providers.catalog.unreachable',
  Invalid: 'providers.catalog.invalid',
  NotFound: 'providers.catalog.not_found',
  Changed: 'providers.catalog.changed',
} as const

const INDEX_MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 15_000
/** 目录列表的缓存时间：浏览后马上预览、安装时不重复下载。 */
const INDEX_TTL_MS = 60_000

export interface ProviderCatalogServiceOptions {
  readonly plugins: Pick<ProviderPluginService, 'previewText' | 'installText'>
  /** 目录文件的根地址（以 `/` 结尾）；测试或开发时可指向本机服务。 */
  readonly files?: string
  readonly page?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

export interface ProviderCatalogService {
  list(): Promise<{ source: string; plugins: ProviderCatalogItem[] }>
  preview(input: { id: string }): Promise<{
    replaces: boolean
    sha256: string
    plugin: ProviderPluginInfo
  }>
  install(input: { id: string; sha256: string }): Promise<{
    installed: boolean
    replaces: boolean
    plugin: ProviderPluginInfo
  }>
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function createProviderCatalogService(
  options: ProviderCatalogServiceOptions,
): ProviderCatalogService {
  const files = options.files ?? OFFICIAL_PROVIDER_CATALOG.files
  const page = options.page ?? OFFICIAL_PROVIDER_CATALOG.page
  const official = files === OFFICIAL_PROVIDER_CATALOG.files
  const now = options.now ?? Date.now
  const indexUrl = `${files}index.json`
  let index: { at: number; entries: ProviderCatalogIndexEntry[] } | undefined
  const downloads = new Map<string, { sha256: string; text: string; url: string }>()

  const read = async (url: string, maxBytes: number): Promise<string> => {
    try {
      const response = await safeFetch(url, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        accept: 'application/json, text/plain;q=0.5',
        maxBytes,
        timeoutMs: TIMEOUT_MS,
        ...(official ? {} : { publicOnly: false, allowHttp: true }),
      })
      return response.body.toString('utf8')
    } catch (error) {
      if (error instanceof SafeFetchError && error.reason === 'too_large') {
        throw new RpcError(ProviderCatalogErrorCode.Invalid)
      }
      const status = error instanceof SafeFetchError ? error.status : undefined
      throw new RpcError(
        ProviderCatalogErrorCode.Unreachable,
        status === undefined ? undefined : { status },
      )
    }
  }

  const entries = async (): Promise<ProviderCatalogIndexEntry[]> => {
    if (index && now() - index.at < INDEX_TTL_MS) return index.entries
    const text = await read(indexUrl, INDEX_MAX_BYTES)
    let json: unknown
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      throw new RpcError(ProviderCatalogErrorCode.Invalid)
    }
    const parsed = ProviderCatalogIndex.safeParse(json)
    if (!parsed.success) throw new RpcError(ProviderCatalogErrorCode.Invalid)
    const seen = new Set<string>()
    const list: ProviderCatalogIndexEntry[] = []
    for (const raw of parsed.data.plugins) {
      const entry = ProviderCatalogIndexEntry.safeParse(raw)
      if (!entry.success || seen.has(entry.data.id)) continue
      seen.add(entry.data.id)
      list.push(entry.data)
    }
    index = { at: now(), entries: list }
    return list
  }

  const download = async (id: string) => {
    const entry = (await entries()).find((item) => item.id === id)
    if (!entry) throw new RpcError(ProviderCatalogErrorCode.NotFound, { id })
    const url = `${files}${entry.path ?? `plugins/${id}.json`}`
    const text = await read(url, PROVIDER_PLUGIN_MAX_BYTES)
    const result = { sha256: sha256(text), text, url }
    downloads.set(id, result)
    return result
  }

  return {
    async list() {
      const plugins = (await entries()).map((entry): ProviderCatalogItem => {
        const icon = entry.icon === undefined ? undefined : resolveAssetUrl(entry.icon, indexUrl)
        return {
          id: entry.id,
          name: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.version ? { version: entry.version } : {}),
          ...(entry.homepage ? { homepage: entry.homepage } : {}),
          ...(icon ? { icon } : {}),
        }
      })
      return { source: page, plugins }
    },

    async preview({ id }) {
      const fetched = await download(id)
      const { replaces, plugin } = options.plugins.previewText(fetched.text, {
        base: fetched.url,
        expectId: id,
      })
      return { replaces, sha256: fetched.sha256, plugin }
    },

    async install({ id, sha256: expected }) {
      let fetched = downloads.get(id)
      if (fetched?.sha256 !== expected) fetched = await download(id)
      if (fetched.sha256 !== expected) throw new RpcError(ProviderCatalogErrorCode.Changed, { id })
      const result = options.plugins.installText(fetched.text, {
        base: fetched.url,
        expectId: id,
      })
      downloads.delete(id)
      return result
    },
  }
}
