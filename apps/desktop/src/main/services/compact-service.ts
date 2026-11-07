/**
 * 上下文压缩的摘要（M3-03）。宿主在调用模型前把更早的对话发来，这里用辅助模型
 * （没有配置时用会话的主模型）写成一段摘要。
 *
 * 和自动标题一样：失败只写日志，用量记为 `usage.reported`（`auxiliary`），不更新上下文圆环。
 * 会话模型没有提供方配置时（开发用的 FakeRuntime）不调用、不记日志。
 */
import {
  COMPACTION_SYSTEM_PROMPT,
  resolveModel,
  type CredentialProvider,
  type ResolvedModel,
} from '@cairn/core'
import type { HostModelConfig, ModelRef, PersistedEvent, Settings } from '@cairn/protocol'
import type { CompleteRequest, CompleteResult } from '@cairn/runtime-pi'
import type { SessionEventService } from './event-service.js'

const SUMMARY_MAX_OUTPUT_TOKENS = 1024

export interface CompactSettings {
  get(): Settings
  hostModelConfig(model: ModelRef): HostModelConfig | undefined
  credentialRef(model: ModelRef): string | undefined
}

export type CompleteFn = (request: CompleteRequest) => Promise<CompleteResult>

export interface CompactServiceOptions {
  readonly events: Pick<SessionEventService, 'publish' | 'readAfter'>
  readonly settings: CompactSettings
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  readonly complete?: CompleteFn
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export interface CompactService {
  /** 摘要这段转录。没有可用模型或模型没写出内容时返回 undefined。 */
  summarize(sessionId: string, transcript: string): Promise<string | undefined>
  stop(): void
}

const defaultComplete: CompleteFn = async (request) => {
  const { complete } = await import('@cairn/runtime-pi')
  return complete(request)
}

function sessionModel(events: readonly PersistedEvent[]): ModelRef | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session.model.changed' || event?.type === 'session.created') {
      return event.payload.model
    }
  }
  return undefined
}

export function createCompactService(options: CompactServiceOptions): CompactService {
  const now = options.now ?? Date.now
  const complete = options.complete ?? defaultComplete
  const abort = new AbortController()
  let stopped = false

  const fail = (error: unknown) => {
    if (!stopped) options.onError?.(error)
  }

  async function resolve(model: ModelRef): Promise<ResolvedModel | undefined> {
    const config = options.settings.hostModelConfig(model)
    if (!config) return undefined
    const ref = options.settings.credentialRef(model)
    const credential = ref ? await options.credentials.resolve(ref) : undefined
    return resolveModel(model, config, credential?.apiKey)
  }

  return {
    async summarize(sessionId, transcript) {
      if (stopped || transcript.trim() === '') return undefined
      const recorded = options.events.readAfter(sessionId, 0)
      const auxiliary = options.settings.get().auxiliaryModel
      const model = auxiliary ?? sessionModel(recorded)
      if (!model) return undefined
      try {
        const resolved = await resolve(model)
        if (stopped) return undefined
        if (!resolved) {
          if (auxiliary) fail(new Error('compact: model is not configured'))
          return undefined
        }
        const result = await complete({
          model: resolved,
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: transcript }],
          maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
          signal: abort.signal,
        })
        if (stopped) return undefined
        if (!result.ok) {
          fail(new Error(result.error.code))
          return undefined
        }
        let runId = sessionId
        for (let i = recorded.length - 1; i >= 0; i -= 1) {
          const id = recorded[i]?.runId
          if (id) {
            runId = id
            break
          }
        }
        options.events.publish([
          {
            v: 1,
            sessionId,
            runId,
            ts: now(),
            type: 'usage.reported',
            payload: { model, usage: result.usage, auxiliary: true },
          },
        ])
        const text = result.text.trim()
        return text === '' ? undefined : text
      } catch (error) {
        fail(error)
        return undefined
      }
    },
    stop() {
      stopped = true
      abort.abort()
    },
  }
}
