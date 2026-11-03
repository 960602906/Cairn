// @ts-check
/**
 * 录制文件（cassette）：一次场景运行中按顺序发生的 HTTP 交互。
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "deepseek-tool",          // 文件名，也是黄金文件名
 *   "scenario": "openai-tool",        // scenarios.mjs 中的场景（格式、提示词、工具）
 *   "model": "deepseek-chat",         // 录制时的模型 id，回放时沿用
 *   "source": "synthetic" | "<上游地址>",
 *   "pi": { "@earendil-works/pi-ai": "1.5.0", ... },
 *   "interactions": [
 *     {
 *       "request": { "method": "POST", "path": "/v1/chat/completions", "query": {}, "headers": {...}, "body": {...} },
 *       "response": { "status": 200, "headers": { "content-type": "text/event-stream" }, "chunks": ["data: ...", ...] }
 *     }
 *   ]
 * }
 * ```
 *
 * 凭据不入文件：请求头只保留 `RECORDED_HEADERS` 中的项，查询参数中的 `key` 被替换。
 * 响应保留原始分块（按到达顺序解码为 UTF-8 字符串），回放时可以原样或重新切分。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

export const CASSETTE_VERSION = 1

/** 合成上游与回放都不校验凭据，但 pi 要求非空的 Key。 */
export const PLACEHOLDER_KEY = 'sk-contract-placeholder'

/** 录制并参与匹配的请求头；其余（含 `authorization`、`x-api-key`、`x-goog-api-key`）不记录。 */
export const RECORDED_HEADERS = ['content-type', 'anthropic-version', 'anthropic-beta']

/** 查询参数中按凭据处理的键。 */
const SECRET_QUERY_KEYS = ['key', 'api_key', 'api-key']

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} query
 * @property {Record<string, string>} headers
 * @property {unknown} body 解析后的 JSON；非 JSON 时为原始字符串
 *
 * @typedef {object} RecordedResponse
 * @property {number} status
 * @property {Record<string, string>} headers
 * @property {string[]} chunks
 *
 * @typedef {{ request: RecordedRequest, response: RecordedResponse }} Interaction
 *
 * @typedef {object} Cassette
 * @property {number} version
 * @property {string} name
 * @property {string} scenario
 * @property {string} model
 * @property {string} source
 * @property {Record<string, string>} pi
 * @property {Interaction[]} interactions
 */

/**
 * 把收到的请求转成录制格式（去掉凭据）。
 * @param {{ method?: string, url?: string, headers: import('node:http').IncomingHttpHeaders }} req
 * @param {string} raw 请求体
 * @returns {RecordedRequest}
 */
export function recordRequest(req, raw) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  /** @type {Record<string, string>} */
  const query = {}
  for (const [key, value] of url.searchParams) {
    query[key] = SECRET_QUERY_KEYS.includes(key) ? '<redacted>' : value
  }
  /** @type {Record<string, string>} */
  const headers = {}
  for (const name of RECORDED_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  /** @type {unknown} */
  let body = raw
  try {
    body = raw ? normalizeRequestBody(JSON.parse(raw)) : null
  } catch {
    // 保留原始字符串
  }
  return { method: req.method ?? 'GET', path: url.pathname, query, headers, body }
}

/**
 * pi-ai 在 Gemini 响应不带工具调用 id 时生成的 id：`<工具名>_<Date.now()>_<计数>`。
 * 对 Gemini 3 起的模型，这个 id 会出现在下一次请求的 `functionCall` / `functionResponse` 中。
 */
const GENERATED_TOOL_CALL_ID = /^(.+)_\d{13}_\d+$/

/**
 * 请求体的规范化（录制与回放比对都经过这里）：只替换 pi 生成的工具调用 id，其余字段原样保留。
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeRequestBody(value) {
  if (typeof value === 'string') return value.replace(GENERATED_TOOL_CALL_ID, '$1_<generated>')
  if (Array.isArray(value)) return value.map(normalizeRequestBody)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeRequestBody(child)]),
  )
}

/** @param {string} file @returns {Cassette} */
export function loadCassette(file) {
  const cassette = JSON.parse(readFileSync(file, 'utf8'))
  if (cassette.version !== CASSETTE_VERSION) {
    throw new Error(`${file}: unsupported cassette version ${cassette.version}`)
  }
  return cassette
}

/** @param {string} file @param {Cassette} cassette */
export function saveCassette(file, cassette) {
  writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`)
}

/**
 * 当前安装的 pi 各包（`@earendil-works/*`）版本，写入录制文件备查。包的集合随版本变化
 * （pi-schema 从 1.5.0 起才有），所以按目录列出；pi-ai 等包的 `exports` 不含 `./package.json`，
 * 直接读文件。
 */
export function installedPiVersions() {
  const scope = new URL('../node_modules/@earendil-works/', import.meta.url)
  /** @type {Record<string, string>} */
  const versions = {}
  for (const dir of readdirSync(scope).sort()) {
    const file = new URL(`${dir}/package.json`, scope)
    versions[`@earendil-works/${dir}`] = JSON.parse(readFileSync(file, 'utf8')).version
  }
  return versions
}
