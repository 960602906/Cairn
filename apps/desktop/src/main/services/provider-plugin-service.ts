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
 *
 * 插件只有数据，不执行代码。不依赖 Electron；选择文件的对话框由调用方提供。
 */
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
}

interface Loaded {
  readonly file: string
  readonly manifest: ProviderPluginManifest
  readonly info: ProviderPluginInfo
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
function load(file: string): { manifest: ProviderPluginManifest; info: ProviderPluginInfo } {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProviderPluginError(ProviderPluginErrorCode.Invalid, 'Not a regular file.')
  }
  if (stat.size > PROVIDER_PLUGIN_MAX_BYTES) {
    throw new ProviderPluginError(ProviderPluginErrorCode.TooLarge, 'The plugin file is too large.')
  }
  return parse(fs.readFileSync(file, 'utf8'))
}

function parse(
  text: string,
  base?: string,
): { manifest: ProviderPluginManifest; info: ProviderPluginInfo } {
  const parsed = parseProviderPlugin(text)
  const manifest = base === undefined ? parsed : resolvePluginIcons(parsed, base)
  return { manifest, info: providerPluginInfo(manifest) }
}

const codeOf = (error: unknown): string =>
  error instanceof ProviderPluginError ? error.code : ProviderPluginErrorCode.Invalid

export function createProviderPluginService(
  options: ProviderPluginServiceOptions,
): ProviderPluginService {
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
    for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
      const file = path.join(options.dir, name)
      try {
        const { manifest, info } = load(file)
        all.push({ file, manifest, info })
        if (seen.has(manifest.id)) {
          skipped.push({ file: name, code: ProviderPluginErrorCode.Duplicate })
          continue
        }
        seen.add(manifest.id)
        loaded.push({ file, manifest, info })
      } catch (error) {
        if (missing(error)) continue
        skipped.push({ file: name, code: codeOf(error) })
      }
    }
    return { loaded, all, skipped }
  }

  const existingOf = (id: string) => scan().all.filter((item) => item.manifest.id === id)

  /** 以 `<插件 id>.json` 写入（先写临时文件再改名），删掉同 id 的其他文件；返回是否替换了已有插件。 */
  const write = (manifest: ProviderPluginManifest): boolean => {
    const existing = existingOf(manifest.id)
    fs.mkdirSync(options.dir, { recursive: true })
    const dest = path.join(options.dir, `${manifest.id}.json`)
    const temp = `${dest}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.renameSync(temp, dest)
    for (const item of existing) {
      if (path.resolve(item.file) !== path.resolve(dest)) fs.rmSync(item.file, { force: true })
    }
    return existing.length > 0
  }

  const parseText = (text: string, source: TextSource) => {
    let parsed: { manifest: ProviderPluginManifest; info: ProviderPluginInfo }
    try {
      parsed = parse(text, source.base)
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
      return { installed: true, replaces: write(parsed.manifest), plugin: parsed.info }
    },

    previewText(text, source) {
      const parsed = parseText(text, source)
      return { replaces: existingOf(parsed.manifest.id).length > 0, plugin: parsed.info }
    },

    installText(text, source) {
      const parsed = parseText(text, source)
      return { installed: true, replaces: write(parsed.manifest), plugin: parsed.info }
    },

    remove({ id }) {
      if (!PROVIDER_PLUGIN_ID_PATTERN.test(id)) {
        throw new RpcError(ProviderPluginErrorCode.NotFound, { id })
      }
      const matches = scan().all.filter((item) => item.manifest.id === id)
      if (matches.length === 0) throw new RpcError(ProviderPluginErrorCode.NotFound, { id })
      for (const item of matches) fs.rmSync(item.file, { force: true })
      return {}
    },
  }
}
