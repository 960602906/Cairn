/**
 * 统一脱敏（架构 §20、§19 "日志自动脱敏"）。日志、诊断包与错误上报在写出前都经过这里。
 *
 * 处理：
 * - 已知密钥原文（如用户配置的 API Key）；
 * - 常见密钥格式：`sk-…`（OpenAI / DeepSeek / Anthropic）、Google `AIza…`、GitHub 令牌、
 *   AWS Access Key、Slack 令牌、JWT；
 * - `Authorization` 等请求头中的 `Bearer` / `Basic` 凭据；
 * - URL 查询参数与 `key=value` 文本中的令牌、密钥、密码；
 * - 对象中名称敏感的字段（`apiKey`、`authorization`、`password` 等）整体替换；
 * - 用户主目录路径替换为 `~`（Windows 与 POSIX）。
 *
 * 纯函数，不依赖 Node：主目录由调用方传入（主进程用 `os.homedir()`）。
 */

export const REDACTED = '[REDACTED]'

export interface RedactOptions {
  /** 当前用户的主目录，如 `C:\Users\lan`、`/home/lan`。替换为 `~`。 */
  readonly homeDirs?: readonly string[]
  /** 需要按原文替换的密钥（如已配置的 API Key）。少于 8 个字符的忽略，避免误伤普通文本。 */
  readonly secrets?: readonly string[]
}

export type Redactor = <T>(value: T) => T

const MIN_SECRET_LENGTH = 8

/** 常见密钥格式。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI、DeepSeek、Anthropic（sk-ant-…）、OpenRouter（sk-or-…）等
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Google API Key
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // GitHub 令牌
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // AWS Access Key ID
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** `Bearer xxx`、`Basic xxx`（可能出现在请求头、curl 命令、错误信息中）。 */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** 文本中表示凭据的名称（`name=value`、`name: value`）。 */
const SECRET_NAME =
  '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|x-api-key|x-goog-api-key)'

/** URL 查询参数：`?token=…`、`&api_key=…`、`?key=…`（Google 风格）、`&sig=…`。 */
const QUERY_PARAM = new RegExp(`([?&#](?:${SECRET_NAME}|key|sig|signature)=)[^&#\\s"'<>]+`, 'gi')

/** `password=…`、`"api_key": "…"`、`secret: …` 等。值为引号包围时替换引号内的内容。 */
const KEY_VALUE = new RegExp(
  `((?:^|[\\s{,;(])["']?${SECRET_NAME}["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s"',;&}]+)`,
  'gim',
)

/** 对象中的敏感字段名：值为字符串时整体替换。 */
const SENSITIVE_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|private[_-]?key|api[_-]?key|apikey|x-api-key|x-goog-api-key|token)$|(?:token|secret|password|api[_-]?key)$/i

/** 通用主目录：`C:\Users\<名称>`（任意盘符与分隔符）与 `/home/<名称>`、`/Users/<名称>`。 */
const WINDOWS_HOME = /(?<![\w.])[A-Za-z]:(?:\\\\|[\\/])+Users(?:\\\\|[\\/])+[^\\/\s"'<>|:*?]+/gi
const POSIX_HOME = /(?<![\w.:/~-])\/(?:home|Users)\/[^/\s"'<>:]+/g

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 某个主目录在文本中的几种写法：原样、分隔符互换、JSON 转义后的反斜杠。 */
function homeDirPattern(dir: string): RegExp | undefined {
  const trimmed = dir.replace(/[\\/]+$/, '')
  if (trimmed.length < 2) return undefined
  const parts = trimmed.split(/[\\/]+/).map(escapeRegExp)
  const windows = /^[A-Za-z]:/.test(trimmed)
  const body = parts.join(String.raw`(?:\\\\|[\\/])+`)
  // 后面必须是分隔符、结尾或非路径字符，避免 /home/lan 匹配 /home/lanx
  return new RegExp(`${body}(?![\\w.-])`, windows ? 'gi' : 'g')
}

function redactQuotedValue(match: string, prefix: string): string {
  const value = match.slice(prefix.length)
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
  return `${prefix}${quote}${REDACTED}${quote}`
}

export function createRedactor(options: RedactOptions = {}): Redactor {
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    // 长的先替换，避免一个密钥是另一个的前缀时只替换一部分
    .sort((a, b) => b.length - a.length)
  const homes = (options.homeDirs ?? [])
    .map(homeDirPattern)
    .filter((p): p is RegExp => p !== undefined)

  const redactString = (input: string): string => {
    let text = input
    for (const secret of secrets) text = text.split(secret).join(REDACTED)
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, REDACTED)
    text = text.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    text = text.replace(QUERY_PARAM, `$1${REDACTED}`)
    text = text.replace(KEY_VALUE, (match, prefix: string) => redactQuotedValue(match, prefix))
    for (const home of homes) text = text.replace(home, '~')
    text = text.replace(WINDOWS_HOME, '~')
    text = text.replace(POSIX_HOME, '~')
    return text
  }

  const walk = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (typeof value !== 'object' || value === null) return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, seen))
      if (value instanceof Error) {
        return {
          name: value.name,
          message: redactString(value.message),
          ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
          ...(value.cause === undefined ? {} : { cause: walk(value.cause, seen) }),
        }
      }
      const proto: unknown = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return value
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        out[key] = SENSITIVE_KEY.test(key) && typeof item === 'string' ? REDACTED : walk(item, seen)
      }
      return out
    } finally {
      seen.delete(value)
    }
  }

  return <T>(value: T): T => walk(value, new WeakSet()) as T
}

/** 使用默认规则（不含已知密钥与指定主目录）脱敏。 */
export function redact<T>(value: T, options?: RedactOptions): T {
  return createRedactor(options)(value)
}
