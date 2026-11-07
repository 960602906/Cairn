/**
 * 会话要点（M3-04）。每一轮成功结束后，用辅助模型（没有配置时用会话的主模型）增量更新要点。
 *
 * 只收录用户明确说过的目标、约束和偏好。用户编辑过的版本优先：模型的新文字只能追加在后面。
 * 与当前要点相同时不发 `session.brief.updated`。失败只交给 `onError`，不产生界面上的错误。
 * 用量记为 `usage.reported`（`auxiliary`），计入会话 token 统计，不计入上下文圆环。
 */
import { resolveModel, type CredentialProvider, type ResolvedModel } from '@cairn/core'
import type { HostModelConfig, ModelRef, Settings, UnsequencedEvent } from '@cairn/protocol'
import type { CompleteRequest, CompleteResult } from '@cairn/runtime-pi'
import type { SessionEventService } from './event-service.js'
import {
  BRIEF_SYSTEM_PROMPT,
  briefRequest,
  briefUpdateInput,
  latestBrief,
  mergeBrief,
  sameBrief,
  type SessionBriefSnapshot,
} from './brief.js'

/** 要点是短文。留出余量给思考型模型的推理。 */
const BRIEF_MAX_OUTPUT_TOKENS = 1024

export interface BriefSettings {
  get(): Settings
  hostModelConfig(model: ModelRef): HostModelConfig | undefined
  credentialRef(model: ModelRef): string | undefined
}

export type CompleteFn = (request: CompleteRequest) => Promise<CompleteResult>

export interface BriefServiceOptions {
  readonly events: Pick<SessionEventService, 'subscribe' | 'publish' | 'readAfter'>
  readonly settings: BriefSettings
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  /** 测试用：替换一次性补全（默认按需加载 `runtime-pi` 的 `complete`）。 */
  readonly complete?: CompleteFn
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export interface BriefService {
  /** 停止监听并中止进行中的补全。应用退出时调用。 */
  stop(): void
}

const defaultComplete: CompleteFn = async (request) => {
  const { complete } = await import('@cairn/runtime-pi')
  return complete(request)
}

export function createBriefService(options: BriefServiceOptions): BriefService {
  const now = options.now ?? Date.now
  const complete = options.complete ?? defaultComplete
  const pending = new Set<string>()
  const abort = new AbortController()
  let stopped = false

  const fail = (error: unknown) => {
    if (!stopped) options.onError?.(error)
  }

  const auto = () => options.settings.get().sessionBrief !== false

  async function resolve(model: ModelRef): Promise<ResolvedModel | undefined> {
    const config = options.settings.hostModelConfig(model)
    if (!config) return undefined
    const ref = options.settings.credentialRef(model)
    const credential = ref ? await options.credentials.resolve(ref) : undefined
    return resolveModel(model, config, credential?.apiKey)
  }

  async function generate(sessionId: string): Promise<void> {
    if (stopped || pending.has(sessionId) || !auto()) return
    const recorded = options.events.readAfter(sessionId, 0)
    const input = briefUpdateInput(recorded)
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
        if (auxiliary) fail(new Error('brief: model is not configured'))
        return
      }
      const result = await complete({
        model: resolved,
        systemPrompt: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: briefRequest(input) }],
        maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
        signal: abort.signal,
      })
      if (stopped) return
      if (!result.ok) {
        fail(new Error(result.error.code))
        return
      }
      const header = { v: 1 as const, sessionId, runId: input.runId, ts: now() }
      const out: UnsequencedEvent[] = [
        {
          ...header,
          turnId: input.turnId,
          type: 'usage.reported',
          payload: { model, usage: result.usage, auxiliary: true },
        },
      ]
      if (auto()) {
        const latest = latestBrief(options.events.readAfter(sessionId, 0))
        const base: SessionBriefSnapshot | undefined =
          latest?.editedBy === 'user' ? latest : (latest ?? input.brief)
        const merged = mergeBrief(base, result.text)
        if (merged.trim() && !sameBrief(latest?.content ?? input.brief?.content, merged)) {
          out.unshift({
            ...header,
            type: 'session.brief.updated',
            payload: {
              content: merged.trim(),
              editedBy: base?.editedBy === 'user' ? 'user' : 'agent',
            },
          })
        }
      }
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
