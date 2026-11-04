/**
 * `read_file`（M1-07a；架构 §9.2、§18）：按行范围读取文本文件，大文件分段；识别 BOM 与编码；二进制文件只给出提示。
 */
import fs from 'node:fs/promises'
import { ToolError, type ToolDefinition } from '@nexus/core'
import { resolveOrThrow } from './paths.js'

export interface ReadFileInput {
  readonly path: string
  /** 从第几行开始（1 起）。 */
  readonly offset?: number
  /** 最多读取的行数。 */
  readonly limit?: number
}

export const ReadFileErrorCode = {
  NotFound: 'tool.read_file.not_found',
  IsDirectory: 'tool.read_file.is_directory',
  TooLarge: 'tool.read_file.too_large',
  OffsetOutOfRange: 'tool.read_file.offset_out_of_range',
  Unreadable: 'tool.read_file.unreadable',
} as const

/** 默认与最大的行数。 */
export const READ_FILE_DEFAULT_LIMIT = 2000
/** 单行超过此长度时截断。 */
export const READ_FILE_MAX_LINE_CHARS = 2000
/** 一次返回的字符数上限（在流水线的输出预算之内，避免中间被截断）。 */
export const READ_FILE_MAX_OUTPUT_CHARS = 25_000
/** 可读取的文件大小上限。 */
export const READ_FILE_MAX_BYTES = 10 * 1024 * 1024
/** 检测二进制时检查的字节数。 */
const BINARY_SNIFF_BYTES = 8000

type Encoding = 'UTF-8' | 'UTF-8 with BOM' | 'UTF-16 LE' | 'UTF-16 BE'

type Decoded =
  | { readonly binary: true }
  | {
      readonly binary: false
      readonly text: string
      readonly encoding: Encoding
      /** 不是合法的 UTF-8，非法字节已替换为 U+FFFD。 */
      readonly lossy: boolean
    }

export function decodeFile(buffer: Uint8Array): Decoded {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => buffer[i] === b)
  if (startsWith(0xef, 0xbb, 0xbf)) {
    return decodeUtf8(buffer.subarray(3), 'UTF-8 with BOM')
  }
  if (startsWith(0xff, 0xfe)) {
    return {
      binary: false,
      text: new TextDecoder('utf-16le').decode(buffer.subarray(2)),
      encoding: 'UTF-16 LE',
      lossy: false,
    }
  }
  if (startsWith(0xfe, 0xff)) {
    return {
      binary: false,
      text: new TextDecoder('utf-16be').decode(buffer.subarray(2)),
      encoding: 'UTF-16 BE',
      lossy: false,
    }
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { binary: true }
  return decodeUtf8(buffer, 'UTF-8')
}

function decodeUtf8(bytes: Uint8Array, encoding: Encoding): Decoded {
  try {
    return {
      binary: false,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding,
      lossy: false,
    }
  } catch {
    return { binary: false, text: new TextDecoder('utf-8').decode(bytes), encoding, lossy: true }
  }
}

/** 按 CRLF、LF、CR 分行；末尾的换行不产生空行。 */
export function splitLines(text: string): {
  lines: string[]
  lineEndings: 'LF' | 'CRLF' | 'CR' | 'mixed' | undefined
} {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  const cr = (text.match(/\r/g)?.length ?? 0) - crlf
  const kinds = [crlf > 0 && 'CRLF', lf > 0 && 'LF', cr > 0 && 'CR'].filter(Boolean) as (
    'LF' | 'CRLF' | 'CR'
  )[]
  const lines = text === '' ? [] : text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return { lines, lineEndings: kinds.length > 1 ? 'mixed' : kinds[0] }
}

const fsError = (error: unknown) => (error as NodeJS.ErrnoException).code

export const readFileTool: ToolDefinition<ReadFileInput> = {
  name: 'read_file',
  description:
    'Read a text file in the workspace. Returns numbered lines. Large files are returned in parts: ' +
    'use offset and limit to read a specific range, and follow the hint at the end to continue. ' +
    'Binary files are not shown.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      offset: {
        type: 'integer',
        minimum: 1,
        description: 'First line to read (1-based). Default 1.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: READ_FILE_DEFAULT_LIMIT,
        description: `Maximum number of lines to read. Default ${READ_FILE_DEFAULT_LIMIT}.`,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  category: 'read',
  source: { kind: 'builtin' },
  trust: 'builtin',

  async normalize(input, ctx) {
    const path = await resolveOrThrow(ctx, input.path)
    return { input: { ...input, path: path.relative }, targets: { paths: [path.relative] } }
  },

  async execute(input, ctx) {
    const path = await resolveOrThrow(ctx, input.path)
    let buffer: Buffer
    try {
      const stat = await fs.stat(path.absolute)
      if (stat.isDirectory()) {
        throw new ToolError(
          ReadFileErrorCode.IsDirectory,
          `${path.relative} is a directory. Use list_dir to see its contents.`,
          { path: path.relative },
        )
      }
      if (stat.size > READ_FILE_MAX_BYTES) {
        throw new ToolError(
          ReadFileErrorCode.TooLarge,
          `${path.relative} is too large to read (${stat.size} bytes, limit ${READ_FILE_MAX_BYTES}). Use search to find the relevant part.`,
          { path: path.relative, size: stat.size },
        )
      }
      buffer = await fs.readFile(path.absolute)
    } catch (error) {
      if (error instanceof ToolError) throw error
      if (fsError(error) === 'ENOENT') {
        throw new ToolError(ReadFileErrorCode.NotFound, `File not found: ${path.relative}`, {
          path: path.relative,
        })
      }
      throw new ToolError(
        ReadFileErrorCode.Unreadable,
        `Cannot read ${path.relative} (${fsError(error) ?? 'unknown error'}).`,
        { path: path.relative },
      )
    }

    const decoded = decodeFile(buffer)
    if (decoded.binary) {
      return {
        content: [
          {
            type: 'text',
            text: `File: ${path.relative} | binary file, ${buffer.length} bytes, not shown.`,
          },
        ],
      }
    }
    const { lines, lineEndings } = splitLines(decoded.text)
    const format = [decoded.encoding, lineEndings].filter(Boolean).join(' | ')
    if (lines.length === 0) {
      return { content: [{ type: 'text', text: `File: ${path.relative} | empty | ${format}` }] }
    }

    const offset = input.offset ?? 1
    if (offset > lines.length) {
      throw new ToolError(
        ReadFileErrorCode.OffsetOutOfRange,
        `offset ${offset} is beyond the end of ${path.relative} (${lines.length} lines).`,
        { path: path.relative, offset, lines: lines.length },
      )
    }
    const limit = Math.min(input.limit ?? READ_FILE_DEFAULT_LIMIT, READ_FILE_DEFAULT_LIMIT)
    const width = String(Math.min(lines.length, offset + limit - 1)).length
    const body: string[] = []
    let chars = 0
    let last = offset - 1
    for (let n = offset; n <= lines.length && n < offset + limit; n++) {
      let line = lines[n - 1]!
      if (line.length > READ_FILE_MAX_LINE_CHARS) {
        line = `${line.slice(0, READ_FILE_MAX_LINE_CHARS)}… [line truncated, ${line.length - READ_FILE_MAX_LINE_CHARS} more characters]`
      }
      // 空行只显示行号（不留行尾的制表符）
      const entry =
        line === '' ? String(n).padStart(width) : `${String(n).padStart(width)}\t${line}`
      // 至少返回一行
      if (body.length > 0 && chars + entry.length + 1 > READ_FILE_MAX_OUTPUT_CHARS) break
      body.push(entry)
      chars += entry.length + 1
      last = n
    }

    const notes: string[] = []
    if (decoded.lossy)
      notes.push('[The file is not valid UTF-8. Invalid bytes are shown as U+FFFD.]')
    if (last < lines.length) {
      notes.push(
        `[Showing lines ${offset}-${last} of ${lines.length}. Call read_file with offset=${last + 1} to continue.]`,
      )
    }
    const header = `File: ${path.relative} | lines ${offset}-${last} of ${lines.length} | ${format}`
    return { content: [{ type: 'text', text: [header, ...body, ...notes].join('\n') }] }
  },
}
