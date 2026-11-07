/**
 * 供应商的连接测试与模型列表（M2-10，架构 §12 的“能力探测”起点）。只由主进程发出请求。
 *
 * - `provider.test`：用 `runtime-pi` 的 `probeModel` 按会话相同的模型定义（地址、兼容参数）发一次最小的请求，
 *   返回耗时或错误码。配置可以是界面上还没保存的；Key 用界面新填的，否则用凭据引用中保存的。
 * - `provider.models`：按接口格式拉取模型列表（与 pi 使用的 SDK 一致的地址规则）：
 *   - openai：`GET {baseUrl}/models`，`Authorization: Bearer`；
 *   - anthropic：`GET {baseUrl}/v1/models`，`x-api-key` 与 `anthropic-version`；
 *   - gemini：`GET {baseUrl}/models`（地址已含版本），`x-goog-api-key`；只保留支持 `generateContent` 的模型。
 *   失败时返回错误码（HTTP 状态归类同 `runtime-pi`），界面允许手动填写模型。
 *
 * 响应中的文字不返回界面、不写日志（可能含提供方返回的内容）。
 */
import {
  hostModelConfig,
  resolveModel,
  type CredentialProvider,
  type ResolvedModel,
} from '@cairn/core'
import type { ErrorInfo, MainForRenderer, ProviderConfig, RemoteModel } from '@cairn/protocol'
import type { z } from 'zod'

type Requests = (typeof MainForRenderer)['requests']
type TestResult = z.input<Requests['provider.test']['result']>
type ModelsResult = z.input<Requests['provider.models']['result']>

export const ProviderErrorCode = {
  /** 模型不在这份配置中。 */
  UnknownModel: 'session.unknown_model',
  /** 响应不是预期的格式。 */
  InvalidResponse: 'provider.invalid_response',
  AuthFailed: 'model.auth_failed',
  RateLimited: 'model.rate_limited',
  ServerError: 'model.server_error',
  BadRequest: 'model.bad_request',
  NetworkError: 'model.network_error',
} as const

export type Probe = (
  resolved: ResolvedModel,
  options: { readonly signal?: AbortSignal },
) => Promise<{ ok: true; latencyMs: number } | { ok: false; latencyMs: number; error: ErrorInfo }>

export interface ProviderServiceOptions {
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  /** 测试用：替换连接测试（默认按需加载 `runtime-pi` 的 `probeModel`）。 */
  readonly probe?: Probe
  /** 测试用：替换 `fetch`。 */
  readonly fetch?: typeof fetch
  /** 单次请求的时限，默认 30 秒。 */
  readonly timeoutMs?: number
}

export interface ProviderService {
  test(params: z.output<Requests['provider.test']['params']>): Promise<TestResult>
  models(params: z.output<Requests['provider.models']['params']>): Promise<ModelsResult>
}

const defaultProbe: Probe = async (resolved, options) => {
  const { probeModel } = await import('@cairn/runtime-pi')
  return probeModel(resolved, options)
}

/** HTTP 状态 → 错误码（与 `runtime-pi` 的归类一致）。 */
export function errorForStatus(status: number): ErrorInfo {
  const code =
    status === 401 || status === 403
      ? ProviderErrorCode.AuthFailed
      : status === 429
        ? ProviderErrorCode.RateLimited
        : status >= 500
          ? ProviderErrorCode.ServerError
          : ProviderErrorCode.BadRequest
  return { code, params: { status } }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, 256) : undefined

/** 各接口格式的列表请求。 */
function listRequest(provider: ProviderConfig, apiKey: string | undefined) {
  const base = trimSlash(provider.baseUrl)
  switch (provider.kind) {
    case 'anthropic':
      return {
        url: `${base}/v1/models?limit=1000`,
        headers: {
          'anthropic-version': '2023-06-01',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
      }
    case 'gemini':
      return {
        url: `${base}/models?pageSize=1000`,
        headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
      }
    default:
      return {
        url: `${base}/models`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      }
  }
}

/** 解析列表响应；格式不对时为 undefined。 */
export function parseModels(
  kind: ProviderConfig['kind'],
  body: unknown,
): RemoteModel[] | undefined {
  if (!isRecord(body)) return undefined
  const items = kind === 'gemini' ? body['models'] : body['data']
  if (!Array.isArray(items)) return undefined
  const models: RemoteModel[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!isRecord(item)) continue
    let id: string | undefined
    let model: RemoteModel | undefined
    if (kind === 'gemini') {
      const methods = item['supportedGenerationMethods']
      if (Array.isArray(methods) && !methods.includes('generateContent')) continue
      id = text(item['name'])?.replace(/^models\//, '')
      if (!id) continue
      const displayName = text(item['displayName'])
      const contextWindow = positive(item['inputTokenLimit'])
      const maxOutputTokens = positive(item['outputTokenLimit'])
      model = {
        id,
        ...(displayName ? { displayName } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      }
    } else {
      id = text(item['id'])
      if (!id) continue
      const displayName = text(item['display_name'])
      model = { id, ...(displayName ? { displayName } : {}) }
    }
    if (seen.has(id)) continue
    seen.add(id)
    models.push(model)
    if (models.length === 1000) break
  }
  return models
}

export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const probe = options.probe ?? defaultProbe
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  const keyFor = async (provider: ProviderConfig, secret: string | undefined) => {
    if (secret !== undefined) return secret.trim()
    if (provider.credentialRef === undefined) return undefined
    return (await options.credentials.resolve(provider.credentialRef))?.apiKey
  }

  return {
    async test({ provider, modelId, secret }) {
      const config = hostModelConfig(provider, modelId)
      if (!config) {
        return { ok: false, error: { code: ProviderErrorCode.UnknownModel, params: { modelId } } }
      }
      const apiKey = await keyFor(provider, secret)
      const resolved = resolveModel({ providerId: provider.id, modelId }, config, apiKey)
      const result = await probe(resolved, { signal: AbortSignal.timeout(timeoutMs) })
      return result
    },

    async models({ provider, secret }) {
      const apiKey = await keyFor(provider, secret)
      const { url, headers } = listRequest(provider, apiKey)
      let response: Response
      try {
        response = await doFetch(url, {
          headers: { accept: 'application/json', ...headers },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        return { ok: false, error: { code: ProviderErrorCode.NetworkError } }
      }
      if (!response.ok) return { ok: false, error: errorForStatus(response.status) }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, error: { code: ProviderErrorCode.InvalidResponse } }
      }
      const models = parseModels(provider.kind, body)
      if (!models) return { ok: false, error: { code: ProviderErrorCode.InvalidResponse } }
      return { ok: true, models }
    },
  }
}
