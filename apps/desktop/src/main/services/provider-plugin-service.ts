/**
 * 供应商插件（ADR-0050）：应用数据目录 `provider-plugins/` 下的 JSON 文件，每个文件一个插件。
 *
 * - `list`：扫描目录（不递归，只看 `.json` 普通文件），无法加载的文件记在 `skipped`，不挡住其余插件；
 *   同一插件 id 出现在多个文件中时，文件名排在前面的生效。
 * - `install`：先校验并返回预览（含将被替换的同 id 插件），确认后以 `<插件 id>.json` 写入目录。
 *   写入的是校验后的内容，不是原文件。
 * - `previewText` / `installText`：同样的校验与写入，内容来自官方目录（`provider-catalog-service`）；
 *   相对路径的图标按插件文件的地址解析后写入。
 * - `remove`：删除插件文件。已用插件添加的供应商把值复制进了配置，不受影响。
 * - 来源（ADR-0050）：从官方目录安装时，在 `.provenance.json` 中记下插件的实际来源与写入内容的 `sha256`。
 *   只有记录存在、文件内容与记录一致时才显示为官方或第三方；从文件安装、直接放进目录或被改动过的插件都是
 *   `local`。插件内容里的 `source` 只是声明，无法让文件安装的插件显示为官方。
 *
 * 插件只有数据，不执行代码。不依赖 Electron；选择文件的对话框由调用方提供。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  PROVIDER_PLUGIN_MAX_BYTES,
  ProviderPluginError,
  ProviderPluginErrorCode,
  parseProviderPlugin,
  providerPluginInfo,
  resolvePluginIcons,
} from '@cairn/core'
import {
  PROVIDER_PLUGIN_ID_PATTERN,
  RpcError,
  type PluginOrigin,
  type ProviderPluginInfo,
  type ProviderPluginManifest,
  type ProviderPluginSkipped,
} from '@cairn/protocol'

export interface ProviderPluginServiceOptions {
  /** 插件目录（应用数据目录下的 `provider-plugins/`）；不存在时当作没有插件。 */
  readonly dir: string
  /** 让用户选择插件文件；取消时返回 undefined。没提供时视为取消。 */
  readonly pickFile?: () => Promise<string | undefined>
}

export interface ProviderPluginService {
  list(): { plugins: ProviderPluginInfo[]; skipped: ProviderPluginSkipped[] }
  pick(): Promise<{ path?: string }>
  install(input: { path: string; confirm?: boolean | undefined }): {
    installed: boolean
    replaces: boolean
    plugin: ProviderPluginInfo
  }
  /** 校验插件文本并返回预览（不写盘）。`base` 是文本的来源地址，用于解析相对图标。 */
  previewText(text: string, source: TextSource): { replaces: boolean; plugin: ProviderPluginInfo }
  /** 校验并安装插件文本。 */
  installText(
    text: string,
    source: TextSource,
  ): { installed: true; replaces: boolean; plugin: ProviderPluginInfo }
  remove(input: { id: string }): Record<string, never>
}

export interface TextSource {
  /** 文本的 https 地址；相对图标按它解析。 */
  readonly base?: string
  /** 插件 id 必须是这个（来自官方目录的索引），否则报 `providers.catalog.invalid`。 */
  readonly expectId?: string
  /** 来自官方目录时的实际来源；省略表示本地文件。 */
  readonly origin?: Exclude<PluginOrigin, 'local'>
}

/** 记录从官方目录安装的插件来源的文件；以 `.` 开头，扫描时不当作插件。 */
export const PROVENANCE_FILE = '.provenance.json'

interface Provenance {
  readonly origin: Exclude<PluginOrigin, 'local'>
  readonly sha256: string
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

interface Loaded {
  readonly file: string
  readonly manifest: ProviderPluginManifest
  readonly info: ProviderPluginInfo
  /** 文件内容的摘要，与来源记录比对。 */
  readonly sha256: string
}

const missing = (error: unknown) => {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function rethrow(error: unknown): never {
  if (error instanceof ProviderPluginError) {
    throw new RpcError(error.code, error.path ? { path: error.path } : undefined)
  }
  throw error
}

/** 读取并解析一个插件文件；符号链接、目录与过大的文件都拒绝。 */
function load(file: string): {
  manifest: ProviderPluginManifest
  info: ProviderPluginInfo
  sha256: string
} {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProviderPluginError(ProviderPluginErrorCode.Invalid, 'Not a regular file.')
  }
  if (stat.size > PROVIDER_PLUGIN_MAX_BYTES) {
    throw new ProviderPluginError(ProviderPluginErrorCode.TooLarge, 'The plugin file is too large.')
  }
  const text = fs.readFileSync(file, 'utf8')
  return { ...parse(text), sha256: sha256(text) }
}

function parse(
  text: string,
  base?: string,
  origin: PluginOrigin = 'local',
): { manifest: ProviderPluginManifest; info: ProviderPluginInfo } {
  const parsed = parseProviderPlugin(text)
  const manifest = base === undefined ? parsed : resolvePluginIcons(parsed, base)
  return { manifest, info: providerPluginInfo(manifest, origin) }
}

/** 写入插件目录的内容（校验后的插件，固定格式）。 */
const serialize = (manifest: ProviderPluginManifest) => `${JSON.stringify(manifest, null, 2)}\n`

const codeOf = (error: unknown): string =>
  error instanceof ProviderPluginError ? error.code : ProviderPluginErrorCode.Invalid

export function createProviderPluginService(
  options: ProviderPluginServiceOptions,
): ProviderPluginService {
  const provenanceFile = path.join(options.dir, PROVENANCE_FILE)

  const readProvenance = (): Record<string, Provenance> => {
    try {
      const raw = JSON.parse(fs.readFileSync(provenanceFile, 'utf8')) as { plugins?: unknown }
      const out: Record<string, Provenance> = {}
      for (const [id, value] of Object.entries((raw.plugins ?? {}) as Record<string, unknown>)) {
        const record = value as Partial<Provenance> | null
        if (
          (record?.origin === 'official' || record?.origin === 'third-party') &&
          typeof record.sha256 === 'string'
        ) {
          out[id] = { origin: record.origin, sha256: record.sha256 }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  const writeProvenance = (id: string, record: Provenance | undefined) => {
    const all = readProvenance()
    if (record) all[id] = record
    else if (id in all) delete all[id]
    else return
    fs.mkdirSync(options.dir, { recursive: true })
    const temp = `${provenanceFile}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, plugins: all }, null, 2)}\n`)
    fs.renameSync(temp, provenanceFile)
  }

  /** `all` 含被同 id 挡住的文件；`loaded` 只含生效的。 */
  const scan = (): { loaded: Loaded[]; all: Loaded[]; skipped: ProviderPluginSkipped[] } => {
    let names: string[]
    try {
      names = fs.readdirSync(options.dir)
    } catch (error) {
      if (missing(error)) return { loaded: [], all: [], skipped: [] }
      throw error
    }
    const loaded: Loaded[] = []
    const all: Loaded[] = []
    const skipped: ProviderPluginSkipped[] = []
    const seen = new Set<string>()
    const provenance = readProvenance()
    for (const name of names
      .filter((n) => !n.startsWith('.') && n.toLowerCase().endsWith('.json'))
      .sort()) {
      const file = path.join(options.dir, name)
      try {
        const loadedFile = load(file)
        const { manifest } = loadedFile
        const record = provenance[manifest.id]
        const origin: PluginOrigin =
          record !== undefined &&
          record.sha256 === loadedFile.sha256 &&
          path.basename(file) === `${manifest.id}.json`
            ? record.origin
            : 'local'
        const info = { ...loadedFile.info, origin }
        all.push({ file, manifest, info, sha256: loadedFile.sha256 })
        if (seen.has(manifest.id)) {
          skipped.push({ file: name, code: ProviderPluginErrorCode.Duplicate })
          continue
        }
        seen.add(manifest.id)
        loaded.push({ file, manifest, info, sha256: loadedFile.sha256 })
      } catch (error) {
        if (missing(error)) continue
        skipped.push({ file: name, code: codeOf(error) })
      }
    }
    return { loaded, all, skipped }
  }

  const existingOf = (id: string) => scan().all.filter((item) => item.manifest.id === id)

  /**
   * 以 `<插件 id>.json` 写入（先写临时文件再改名），删掉同 id 的其他文件，并更新来源记录（本地文件安装时清除）；
   * 返回是否替换了已有插件。
   */
  const write = (
    manifest: ProviderPluginManifest,
    origin: Exclude<PluginOrigin, 'local'> | undefined,
  ): boolean => {
    const existing = existingOf(manifest.id)
    fs.mkdirSync(options.dir, { recursive: true })
    const dest = path.join(options.dir, `${manifest.id}.json`)
    const temp = `${dest}.${process.pid}.tmp`
    const text = serialize(manifest)
    fs.writeFileSync(temp, text)
    fs.renameSync(temp, dest)
    writeProvenance(manifest.id, origin ? { origin, sha256: sha256(text) } : undefined)
    for (const item of existing) {
      if (path.resolve(item.file) !== path.resolve(dest)) fs.rmSync(item.file, { force: true })
    }
    return existing.length > 0
  }

  const parseText = (text: string, source: TextSource) => {
    let parsed: { manifest: ProviderPluginManifest; info: ProviderPluginInfo }
    try {
      parsed = parse(text, source.base, source.origin)
    } catch (error) {
      rethrow(error)
    }
    if (source.expectId !== undefined && parsed.manifest.id !== source.expectId) {
      throw new RpcError('providers.catalog.invalid', { id: source.expectId })
    }
    return parsed
  }

  return {
    list() {
      const { loaded, skipped } = scan()
      return { plugins: loaded.map((item) => item.info), skipped }
    },

    async pick() {
      const picked = await options.pickFile?.()
      return picked === undefined ? {} : { path: picked }
    },

    install({ path: source, confirm }) {
      let parsed: { manifest: ProviderPluginManifest; info: ProviderPluginInfo }
      try {
        parsed = load(source)
      } catch (error) {
        if (missing(error)) throw new RpcError(ProviderPluginErrorCode.NotFound)
        rethrow(error)
      }
      if (confirm !== true) {
        return {
          installed: false,
          replaces: existingOf(parsed.manifest.id).length > 0,
          plugin: parsed.info,
        }
      }
      return { installed: true, replaces: write(parsed.manifest, undefined), plugin: parsed.info }
    },

    previewText(text, source) {
      const parsed = parseText(text, source)
      return { replaces: existingOf(parsed.manifest.id).length > 0, plugin: parsed.info }
    },

    installText(text, source) {
      const parsed = parseText(text, source)
      return {
        installed: true,
        replaces: write(parsed.manifest, source.origin),
        plugin: parsed.info,
      }
    },

    remove({ id }) {
      if (!PROVIDER_PLUGIN_ID_PATTERN.test(id)) {
        throw new RpcError(ProviderPluginErrorCode.NotFound, { id })
      }
      const matches = scan().all.filter((item) => item.manifest.id === id)
      if (matches.length === 0) throw new RpcError(ProviderPluginErrorCode.NotFound, { id })
      for (const item of matches) fs.rmSync(item.file, { force: true })
      writeProvenance(id, undefined)
      return {}
    },
  }
}
