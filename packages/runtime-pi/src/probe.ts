/**
 * 连接测试（M2-10）：用与会话相同的模型定义（接口格式、地址、兼容参数）发一次最小的请求，
 * 返回耗时，失败时按 `toFailure` 归类（错误码由界面翻译，原始文本不返回）。
 *
 * 请求只有一句用户消息，输出上限很小，不带工具和系统提示词。
 */
import type { ResolvedModel } from '@cairn/core'
import type { ErrorInfo } from '@cairn/protocol'
import { bindModel } from './model.js'
import { toFailure } from './errors.js'

export type ProbeResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly latencyMs: number; readonly error: ErrorInfo }

export interface ProbeOptions {
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/** 连接测试的输出上限（token）。 */
export const PROBE_MAX_TOKENS = 16

export async function probeModel(
  resolved: ResolvedModel,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const now = options.now ?? Date.now
  const binding = bindModel(resolved)
  const started = now()
  const message = await binding.complete(
    { messages: [{ role: 'user', content: 'ping', timestamp: started }] },
    { maxTokens: PROBE_MAX_TOKENS, ...(options.signal ? { signal: options.signal } : {}) },
  )
  const latencyMs = Math.max(0, Math.round(now() - started))
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return { ok: false, latencyMs, error: toFailure(message).error }
  }
  return { ok: true, latencyMs }
}
