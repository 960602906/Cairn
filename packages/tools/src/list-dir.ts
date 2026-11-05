/**
 * `list_dir`（M1-07a；架构 §9.2）：以缩进树列出目录内容；遵守 `.gitignore`（含子目录中的），总是跳过 `.git`；
 * 限制深度与条目数；不跟随符号链接（链接以 `@` 标出）。
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { estimateTokens, ToolError, type ToolDefinition } from '@nexus/core'
import ignore, { type Ignore } from 'ignore'
import { resolveOrThrow } from './paths.js'
import { bodyTokens } from './read-file.js'

export interface ListDirInput {
  /** 目录路径，相对工作区根目录；默认根目录。 */
  readonly path?: string
  readonly depth?: number
  readonly limit?: number
}

export const ListDirErrorCode = {
  NotFound: 'tool.list_dir.not_found',
  NotDirectory: 'tool.list_dir.not_directory',
  Unreadable: 'tool.list_dir.unreadable',
} as const

export const LIST_DIR_DEFAULT_DEPTH = 2
export const LIST_DIR_MAX_DEPTH = 10
export const LIST_DIR_DEFAULT_LIMIT = 200
export const LIST_DIR_MAX_LIMIT = 1000

/** 一个 `.gitignore` 及其所在目录（相对工作区，`/` 分隔，根目录为空串）。 */
interface Matcher {
  readonly base: string
  readonly ig: Ignore
}

async function loadGitignore(dir: string, base: string): Promise<Matcher | undefined> {
  try {
    const text = await fs.readFile(nodePath.join(dir, '.gitignore'), 'utf8')
    return { base, ig: ignore().add(text) }
  } catch {
    return undefined
  }
}

/** 依次应用各级 `.gitignore`，较深的规则覆盖较浅的（包括 `!` 取消忽略）。 */
function isIgnored(matchers: readonly Matcher[], relative: string, isDir: boolean): boolean {
  let ignored = false
  for (const { base, ig } of matchers) {
    // 规则只会应用到所在目录之下的路径（上级目录或遍历中经过的目录）
    const path = base === '' ? relative : relative.slice(base.length + 1)
    const result = ig.test(isDir ? `${path}/` : path)
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

/** 按名称排序（不区分大小写，结果稳定）。 */
const byName = (a: Dirent, b: Dirent) => a.name.localeCompare(b.name, 'en')

const fsError = (error: unknown) => (error as NodeJS.ErrnoException).code

export const listDirTool: ToolDefinition<ListDirInput> = {
  name: 'list_dir',
  description:
    'List the contents of a directory in the workspace as an indented tree. Directories end with "/" ' +
    'and symbolic links with "@". Files ignored by .gitignore and the .git directory are skipped. ' +
    'Use depth to control how many levels are expanded.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path, relative to the workspace root. Default: the workspace root.',
      },
      depth: {
        type: 'integer',
        minimum: 1,
        maximum: LIST_DIR_MAX_DEPTH,
        description: `How many levels to expand. Default ${LIST_DIR_DEFAULT_DEPTH}.`,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIST_DIR_MAX_LIMIT,
        description: `Maximum number of entries. Default ${LIST_DIR_DEFAULT_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  category: 'read',
  source: { kind: 'builtin' },
  trust: 'builtin',

  async normalize(input, ctx) {
    const path = await resolveOrThrow(ctx, input.path ?? '.')
    return { input: { ...input, path: path.relative }, targets: { paths: [path.relative] } }
  },

  async execute(input, ctx) {
    const root = await resolveOrThrow(ctx, '.')
    const target = await resolveOrThrow(ctx, input.path ?? '.')
    try {
      const stat = await fs.stat(target.absolute)
      if (!stat.isDirectory()) {
        throw new ToolError(
          ListDirErrorCode.NotDirectory,
          `${target.relative} is not a directory. Use read_file to read it.`,
          { path: target.relative },
        )
      }
    } catch (error) {
      if (error instanceof ToolError) throw error
      const code =
        fsError(error) === 'ENOENT' ? ListDirErrorCode.NotFound : ListDirErrorCode.Unreadable
      throw new ToolError(
        code,
        code === ListDirErrorCode.NotFound
          ? `Directory not found: ${target.relative}`
          : `Cannot read ${target.relative} (${fsError(error) ?? 'unknown error'}).`,
        { path: target.relative },
      )
    }

    const depth = input.depth ?? LIST_DIR_DEFAULT_DEPTH
    const limit = input.limit ?? LIST_DIR_DEFAULT_LIMIT
    const prefix = target.relative === '.' ? '' : target.relative

    // 工作区根目录到目标目录之间（不含目标）的 .gitignore
    const matchers: Matcher[] = []
    const parts = prefix === '' ? [] : prefix.split('/')
    for (let i = 0; i < parts.length; i++) {
      const base = parts.slice(0, i).join('/')
      const m = await loadGitignore(nodePath.join(root.absolute, ...parts.slice(0, i)), base)
      if (m) matchers.push(m)
    }

    const lines: string[] = []
    let hidden = 0
    let truncated = false
    let tokens = 0
    const maxTokens = bodyTokens(ctx.maxOutputTokens)

    const walk = async (dir: string, relative: string, level: number, inherited: Matcher[]) => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (level === 0) throw error
        lines[lines.length - 1] += ` [unreadable: ${fsError(error) ?? 'error'}]`
        return
      }
      const own = await loadGitignore(dir, relative)
      const active = own ? [...inherited, own] : inherited
      for (const entry of entries.sort(byName)) {
        if (ctx.signal.aborted || truncated) return
        if (entry.name === '.git') continue
        const isDir = entry.isDirectory()
        const childRel = relative === '' ? entry.name : `${relative}/${entry.name}`
        if (isIgnored(active, childRel, isDir)) {
          hidden++
          continue
        }
        const mark = isDir ? '/' : entry.isSymbolicLink() ? '@' : ''
        const line = `${'  '.repeat(level)}${entry.name}${mark}`
        const cost = estimateTokens(line) + 1
        if (lines.length >= limit || (lines.length > 0 && tokens + cost > maxTokens)) {
          truncated = true
          return
        }
        tokens += cost
        lines.push(line)
        if (isDir && level + 1 < depth) {
          await walk(nodePath.join(dir, entry.name), childRel, level + 1, active)
        }
      }
    }

    try {
      await walk(target.absolute, prefix, 0, matchers)
    } catch (error) {
      throw new ToolError(
        ListDirErrorCode.Unreadable,
        `Cannot read ${target.relative} (${fsError(error) ?? 'unknown error'}).`,
        { path: target.relative },
      )
    }

    const notes: string[] = []
    if (lines.length === 0) notes.push('(empty directory)')
    if (truncated) {
      notes.push(
        `[Listing stopped at ${lines.length} entries. List a subdirectory or reduce depth to see more.]`,
      )
    }
    if (hidden > 0)
      notes.push(`[${hidden} ${hidden === 1 ? 'entry' : 'entries'} hidden by .gitignore]`)
    const header = `Directory: ${target.relative} | depth ${depth}`
    return { content: [{ type: 'text', text: [header, ...lines, ...notes].join('\n') }] }
  },
}
