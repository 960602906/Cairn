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
  /** 批量确认相对路径在项目里存在且是文件；不存在或越界的直接略过。 */
  exists(input: { projectId: string; paths: readonly string[] }): Promise<{ existing: string[] }>
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
}

const DEFAULT_LIST_LIMIT = 500
const MAX_PATH_LENGTH = 4096

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
      await projectRoot(input.projectId)
      const existing = new Set<string>()
      for (const candidate of input.paths) {
        try {
          const target = await resolveTarget(input.projectId, candidate, {
            allowRoot: false,
            mustExist: true,
          })
          if ((await fsp.stat(target.absolute)).isFile()) existing.add(target.relative)
        } catch {
          // 不存在、越界或读不了：不在这条消息里变成链接。
        }
      }
      return { existing: [...existing] }
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
