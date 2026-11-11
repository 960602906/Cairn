/**
 * 输入框的 `@` 引用（ADR-0037）：给输入框找候选（`fs.search`），发送时把引用展开成给模型看的上下文。
 *
 * - 根目录是会话的工作区（隔离工作区时是它自己的目录），所有路径都相对它、用 `/` 分隔。
 * - 候选来自 ripgrep 的 `--files`：遵守 `.gitignore`，跳过隐藏文件与 `.git`。结果按工作区缓存几秒，
 *   输入框每打一个字就搜一次也不会反复扫目录。目录由文件路径推出来。
 * - 展开时同时校验词法路径和 `realpath`，不能借 `..` 或符号链接读到工作区之外；不存在、越界、
 *   读不了的引用直接忽略，不让整条消息失败。
 * - 文本文件不超过单个上限、总量不超过预算时附上内容；超出时只附路径和行数，让模型自己去读。
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  RpcError,
  type FileSearchEntry,
  type PromptMention,
  type ResolvedMention,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import { decodeFile, splitLines } from '@cairn/tools'

export const MentionErrorCode = {
  SessionNotFound: 'fs.session_not_found',
  ProjectNotFound: 'fs.project_not_found',
} as const

export interface MentionCommands {
  search(input: {
    sessionId?: string | undefined
    projectId?: string | undefined
    query: string
    limit?: number | undefined
  }): Promise<{ entries: FileSearchEntry[]; truncated: boolean }>
  /** 展开引用；没有一个能展开时 `context` 为 undefined。 */
  expand(input: {
    sessionId: string
    mentions: readonly PromptMention[]
  }): Promise<{ mentions: ResolvedMention[]; context: string | undefined }>
}

export interface MentionServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'projects'>
  /** 列出工作区里的文件（相对路径）。默认用 ripgrep。 */
  readonly listFiles: (root: string) => Promise<string[]>
  readonly now?: () => number
}

const DEFAULT_SEARCH_LIMIT = 50
/** 文件列表缓存多久（毫秒）。 */
const LIST_TTL_MS = 10_000
/** 最多索引多少个文件；再大的仓库只搜前面这些。 */
export const MAX_INDEXED_FILES = 50_000
/** 单个文件附上内容的上限（字节，按 UTF-8 计）。 */
export const MENTION_FILE_LIMIT = 32 * 1024
/** 一条消息里所有引用内容的总预算（字节）。 */
export const MENTION_TOTAL_LIMIT = 96 * 1024
/** 读文件前的大小上限；更大的文件只附路径。 */
const MAX_READ_BYTES = 2 * 1024 * 1024
/** 目录引用最多列出的条目数。 */
export const MENTION_DIR_LIMIT = 200

/** 发给模型的上下文开头（英文，与工具说明一致）。 */
export const MENTION_CONTEXT_HEADER =
  'The user referenced these files and folders with @ in the message above. ' +
  'Their current contents are included below.'

/** 用 ripgrep 列出遵守 `.gitignore` 的文件。没有文件时 ripgrep 以 1 退出，按空列表处理。 */
export function ripgrepFileLister(ripgrepPath: string) {
  return (root: string) =>
    new Promise<string[]>((resolve, reject) => {
      execFile(
        ripgrepPath,
        ['--files', '--glob', '!.git'],
        { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error && (error as { code?: unknown }).code !== 1) {
            reject(error)
            return
          }
          resolve(
            stdout
              .split(/\r?\n/)
              .filter((line) => line !== '')
              .map((line) => line.replace(/\\/g, '/').replace(/^\.\//, '')),
          )
        },
      )
    })
}

/** 规范成相对路径；绝对路径、盘符、`..` 与空段返回 undefined。 */
export function normalizeMentionPath(input: string): string | undefined {
  const raw = input.trim().replace(/\\/g, '/')
  if (raw === '' || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return undefined
  const trimmed = raw.replace(/\/+$/, '')
  if (trimmed === '') return undefined
  const parts = trimmed.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
    return undefined
  }
  return parts.join('/')
}

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

type Ranked = { entry: FileSearchEntry; rank: number }

/** 路径里依次出现查询的每个字符（模糊匹配的最后一档）。 */
function subsequence(text: string, query: string): boolean {
  let index = 0
  for (const char of text) {
    if (char === query[index]) index += 1
    if (index === query.length) return true
  }
  return false
}

function rankEntry(entry: FileSearchEntry, query: string): number {
  const lower = entry.path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  if (name === query || lower === query) return 0
  if (name.startsWith(query) || lower.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (lower.includes(query)) return 3
  return subsequence(lower, query) ? 4 : -1
}

/** 在文件列表里搜：空查询列第一层，`dir/` 列这个目录的下一层，其他按名称模糊匹配。 */
export function searchEntries(
  files: readonly string[],
  rawQuery: string,
  limit: number,
): { entries: FileSearchEntry[]; truncated: boolean } {
  const dirs = new Set<string>()
  for (const file of files) {
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) {
      dirs.add(file.slice(0, i))
    }
  }
  const all: FileSearchEntry[] = [
    ...[...dirs].map((p) => ({ path: p, kind: 'dir' as const })),
    ...files.map((p) => ({ path: p, kind: 'file' as const })),
  ]
  const query = rawQuery.trim().replace(/\\/g, '/').toLowerCase()
  const byKindThenPath = (a: FileSearchEntry, b: FileSearchEntry) =>
    (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || a.path.localeCompare(b.path)

  let matches: FileSearchEntry[]
  if (query === '' || query.endsWith('/')) {
    const parent = query.replace(/\/+$/, '')
    matches = all
      .filter((entry) => {
        const lower = entry.path.toLowerCase()
        const slash = lower.lastIndexOf('/')
        return (slash === -1 ? '' : lower.slice(0, slash)) === parent
      })
      .sort(byKindThenPath)
  } else {
    const ranked: Ranked[] = []
    for (const entry of all) {
      const rank = rankEntry(entry, query)
      if (rank >= 0) ranked.push({ entry, rank })
    }
    matches = ranked
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.entry.path.length - b.entry.path.length ||
          byKindThenPath(a.entry, b.entry),
      )
      .map((item) => item.entry)
  }
  return { entries: matches.slice(0, limit), truncated: matches.length > limit }
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8')

const label = (mention: PromptMention) =>
  mention.lines === undefined
    ? mention.path
    : `${mention.path}:${mention.lines.start}-${mention.lines.end}`

export function createMentionService(options: MentionServiceOptions): MentionCommands {
  const { storage, listFiles } = options
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; files: Promise<string[]> }>()

  const workspace = (sessionId: string) => {
    const record = storage.sessions.get(sessionId)
    if (!record) throw new RpcError(MentionErrorCode.SessionNotFound, { sessionId })
    return record.workspacePath
  }

  const searchRoot = (input: {
    sessionId?: string | undefined
    projectId?: string | undefined
  }) => {
    if (input.sessionId !== undefined) return workspace(input.sessionId)
    const project =
      input.projectId === undefined ? undefined : storage.projects.get(input.projectId)
    if (!project)
      throw new RpcError(MentionErrorCode.ProjectNotFound, { projectId: input.projectId ?? '' })
    return project.path
  }

  const filesOf = (root: string) => {
    const cached = cache.get(root)
    if (cached && now() - cached.at < LIST_TTL_MS) return cached.files
    const files = listFiles(root).then((list) => list.slice(0, MAX_INDEXED_FILES))
    cache.set(root, { at: now(), files })
    // 失败的结果不缓存，下次重新列。
    files.catch(() => {
      if (cache.get(root)?.files === files) cache.delete(root)
    })
    return files
  }

  /** 解析到工作区内的真实路径；越界或不存在返回 undefined。 */
  const resolve = async (realRoot: string, relative: string) => {
    const lexical = path.resolve(realRoot, relative)
    if (!inside(realRoot, lexical)) return undefined
    try {
      const real = await fsp.realpath(lexical)
      return inside(realRoot, real) ? real : undefined
    } catch {
      return undefined
    }
  }

  const describeDir = async (absolute: string, relative: string) => {
    const entries = (await fsp.readdir(absolute, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.git')
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) =>
        a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1,
      )
    const shown = entries.slice(0, MENTION_DIR_LIMIT)
    const more = entries.length - shown.length
    const body = [...shown, ...(more > 0 ? [`… ${more} more entries`] : [])].join('\n')
    return `<directory path="${escapeAttr(relative)}/">\n${body}\n</directory>`
  }

  return {
    async search({ query, limit, ...where }) {
      const root = searchRoot(where)
      let files: string[]
      try {
        files = await filesOf(root)
      } catch {
        return { entries: [], truncated: false }
      }
      return searchEntries(files, query, limit ?? DEFAULT_SEARCH_LIMIT)
    },

    async expand({ sessionId, mentions }) {
      const root = workspace(sessionId)
      let realRoot: string
      try {
        realRoot = await fsp.realpath(root)
      } catch {
        return { mentions: [], context: undefined }
      }
      const resolved: ResolvedMention[] = []
      const blocks: string[] = []
      const seen = new Set<string>()
      let budget = MENTION_TOTAL_LIMIT

      for (const mention of mentions) {
        const relative = normalizeMentionPath(mention.path)
        if (relative === undefined) continue
        const normalized: PromptMention = {
          path: relative,
          ...(mention.lines ? { lines: mention.lines } : {}),
        }
        const key = label(normalized)
        if (seen.has(key)) continue
        seen.add(key)
        const absolute = await resolve(realRoot, relative)
        if (absolute === undefined) continue
        try {
          const stat = await fsp.stat(absolute)
          if (stat.isDirectory()) {
            const block = await describeDir(absolute, relative)
            budget -= utf8Length(block)
            blocks.push(block)
            resolved.push({ path: relative, kind: 'dir' })
            continue
          }
          if (!stat.isFile()) continue
          resolved.push({ ...normalized, kind: 'file' })
          const attrs = `path="${escapeAttr(relative)}"`
          if (stat.size > MAX_READ_BYTES) {
            blocks.push(
              `<file ${attrs} omitted="too large">Read it with read_file if needed.</file>`,
            )
            continue
          }
          const decoded = decodeFile(await fsp.readFile(absolute))
          if (decoded.binary) {
            blocks.push(`<file ${attrs} omitted="binary"/>`)
            continue
          }
          const { lines } = splitLines(decoded.text)
          const range = normalized.lines
          const start = range ? Math.min(range.start, lines.length + 1) : 1
          const end = range ? Math.min(range.end, lines.length) : lines.length
          const body = lines.slice(start - 1, end).join('\n')
          const rangeAttr = range ? ` lines="${start}-${end}"` : ''
          const size = utf8Length(body)
          if (size > MENTION_FILE_LIMIT || size > budget) {
            blocks.push(
              `<file ${attrs}${rangeAttr} total_lines="${lines.length}" omitted="too large">` +
                'Read it with read_file if needed.</file>',
            )
            continue
          }
          budget -= size
          blocks.push(`<file ${attrs}${rangeAttr}>\n${body}\n</file>`)
        } catch {
          // 读的时候文件刚好被删或没有权限：忽略这一条，已经算进 resolved 的撤回。
          if (resolved.at(-1)?.path === relative) resolved.pop()
        }
      }

      return {
        mentions: resolved,
        context:
          blocks.length === 0 ? undefined : `${MENTION_CONTEXT_HEADER}\n\n${blocks.join('\n\n')}`,
      }
    },
  }
}
