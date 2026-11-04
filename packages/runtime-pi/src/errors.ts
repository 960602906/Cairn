/**
 * pi 的失败消息 → `ErrorInfo`（错误码由界面翻译，ADR-0009、ADR-0013）。
 *
 * pi 把请求失败编码为 `stopReason: 'error'` 的助手消息，原因只在 `errorMessage` 文本中
 * （各家 SDK 的格式不同，HTTP 状态通常出现在文本开头，如 `401 ...`、`429: {...}`；Gemini 只有响应体，
 * 状态在 `error.code` 中，Key 无效时返回 400 并带 `API_KEY_INVALID`，见 S8 观察 5 与 M1-02a）。
 * 这里按状态码与 pi 自己的分类函数归类；是否可重试以 pi 的判断为准，并把 429、5xx 视为可重试。
 * 原始文本不放进 `ErrorInfo`（可能含提供方返回的内容），需要时由 M1-14 写入日志。
 */
import type { ErrorInfo } from '@nexus/protocol'
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from '@earendil-works/pi-ai'

export const PiErrorCode = {
  /** 401、403：Key 无效或没有权限。 */
  AuthFailed: 'model.auth_failed',
  RateLimited: 'model.rate_limited',
  /** 5xx。 */
  ServerError: 'model.server_error',
  /** 上下文超出模型限制。 */
  ContextOverflow: 'model.context_overflow',
  /** 其他 4xx：请求被拒绝（参数、模型名等）。 */
  BadRequest: 'model.bad_request',
  /** 没有 HTTP 状态的临时失败：连接失败、超时、流中断等。 */
  NetworkError: 'model.network_error',
  Unknown: 'model.unknown_error',
} as const

export interface PiFailure {
  readonly error: ErrorInfo
  readonly retryable: boolean
}

const STATUS = /(?:^|[^\d.])([45]\d\d)(?!\d)/

/** Gemini 的错误文本是响应体：`{"error":{"code":400,"status":"INVALID_ARGUMENT",...}}`。 */
function bodyStatusOf(text: string): number | undefined {
  try {
    const code: unknown = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code
    return typeof code === 'number' && code >= 400 && code < 600 ? code : undefined
  } catch {
    return undefined
  }
}

export function httpStatusOf(text: string): number | undefined {
  const fromBody = bodyStatusOf(text)
  if (fromBody !== undefined) return fromBody
  const match = STATUS.exec(text)
  return match?.[1] ? Number(match[1]) : undefined
}

/** Gemini 对无效的 Key 返回 400，原因在 `details[].reason` 中。 */
const INVALID_KEY = /\bAPI_KEY_INVALID\b/

export function toFailure(message: AssistantMessage, contextWindow?: number): PiFailure {
  const text = message.errorMessage ?? ''
  const status = httpStatusOf(text)
  const piRetryable = isRetryableAssistantError(message)
  const params = status !== undefined ? { status } : undefined
  const failure = (code: string, retryable: boolean): PiFailure => ({
    error: params ? { code, params } : { code },
    retryable,
  })
  if (isContextOverflow(message, contextWindow)) return failure(PiErrorCode.ContextOverflow, false)
  if (status === 401 || status === 403 || INVALID_KEY.test(text))
    return failure(PiErrorCode.AuthFailed, false)
  if (status === 429) return failure(PiErrorCode.RateLimited, true)
  if (status !== undefined && status >= 500) return failure(PiErrorCode.ServerError, true)
  if (status !== undefined) return failure(PiErrorCode.BadRequest, piRetryable)
  if (piRetryable) return failure(PiErrorCode.NetworkError, true)
  return failure(PiErrorCode.Unknown, false)
}
