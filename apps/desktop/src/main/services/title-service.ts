/**
 * 自动标题（M3-01）。会话第一轮成功结束后，如果标题仍为空且用户没有改过，用辅助模型
 * （没有配置时用会话的主模型）根据第一条用户消息和回复生成不超过 30 个字符的标题。
 *
 * 失败只交给 `onError`（主进程写日志），不产生界面上的错误。用量记为 `usage.reported`
 * （`auxiliary`），计入会话 token 统计，不计入上下文圆环。
 */
import { resolveModel, type CredentialProvider, type ResolvedModel } from '@cairn/core'
import type { HostModelConfig, ModelRef, Settings, UnsequencedEvent } from '@cairn/protocol'
import type { CompleteRequest, CompleteResult } from '@cairn/runtime-pi'
import type { Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'
import {
  autoTitleBlocked,
  autoTitleInput,
  clipText,
  normalizeTitle,
  TITLE_SYSTEM_PROMPT,
} from './title.js'

/** 标题很短；留出余量给思考型模型的推理，正文仍会被截到 30 个字符。 */
const TITLE_MAX_OUTPUT_TOKENS = 128

export interface TitleSettings {
  get(): Settings
  hostModelConfig(model: ModelRef): HostModelConfig | undefined
  credentialRef(model: ModelRef): string | undefined
}

export type CompleteFn = (request: CompleteRequest) => Promise<CompleteResult>

export interface TitleServiceOptions {
  readonly events: Pick<SessionEventService, 'subscribe' | 'publish' | 'readAfter'>
  readonly storage: { readonly sessions: Pick<Storage['sessions'], 'rename'> }
  readonly settings: TitleSettings
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  /** 测试用：替换一次性补全（默认按需加载 `runtime-pi` 的 `complete`）。 */
  readonly complete?: CompleteFn
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export interface TitleService {
  /** 停止监听并中止进行中的补全。应用退出时调用。 */
  stop(): void
}

const defaultComplete: CompleteFn = async (request) => {
  const { complete } = await import('@cairn/runtime-pi')
  return complete(request)
}

export function createTitleService(options: TitleServiceOptions): TitleService {
  const now = options.now ?? Date.now
  const complete = options.complete ?? defaultComplete
  const pending = new Set<string>()
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

  async function generate(sessionId: string): Promise<void> {
    if (stopped || pending.has(sessionId)) return
    const input = autoTitleInput(options.events.readAfter(sessionId, 0))
    if (!input) return
    const auxiliary = options.settings.get().auxiliaryModel
    const model = auxiliary ?? input.model
    if (!model) return
    pending.add(sessionId)
    try {
      const resolved = await resolve(model)
      if (stopped) return
      if (!resolved) {
        // 会话模型没有提供方配置（开发用的 FakeRuntime）时安静跳过。
        // 辅助模型配了却解析不到才记日志。
        if (auxiliary) fail(new Error('title: model is not configured'))
        return
      }
      const result = await complete({
        model: resolved,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `User:\n${clipText(input.userText)}\n\nAssistant:\n${clipText(input.assistantText)}`,
          },
        ],
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        signal: abort.signal,
      })
      if (stopped) return
      if (!result.ok) {
        fail(new Error(result.error.code))
        return
      }
      const header = { v: 1 as const, sessionId, runId: input.runId, ts: now() }
      const out: UnsequencedEvent[] = []
      if (!autoTitleBlocked(options.events.readAfter(sessionId, 0))) {
        const title = normalizeTitle(result.text)
        if (title) {
          options.storage.sessions.rename(sessionId, title)
          out.push({
            ...header,
            type: 'session.renamed',
            payload: { title, source: 'auto' },
          })
        }
      }
      out.push({
        ...header,
        turnId: input.turnId,
        type: 'usage.reported',
        payload: { model, usage: result.usage, auxiliary: true },
      })
      if (!stopped) options.events.publish(out)
    } catch (error) {
      fail(error)
    } finally {
      pending.delete(sessionId)
    }
  }

  const unsubscribe = options.events.subscribe((sessionId, batch) => {
    if (stopped || !batch.some((event) => event.type === 'turn.completed')) return
    void generate(sessionId)
  })

  return {
    stop() {
      stopped = true
      abort.abort()
      unsubscribe()
    },
  }
}
