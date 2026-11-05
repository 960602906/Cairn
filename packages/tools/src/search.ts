/**
 * `search`（M1-07b；架构 §9.2、§18）：用随应用打包的 ripgrep 在工作区中搜索文本。
 * 遵守 `.gitignore`（与 `list_dir` 一致：不要求 Git 仓库，不读工作区之外的规则），跳过 `.git` 与二进制文件；
 * 结果按路径排序，数量与长度受输出预算限制。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { estimateTokens, ToolError, type ToolContext, type ToolDefinition } from '@nexus/core'
import { resolveOrThrow } from './paths.js'
import { bodyTokens, READ_FILE_MAX_BYTES, READ_FILE_MAX_OUTPUT_CHARS } from './read-file.js'

export interface SearchInput {
  /** 正则表达式（ripgrep 语法）；`literal` 为 true 时按字面匹配。 */
  readonly pattern: string
  /** 搜索的目录或文件，相对工作区根目录；默认根目录。 */
  readonly path?: string
  /** 只搜索匹配此 glob 的文件，如 `*.ts`、`src/**\/*.test.ts`。 */
  readonly glob?: string
  readonly ignoreCase?: boolean
  readonly literal?: boolean
  /** 每处匹配前后显示的行数。 */
  readonly context?: number
  /** 最多返回的匹配行数。 */
  readonly limit?: number
}

export interface SearchToolOptions {
  /** ripgrep 可执行文件的路径（见 `bundledRipgrepPath`）。 */
  readonly ripgrepPath: string
  /** 超时（毫秒），超时后返回已找到的结果。默认 `SEARCH_TIMEOUT_MS`。 */
  readonly timeoutMs?: number
}

export const SearchErrorCode = {
  NotFound: 'tool.search.not_found',
  InvalidPattern: 'tool.search.invalid_pattern',
  Unavailable: 'tool.search.unavailable',
  Failed: 'tool.search.failed',
} as const

export const SEARCH_DEFAULT_LIMIT = 100
export const SEARCH_MAX_LIMIT = 1000
export const SEARCH_MAX_CONTEXT = 10
/** 单行超过此长度时截断。 */
export const SEARCH_MAX_LINE_CHARS = 500
export const SEARCH_TIMEOUT_MS = 30_000

/** ripgrep `--json` 输出中的文本：UTF-8 时为 `text`，否则为 base64 的 `bytes`。 */
interface RgData {
  readonly text?: string
  readonly bytes?: string
}

interface RgMessage {
  readonly type: string
  readonly data: {
    readonly path?: RgData
    readonly lines?: RgData
    readonly line_number?: number
  }
}

const rgText = (data: RgData | undefined) =>
  data?.text ?? (data?.bytes === undefined ? '' : Buffer.from(data.bytes, 'base64').toString())

/** 构造 ripgrep 参数。`target` 为 `.` 时不传路径，输出的路径不带 `./` 前缀。 */
export function ripgrepArgs(input: SearchInput, target: string): string[] {
  const args = [
    '--json',
    '--no-config',
    // 与 list_dir 一致：没有 .git 也应用 .gitignore；不读工作区之外与用户全局的忽略规则
    '--no-require-git',
    '--no-ignore-parent',
    '--no-ignore-global',
    '--hidden',
    '--glob=!.git',
    '--sort=path',
    // CRLF 文件中 `$` 也能匹配行尾
    '--crlf',
    `--max-filesize=${READ_FILE_MAX_BYTES}`,
    input.ignoreCase ? '--ignore-case' : '--case-sensitive',
  ]
  if (input.literal) args.push('--fixed-strings')
  if (input.context) args.push(`--context=${input.context}`)
  if (input.glob !== undefined) args.push(`--glob=${input.glob}`)
  args.push('--regexp', input.pattern)
  if (target !== '.') args.push('--', target)
  return args
}

const fsError = (error: unknown) => (error as NodeJS.ErrnoException).code

/** 创建 `search` 工具。ripgrep 的位置由宿主给出。 */
export function createSearchTool(options: SearchToolOptions): ToolDefinition<SearchInput> {
  return {
    name: 'search',
    description:
      'Search file contents in the workspace with a regular expression (ripgrep syntax). ' +
      'Returns matching lines grouped by file, with line numbers. Files ignored by .gitignore, ' +
      'the .git directory and binary files are skipped. Use path or glob to narrow the search, ' +
      'and read_file to see more of a file.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: 'Regular expression to search for (ripgrep / Rust regex syntax).',
        },
        path: {
          type: 'string',
          description:
            'Directory or file to search, relative to the workspace root. Default: the workspace root.',
        },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.test.ts".',
        },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
        literal: {
          type: 'boolean',
          description: 'Treat pattern as a literal string instead of a regular expression.',
        },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: SEARCH_MAX_CONTEXT,
          description: 'Lines of context to show before and after each match. Default 0.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: SEARCH_MAX_LIMIT,
          description: `Maximum number of matching lines. Default ${SEARCH_DEFAULT_LIMIT}.`,
        },
      },
      required: ['pattern'],
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
        await fs.stat(target.absolute)
      } catch (error) {
        if (fsError(error) === 'ENOENT') {
          throw new ToolError(SearchErrorCode.NotFound, `Path not found: ${target.relative}`, {
            path: target.relative,
          })
        }
        throw new ToolError(
          SearchErrorCode.Failed,
          `Cannot read ${target.relative} (${fsError(error) ?? 'unknown error'}).`,
          { path: target.relative },
        )
      }
      const run = await runRipgrep(options, input, root.absolute, target.relative, ctx)
      return { content: [{ type: 'text', text: formatResult(input, target.relative, run) }] }
    },
  }
}

interface RgLine {
  readonly kind: 'match' | 'context'
  readonly number: number
  readonly text: string
}

interface RgRun {
  readonly files: ReadonlyMap<string, RgLine[]>
  readonly matches: number
  /** 达到 `limit` 或输出预算后停止。 */
  readonly stopped: 'limit' | 'budget' | 'timeout' | undefined
  /** ripgrep 报告的非致命错误（如无法读取的文件），只保留第一行。 */
  readonly warning: string | undefined
}

function runRipgrep(
  options: SearchToolOptions,
  input: SearchInput,
  cwd: string,
  target: string,
  ctx: ToolContext,
): Promise<RgRun> {
  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT
  const files = new Map<string, RgLine[]>()
  let matches = 0
  let chars = 0
  let tokens = 0
  const maxTokens = bodyTokens(ctx.maxOutputTokens)
  let stopped: RgRun['stopped']
  let stderr = ''
  let pending = ''

  return new Promise((resolve, reject) => {
    const child = spawn(options.ripgrepPath, ripgrepArgs(input, target), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stop = (reason: NonNullable<RgRun['stopped']>) => {
      stopped ??= reason
      child.kill()
    }
    const onAbort = () => child.kill()
    ctx.signal.addEventListener('abort', onAbort)
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? SEARCH_TIMEOUT_MS)

    const handle = (line: string) => {
      if (stopped || line === '') return
      let message: RgMessage
      try {
        message = JSON.parse(line) as RgMessage
      } catch {
        return
      }
      if (message.type !== 'match' && message.type !== 'context') return
      if (message.type === 'match' && matches >= limit) return stop('limit')
      const path = rgText(message.data.path).replaceAll('\\', '/')
      let text = rgText(message.data.lines).replace(/\r?\n$/, '')
      if (text.length > SEARCH_MAX_LINE_CHARS) {
        text = `${text.slice(0, SEARCH_MAX_LINE_CHARS)}… [${text.length - SEARCH_MAX_LINE_CHARS} more characters]`
      }
      const lines = files.get(path)
      // 文件名、行号与缩进约占 20 个字符
      const cost = text.length + 20 + (lines ? 0 : path.length + 1)
      const tokenCost = estimateTokens(text) + 5 + (lines ? 0 : estimateTokens(path) + 1)
      // 至少返回一处匹配
      if (
        matches > 0 &&
        (chars + cost > READ_FILE_MAX_OUTPUT_CHARS || tokens + tokenCost > maxTokens)
      ) {
        return stop('budget')
      }
      chars += cost
      tokens += tokenCost
      const entry: RgLine = { kind: message.type, number: message.data.line_number ?? 0, text }
      if (lines) lines.push(entry)
      else files.set(path, [entry])
      if (message.type === 'match') matches++
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const parts = (pending + chunk).split('\n')
      pending = parts.pop()!
      for (const part of parts) handle(part)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk
    })

    const finish = () => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      finish()
      reject(
        new ToolError(
          SearchErrorCode.Unavailable,
          `Search is unavailable: ripgrep could not be started (${fsError(error) ?? error.message}).`,
        ),
      )
    })
    child.on('close', (code) => {
      finish()
      handle(pending)
      const message = stderr.trim()
      if (stopped !== undefined) trimTrailingContext(files, input.context ?? 0)
      // 路径与 glob 过滤后没有可搜索的文件：按无匹配处理
      const noFiles = /No files were searched/.test(message)
      // 退出码：0 有匹配，1 无匹配，2 出错（可能同时有匹配）；被我们停止时忽略
      if (stopped === undefined && code === 2 && matches === 0 && !noFiles) {
        const invalid = /regex parse error|error parsing glob|unrecognized|invalid/i.test(message)
        reject(
          new ToolError(
            invalid ? SearchErrorCode.InvalidPattern : SearchErrorCode.Failed,
            invalid
              ? `Invalid search pattern or glob:\n${message}`
              : `Search failed: ${message || `ripgrep exited with code ${code}`}`,
          ),
        )
        return
      }
      resolve({
        files,
        matches,
        stopped,
        warning: code === 2 && message !== '' && !noFiles ? message.split(/\r?\n/)[0] : undefined,
      })
    })
  })
}

/**
 * 提前停止时，最后一个文件末尾可能有下一处（未显示的）匹配的前置上下文：只保留紧接最后一处匹配的后置上下文。
 */
function trimTrailingContext(files: Map<string, RgLine[]>, context: number): void {
  const entries = [...files.values()].at(-1)
  if (!entries) return
  const last = entries.findLastIndex((e) => e.kind === 'match')
  if (last < 0) return
  let keep = last + 1
  while (
    keep < entries.length &&
    entries[keep]!.number === entries[keep - 1]!.number + 1 &&
    entries[keep]!.number - entries[last]!.number <= context
  ) {
    keep++
  }
  entries.length = keep
}

function formatResult(input: SearchInput, target: string, run: RgRun): string {
  const where = `${JSON.stringify(input.pattern)} in ${target}${input.glob === undefined ? '' : ` (glob ${JSON.stringify(input.glob)})`}`
  if (run.matches === 0) {
    const notes = [`Search: ${where} | no matches`]
    if (run.stopped === 'timeout') notes.push('[The search timed out before it finished.]')
    if (run.warning) notes.push(`[Some files could not be searched: ${run.warning}]`)
    return notes.join('\n')
  }
  // 只有上下文、没有匹配的文件（停止时可能出现）不显示
  const files = [...run.files].filter(([, entries]) => entries.some((e) => e.kind === 'match'))
  const lines = [
    `Search: ${where} | ${run.matches} matching ${run.matches === 1 ? 'line' : 'lines'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`,
  ]
  for (const [path, entries] of files) {
    lines.push(path)
    let previous: number | undefined
    for (const e of entries) {
      if (previous !== undefined && e.number > previous + 1) lines.push('  --')
      lines.push(`  ${e.number}${e.kind === 'match' ? ':' : '-'} ${e.text}`)
      previous = e.number
    }
  }
  if (run.stopped === 'limit') {
    lines.push(
      `[Stopped at ${run.matches} matching lines (limit). Narrow the search with path, glob or a more specific pattern.]`,
    )
  } else if (run.stopped === 'budget') {
    lines.push(
      `[Stopped at ${run.matches} matching lines (output size limit). Narrow the search with path, glob or a more specific pattern.]`,
    )
  } else if (run.stopped === 'timeout') {
    lines.push('[The search timed out; results are incomplete.]')
  }
  if (run.warning) lines.push(`[Some files could not be searched: ${run.warning}]`)
  return lines.join('\n')
}
