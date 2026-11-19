/**
 * 文件树（目录功能同步）：按项目 id 解析根目录，只允许访问项目目录之内。
 *
 * 所有路径都使用相对项目根的 `/` 分隔形式。读写前同时校验词法路径与
 * `realpath`，防止 `..`、绝对路径和符号链接逃逸到项目之外。
 */
import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  FILE_CONTENT_MAX_CHARS,
  RpcError,
  type FileContent,
  type FileTreeEntry,
  type FileTreeEntryKind,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import { decodeFile, READ_FILE_MAX_BYTES } from '@cairn/tools'

export const FileServiceErrorCode = {
  ProjectNotFound: 'fs.project_not_found',
  InvalidPath: 'fs.invalid_path',
  NotDirectory: 'fs.not_directory',
  IsDirectory: 'fs.is_directory',
  NotFound: 'fs.not_found',
  Conflict: 'fs.conflict',
  Failed: 'fs.failed',
} as const

export interface FileCommands {
  list(input: {
    projectId: string
    path?: string | undefined
    showHidden?: boolean | undefined
    limit?: number | undefined
  }): Promise<{ entries: FileTreeEntry[]; truncated: boolean }>
  read(input: { projectId: string; path: string }): Promise<{ content: FileContent }>
  /**
   * 把消息里提到的文件引用解析成项目内的相对路径。
   *
   * - 带目录的相对路径按原样确认；
   * - 只有文件名的（`app.tsx`）在项目文件列表里找同名文件，取层级最浅的一个；
   * - 不存在、越界或不是文件的引用不会出现在结果里。
   */
  exists(input: {
    projectId: string
    paths: readonly string[]
  }): Promise<{ resolved: Record<string, string> }>
  create(input: {
    projectId: string
    path: string
    kind: FileTreeEntryKind
  }): Promise<{ path: string }>
  rename(input: { projectId: string; from: string; to: string }): Promise<{ path: string }>
  delete(input: { projectId: string; path: string }): Promise<Record<string, never>>
  reveal(input: { projectId: string; path?: string | undefined }): Promise<Record<string, never>>
}

export interface FileServiceOptions {
  readonly storage: Pick<Storage, 'projects'>
  /** 在系统文件管理器中定位路径；测试可注入。 */
  readonly revealPath?: (absolutePath: string) => void
  /** 列出项目内文件（相对路径，遵守 .gitignore）；用于解析正文里的裸文件名。 */
  readonly listFiles?: (root: string) => Promise<string[]>
}

const DEFAULT_LIST_LIMIT = 500
const MAX_PATH_LENGTH = 4096
/** 文件列表缓存多久（毫秒）。 */
const LIST_TTL_MS = 10_000
/** 最多索引多少个文件；再大的仓库只解析前面这些。 */
export const MAX_INDEXED_FILES = 50_000

/** 能在右侧直接预览的图片格式。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

const isNotFound = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const isConflict = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'

function normalizeRelative(input: string | undefined): string {
  const original = (input ?? '').trim()
  if (
    path.isAbsolute(original) ||
    /^[A-Za-z]:[\\/]/.test(original) ||
    original.startsWith('\\\\') ||
    original.startsWith('//')
  ) {
    throw new RpcError(FileServiceErrorCode.InvalidPath, { path: original })
  }
  const raw = original.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (raw.length > MAX_PATH_LENGTH) {
    throw new RpcError(FileServiceErrorCode.InvalidPath, { path: original })
  }
  if (raw === '') return ''
  const parts = raw.split('/')
  if (
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        part.includes('\0') ||
        /^[A-Za-z]:$/.test(part),
    )
  ) {
    throw new RpcError(FileServiceErrorCode.InvalidPath, { path: original })
  }
  return parts.join('/')
}

function displayPath(relative: string): string {
  return relative === '' ? '.' : relative
}

function sameOrInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 路径层级（段数），用来在多个同名文件里挑最浅的。 */
const depthOf = (file: string) => file.split('/').length

/** 更浅、更短、字典序更小的优先，保证同名文件总取同一个。 */
function preferredPath(a: string, b: string): string {
  const byDepth = depthOf(a) - depthOf(b)
  if (byDepth !== 0) return byDepth < 0 ? a : b
  if (a.length !== b.length) return a.length < b.length ? a : b
  return a.localeCompare(b) <= 0 ? a : b
}

/**
 * 在项目文件列表里找一个引用对应的文件。
 *
 * - `app.tsx` 这种只有名字的，按文件名匹配；
 * - `src/renderer/app.tsx` 这种带目录的，按路径后缀匹配（消息里常省略前面的目录）。
 *
 * 同名时取层级最浅的一个；找不到返回 undefined。
 */
export function matchIndexedPath(files: readonly string[], candidate: string): string | undefined {
  const lower = candidate.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (lower === '') return undefined
  const needle = lower.toLowerCase()
  const bare = !needle.includes('/')
  let best: string | undefined
  for (const file of files) {
    const fileLower = file.toLowerCase()
    const hit = bare
      ? fileLower.slice(fileLower.lastIndexOf('/') + 1) === needle
      : fileLower.endsWith(`/${needle}`)
    if (hit && (best === undefined || preferredPath(file, best) === file)) best = file
  }
  return best
}

export function createFileService(options: FileServiceOptions): FileCommands {
  const { storage } = options
  const revealPath = options.revealPath ?? (() => undefined)

  const projectRoot = async (projectId: string): Promise<string> => {
    const project = storage.projects.get(projectId)
    if (!project || project.removedAt !== undefined) {
      throw new RpcError(FileServiceErrorCode.ProjectNotFound, { projectId })
    }
    try {
      return await fsp.realpath(project.path)
    } catch (error) {
      if (isNotFound(error)) {
        throw new RpcError(FileServiceErrorCode.NotFound, { path: project.path })
      }
      throw new RpcError(FileServiceErrorCode.Failed, { path: project.path })
    }
  }

  /** 项目文件列表（按根缓存几秒）：只用来解析消息里的文件引用。 */
  const listCache = new Map<string, { at: number; files: Promise<readonly string[]> }>()
  const indexedFiles = async (root: string): Promise<readonly string[] | undefined> => {
    const listFiles = options.listFiles
    if (listFiles === undefined) return undefined
    const cached = listCache.get(root)
    const entry =
      cached !== undefined && Date.now() - cached.at < LIST_TTL_MS
        ? cached
        : {
            at: Date.now(),
            files: listFiles(root).then((list) => list.slice(0, MAX_INDEXED_FILES)),
          }
    listCache.set(root, entry)
    // 列不出来的结果不缓存，下次重新列。
    entry.files.catch(() => {
      if (listCache.get(root) === entry) listCache.delete(root)
    })
    try {
      return await entry.files
    } catch {
      return undefined
    }
  }

  const resolveTarget = async (
    projectId: string,
    input: string | undefined,
    options: { allowRoot: boolean; mustExist: boolean },
  ): Promise<{ root: string; relative: string; absolute: string }> => {
    const root = await projectRoot(projectId)
    const relative = normalizeRelative(input)
    if (relative === '' && !options.allowRoot) {
      throw new RpcError(FileServiceErrorCode.InvalidPath, { path: relative })
    }
    const lexical = path.resolve(root, ...relative.split('/').filter(Boolean))
    if (!sameOrInside(root, lexical)) {
      throw new RpcError(FileServiceErrorCode.InvalidPath, { path: relative })
    }
    try {
      const real = await fsp.realpath(lexical)
      if (!sameOrInside(root, real)) {
        throw new RpcError(FileServiceErrorCode.InvalidPath, { path: relative })
      }
      return { root, relative, absolute: real }
    } catch (error) {
      if (error instanceof RpcError) throw error
      if (!isNotFound(error) || options.mustExist) {
        throw new RpcError(
          isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
          { path: relative },
        )
      }
      return { root, relative, absolute: lexical }
    }
  }

  const ensureParentInsideRoot = async (root: string, absolute: string, input: string) => {
    try {
      const parent = await fsp.realpath(path.dirname(absolute))
      if (!sameOrInside(root, parent)) {
        throw new RpcError(FileServiceErrorCode.InvalidPath, { path: input })
      }
    } catch (error) {
      if (error instanceof RpcError) throw error
      throw new RpcError(
        isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
        { path: input },
      )
    }
  }

  return {
    async list(input) {
      const target = await resolveTarget(input.projectId, input.path, {
        allowRoot: true,
        mustExist: true,
      })
      try {
        if (!(await fsp.stat(target.absolute)).isDirectory()) {
          throw new RpcError(FileServiceErrorCode.NotDirectory, {
            path: displayPath(target.relative),
          })
        }
      } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(
          isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
          { path: displayPath(target.relative) },
        )
      }
      let dirents: Dirent[]
      try {
        dirents = await fsp.readdir(target.absolute, { withFileTypes: true })
      } catch (error) {
        throw new RpcError(
          isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
          { path: displayPath(target.relative) },
        )
      }
      const entries: FileTreeEntry[] = []
      for (const dirent of dirents) {
        if (dirent.name === '.git') continue
        const hidden = dirent.name.startsWith('.')
        if (hidden && !input.showHidden) continue
        let kind: FileTreeEntryKind = dirent.isDirectory() ? 'dir' : 'file'
        if (dirent.isSymbolicLink()) {
          try {
            kind = (await fsp.stat(path.join(target.absolute, dirent.name))).isDirectory()
              ? 'dir'
              : 'file'
          } catch {
            kind = 'file'
          }
        }
        entries.push({
          path: target.relative === '' ? dirent.name : `${target.relative}/${dirent.name}`,
          name: dirent.name,
          kind,
          hidden,
        })
      }
      entries.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      })
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      return { entries: entries.slice(0, limit), truncated: entries.length > limit }
    },

    async exists(input) {
      // 项目不存在时仍然报错；单个路径的问题只影响它自己。
      const root = await projectRoot(input.projectId)
      const resolved: Record<string, string> = {}
      let files: readonly string[] | undefined
      for (const candidate of input.paths) {
        const ref = candidate.trim()
        if (ref === '') continue
        // 先按原样的相对路径确认；它是项目里的真实文件时最准确。
        try {
          const target = await resolveTarget(input.projectId, ref, {
            allowRoot: false,
            mustExist: true,
          })
          if ((await fsp.stat(target.absolute)).isFile()) {
            resolved[candidate] = target.relative
            continue
          }
        } catch {
          // 不存在或越界：再按文件名 / 路径后缀在项目文件列表里找。
        }
        if (path.isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref)) continue
        files ??= await indexedFiles(root)
        const match = files === undefined ? undefined : matchIndexedPath(files, ref)
        if (match !== undefined) resolved[candidate] = match
      }
      return { resolved }
    },

    async read(input) {
      const target = await resolveTarget(input.projectId, input.path, {
        allowRoot: false,
        mustExist: true,
      })
      let size: number
      try {
        const stats = await fsp.stat(target.absolute)
        if (!stats.isFile()) {
          throw new RpcError(FileServiceErrorCode.IsDirectory, {
            path: displayPath(target.relative),
          })
        }
        size = stats.size
      } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(
          isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
          { path: displayPath(target.relative) },
        )
      }
      if (size > READ_FILE_MAX_BYTES) {
        return { content: { kind: 'too_large', size } }
      }
      let buffer: Buffer
      try {
        buffer = await fsp.readFile(target.absolute)
      } catch (error) {
        throw new RpcError(
          isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
          { path: displayPath(target.relative) },
        )
      }
      // 图片直接给界面一个 data URL，右侧可以看图而不是“二进制文件”。
      const mime = IMAGE_MIME[path.extname(target.relative).slice(1).toLowerCase()]
      if (mime !== undefined) {
        return {
          content: {
            kind: 'binary',
            size: buffer.length,
            url: `data:${mime};base64,${buffer.toString('base64')}`,
          },
        }
      }
      const decoded = decodeFile(buffer)
      if (decoded.binary) return { content: { kind: 'binary', size: buffer.length } }
      if (decoded.text.length > FILE_CONTENT_MAX_CHARS) {
        return { content: { kind: 'too_large', size: buffer.length } }
      }
      return { content: { kind: 'text', text: decoded.text } }
    },

    async create(input) {
      const target = await resolveTarget(input.projectId, input.path, {
        allowRoot: false,
        mustExist: false,
      })
      await ensureParentInsideRoot(target.root, target.absolute, input.path)
      const parent = path.dirname(target.absolute)
      if (!sameOrInside(target.root, parent)) {
        throw new RpcError(FileServiceErrorCode.InvalidPath, { path: input.path })
      }
      try {
        const parentStat = await fsp.stat(parent)
        if (!parentStat.isDirectory()) {
          throw new RpcError(FileServiceErrorCode.NotDirectory, { path: input.path })
        }
        if (input.kind === 'dir') await fsp.mkdir(target.absolute)
        else await fsp.writeFile(target.absolute, '', { flag: 'wx' })
      } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(
          isConflict(error) ? FileServiceErrorCode.Conflict : FileServiceErrorCode.Failed,
          { path: input.path },
        )
      }
      return { path: target.relative }
    },

    async rename(input) {
      const from = await resolveTarget(input.projectId, input.from, {
        allowRoot: false,
        mustExist: true,
      })
      const to = await resolveTarget(input.projectId, input.to, {
        allowRoot: false,
        mustExist: false,
      })
      await ensureParentInsideRoot(to.root, to.absolute, input.to)
      try {
        await fsp.access(to.absolute)
        throw new RpcError(FileServiceErrorCode.Conflict, { path: input.to })
      } catch (error) {
        if (error instanceof RpcError) throw error
        if (!isNotFound(error)) {
          throw new RpcError(FileServiceErrorCode.Failed, { path: input.to })
        }
      }
      try {
        await fsp.rename(from.absolute, to.absolute)
      } catch {
        throw new RpcError(FileServiceErrorCode.Failed, { path: input.from })
      }
      return { path: to.relative }
    },

    async delete(input) {
      const target = await resolveTarget(input.projectId, input.path, {
        allowRoot: false,
        mustExist: true,
      })
      try {
        await fsp.rm(target.absolute, { recursive: true, force: false })
      } catch (error) {
        throw new RpcError(
          isNotFound(error) ? FileServiceErrorCode.NotFound : FileServiceErrorCode.Failed,
          { path: input.path },
        )
      }
      return {}
    },

    async reveal(input) {
      const target = await resolveTarget(input.projectId, input.path, {
        allowRoot: true,
        mustExist: true,
      })
      revealPath(target.absolute)
      return {}
    },
  }
}
