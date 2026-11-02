/**
 * 结构化日志（架构 §20）：JSON 行，每个进程一个文件，按大小轮转，写出前统一脱敏。
 *
 * 文件系统操作通过 `LogFileSystem` 注入：主进程与宿主传入基于 `node:fs` 的实现，测试用内存实现。
 * core 不依赖 Node。写入是同步的（日志量小，保证崩溃前的记录已落盘）；写入失败不会抛给调用方。
 */
import { createRedactor, type Redactor } from './redact.js'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** 解析配置或环境变量中的日志级别（不区分大小写），无效时返回 `fallback`。 */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const normalized = value?.trim().toLowerCase()
  return isLogLevel(normalized) ? normalized : fallback
}

/** 日志器需要的文件系统操作（同步）。 */
export interface LogFileSystem {
  appendFile(path: string, data: string): void
  /** 文件大小（字节）；文件不存在时为 0。 */
  fileSize(path: string): number
  /** 覆盖目标文件；源文件不存在时什么都不做。 */
  rename(from: string, to: string): void
  /** 文件不存在时什么都不做。 */
  remove(path: string): void
}

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  readonly level: LogLevel
  setLevel(level: LogLevel): void
  isEnabled(level: LogLevel): boolean
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** 带固定字段（如 `sessionId`）的子日志器，与父日志器共用文件与级别。 */
  child(bindings: LogFields): Logger
}

export interface LoggerOptions {
  /** 进程名，如 `main`、`host`、`renderer`；决定文件名 `<进程名>.log`。 */
  readonly processName: string
  /** 日志目录（架构 §14.1）。 */
  readonly dir: string
  readonly fs: LogFileSystem
  readonly level?: LogLevel
  /** 单个文件的上限，默认 5 MiB。超过时轮转。 */
  readonly maxBytes?: number
  /** 保留的历史文件数（`.1` … `.n`），默认 3。 */
  readonly maxFiles?: number
  /** 默认使用不含已知密钥与主目录的规则；主进程应传入带主目录与已配置密钥的脱敏函数。 */
  readonly redact?: Redactor
  readonly now?: () => number
  /** 写入失败时调用（默认忽略）。日志不能让业务失败。 */
  readonly onWriteError?: (error: unknown) => void
}

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_LOG_MAX_FILES = 3

/** 日志文件路径。目录用 `/` 连接，Windows 同样接受。 */
export function logFilePath(dir: string, processName: string): string {
  const base = dir.replace(/[\\/]+$/, '')
  return `${base}/${processName}.log`
}

/** UTF-8 字节数（不依赖 Buffer / TextEncoder）。 */
function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export function createLogger(options: LoggerOptions): Logger {
  const file = logFilePath(options.dir, options.processName)
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES
  const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_LOG_MAX_FILES)
  const redact = options.redact ?? createRedactor()
  const now = options.now ?? Date.now
  const { fs } = options
  const state = { level: options.level ?? ('info' as LogLevel), size: -1 }

  const rotate = (): void => {
    if (maxFiles === 0) {
      fs.remove(file)
    } else {
      fs.remove(`${file}.${maxFiles}`)
      for (let i = maxFiles - 1; i >= 1; i--) fs.rename(`${file}.${i}`, `${file}.${i + 1}`)
      fs.rename(file, `${file}.1`)
    }
    state.size = 0
  }

  const write = (
    level: LogLevel,
    message: string,
    bindings: LogFields,
    fields: LogFields | undefined,
  ): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return
    try {
      const base = {
        ts: new Date(now()).toISOString(),
        level,
        proc: options.processName,
        msg: message,
      }
      // 固定字段排在最前，且不能被调用方字段覆盖
      const record = redact({ ...base, ...bindings, ...fields, ...base })
      const line = `${JSON.stringify(record)}\n`
      const bytes = utf8Length(line)
      if (state.size < 0) state.size = fs.fileSize(file)
      // 空文件时即使一行超过上限也直接写入，避免无限轮转
      if (state.size > 0 && state.size + bytes > maxBytes) rotate()
      fs.appendFile(file, line)
      state.size += bytes
    } catch (error) {
      // 下次写入前重新读取文件大小
      state.size = -1
      options.onWriteError?.(error)
    }
  }

  const make = (bindings: LogFields): Logger => ({
    get level() {
      return state.level
    },
    setLevel(level) {
      state.level = level
    },
    isEnabled: (level) => LEVEL_RANK[level] >= LEVEL_RANK[state.level],
    debug: (message, fields) => write('debug', message, bindings, fields),
    info: (message, fields) => write('info', message, bindings, fields),
    warn: (message, fields) => write('warn', message, bindings, fields),
    error: (message, fields) => write('error', message, bindings, fields),
    child: (more) => make({ ...bindings, ...more }),
  })

  return make({})
}
