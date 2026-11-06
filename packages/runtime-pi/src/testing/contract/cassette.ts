/**
 * 录制文件（cassette）：一次场景运行中按顺序发生的 HTTP 交互（M1-02a，由 S8 移入）。
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "ds-openai-tool",          // 文件名，也是黄金文件名
 *   "scenario": "openai-tool",         // scenarios.ts 中的场景（格式、提示词、工具）
 *   "model": "deepseek-flash",         // 录制时的模型 id，回放时沿用
 *   "reasoning": true,                 // 模型是否按支持推理配置（决定 pi 的思考等级）
 *   "source": "synthetic" | "<上游地址>",
 *   "pi": "1.5.0",
 *   "interactions": [
 *     {
 *       "request": { "method": "POST", "path": "/v1/chat/completions", "query": {}, "headers": {...}, "body": {...} },
 *       "response": { "status": 200, "headers": { "content-type": "text/event-stream" }, "chunks": ["data: ...", ...] }
 *     }
 *   ]
 * }
 * ```
 *
 * 凭据不入文件：请求头只保留 `RECORDED_HEADERS` 中的项，查询参数中的 `key` 等被替换。
 * 响应保留原始分块（按到达顺序解码为 UTF-8 字符串），回放时可以原样或重新切分。
 */
import type { IncomingHttpHeaders } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'

export const CASSETTE_VERSION = 1

/** 合成上游与回放都不校验凭据，但 pi 要求非空的 Key。 */
export const PLACEHOLDER_KEY = 'contract-placeholder-key'

/** 录制并参与匹配的请求头；其余（含 `authorization`、`x-api-key`、`x-goog-api-key`）不记录。 */
export const RECORDED_HEADERS = ['content-type', 'anthropic-version', 'anthropic-beta'] as const

/** 查询参数中按凭据处理的键。 */
const SECRET_QUERY_KEYS = new Set(['key', 'api_key', 'api-key'])

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
  /** 解析并规范化后的 JSON；不是 JSON 时为原始字符串，没有请求体时为 null。 */
  readonly body: unknown
}

export interface RecordedResponse {
  status: number
  headers: Record<string, string>
  chunks: string[]
}

export interface Interaction {
  readonly request: RecordedRequest
  readonly response: RecordedResponse
}

export interface Cassette {
  readonly version: number
  readonly name: string
  readonly scenario: string
  readonly model: string
  readonly reasoning: boolean
  readonly source: string
  readonly pi: string
  readonly interactions: readonly Interaction[]
}

/** 把收到的请求转成录制格式（去掉凭据，规范化请求体）。 */
export function recordRequest(
  req: {
    readonly method?: string | undefined
    readonly url?: string | undefined
    readonly headers: IncomingHttpHeaders
  },
  raw: string,
): RecordedRequest {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    query[key] = SECRET_QUERY_KEYS.has(key) ? '<redacted>' : value
  }
  const headers: Record<string, string> = {}
  for (const name of RECORDED_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  let body: unknown = null
  if (raw !== '') {
    try {
      body = normalizeRequestBody(JSON.parse(raw))
    } catch {
      body = raw
    }
  }
  return { method: req.method ?? 'GET', path: url.pathname, query, headers, body }
}

/**
 * 每次运行都会变的字符串：
 * - pi-ai 在 Gemini 响应不带工具调用 id 时生成的 id：`<工具名>_<Date.now()>_<计数>`。对 Gemini 3 起的模型，
 *   这个 id 会出现在下一次请求的 `functionCall` / `functionResponse` 中；
 * - 会话 id `cairn-<n>`（进程内计数）：pi 对部分服务（如 api.openai.com）作为 `prompt_cache_key` 发送。
 */
const VOLATILE_STRINGS: readonly [RegExp, string][] = [
  [/^(.+)_\d{13}_\d+$/, '$1_<generated>'],
  [/^cairn-\d+$/, 'cairn-<session>'],
]

/** 请求体的规范化（录制与回放比对都经过这里）：只替换每次运行都会变的字符串，其余原样保留。 */
export function normalizeRequestBody(value: unknown): unknown {
  if (typeof value === 'string') {
    return VOLATILE_STRINGS.reduce(
      (s, [pattern, replacement]) => s.replace(pattern, replacement),
      value,
    )
  }
  if (Array.isArray(value)) return value.map(normalizeRequestBody)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeRequestBody(child)]),
  )
}

export function loadCassette(file: string): Cassette {
  const cassette = JSON.parse(readFileSync(file, 'utf8')) as Cassette
  if (cassette.version !== CASSETTE_VERSION) {
    throw new Error(`${file}: unsupported cassette version ${cassette.version}`)
  }
  return cassette
}

export function serializeCassette(cassette: Cassette): string {
  return `${JSON.stringify(cassette, null, 2)}\n`
}

export function saveCassette(file: string, cassette: Cassette): void {
  writeFileSync(file, serializeCassette(cassette))
}

/** 录制文件中疑似 Key 的内容（真实服务的 Key 不应出现在录制中）。 */
export const KEY_LIKE = /\bsk-[A-Za-z0-9_-]{16,}|\bAIza[A-Za-z0-9_-]{35}/
