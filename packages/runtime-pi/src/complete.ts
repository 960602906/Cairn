/**
 * 一次性、不带工具的补全（M3-01）。标题、会话要点、压缩摘要都走这里，不进入 Agent 循环。
 *
 * - 思考型模型的推理内容丢弃，只返回正文。
 * - pi 的 SDK 重试关闭。失败时按 Runtime §10.4：网络错误、429、5xx 可重试，401、403、其他 4xx、
 *   上下文超限不重试；指数退避，默认最多 3 次。这里不发 `model.retry`（不属于某一轮的模型步骤）。
 * - 中止（`signal`）立即停止，不再重试。
 */
import type { RetryPolicy, ResolvedModel } from '@cairn/core'
import { DEFAULT_RETRY_POLICY, retryDelay } from '@cairn/core'
import type { CanonicalMessage, TokenUsage } from '@cairn/protocol'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { PiErrorCode, toFailure } from './errors.js'
import { fromPiAssistant, fromPiUsage, toPiMessages, type PiModelIdentity } from './messages.js'
import { bindModel } from './model.js'

export interface CompleteMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface CompleteRequest {
  readonly model: ResolvedModel
  readonly systemPrompt?: string
  readonly messages: readonly CompleteMessage[]
  readonly maxOutputTokens: number
  readonly signal?: AbortSignal
  /** 省略时用 Runtime §10.4 的默认策略（最多 3 次，1 秒起、最长 30 秒）。 */
  readonly retry?: RetryPolicy
  /**
   * 重试前的等待。返回 false 表示已经中止、不再请求。
   * 测试用来跳过真实的等待。
   */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>
}

export type CompleteResult =
  | { readonly ok: true; readonly text: string; readonly usage: TokenUsage }
  | { readonly ok: false; readonly error: { readonly code: string }; readonly retryable: boolean }

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function toContext(request: CompleteRequest, identity: PiModelIdentity): Context {
  const messages: CanonicalMessage[] = request.messages.map((message, index) =>
    message.role === 'user'
      ? { role: 'user', content: [{ type: 'text', text: message.content }], ts: index }
      : {
          role: 'assistant',
          content: [{ type: 'text', text: message.content }],
          model: request.model.ref,
          ts: index,
        },
  )
  return {
    ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    messages: toPiMessages(messages, identity),
  }
}

/** 只取正文。推理块留在 `fromPiAssistant` 的 `reasoning` 里，这里不用。 */
function textOf(message: AssistantMessage, model: ResolvedModel): string {
  return fromPiAssistant(message, model.ref)
    .content.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export async function complete(request: CompleteRequest): Promise<CompleteResult> {
  const policy = request.retry ?? DEFAULT_RETRY_POLICY
  const wait = request.sleep ?? sleep
  const binding = bindModel(request.model)
  const context = toContext(request, binding.identity)
  let attempt = 0
  for (;;) {
    if (request.signal?.aborted) {
      return { ok: false, error: { code: PiErrorCode.NetworkError }, retryable: false }
    }
    const message = await binding.complete(context, {
      maxTokens: request.maxOutputTokens,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      return {
        ok: true,
        text: textOf(message, request.model),
        usage: fromPiUsage(message.usage),
      }
    }
    const failure = toFailure(message, request.model.profile.contextWindow)
    const aborted = message.stopReason === 'aborted' || request.signal?.aborted === true
    if (aborted || !failure.retryable || attempt >= policy.maxRetries) {
      return { ok: false, error: failure.error, retryable: !aborted && failure.retryable }
    }
    attempt += 1
    const continued = await wait(retryDelay(policy, attempt), request.signal)
    if (!continued) return { ok: false, error: failure.error, retryable: false }
  }
}
