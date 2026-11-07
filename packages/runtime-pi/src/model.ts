/**
 * `ResolvedModel` → pi 模型定义与请求函数（M1-01c；ADR-0021）。
 *
 * - 接口格式：openai → `openai-completions`，anthropic → `anthropic-messages`，gemini → `google-generative-ai`。
 * - DeepSeek：openai 格式且模型 id 在 pi 内置目录中时，用目录中的定义（兼容参数、思考等级映射，S2），
 *   地址仍用配置的地址，因此经代理接入时兼容参数同样生效。其他模型按 `ModelProfile` 构造。
 * - 兼容参数（M1-04b）：openai 格式时，`ResolvedModel.compat` 逐项覆盖目录中的值；pi 再用它逐项覆盖
 *   按地址自动判断的值。模型 id 不在目录中（如代理上的 `group/smart-split`）时，DeepSeek 的参数靠
 *   模板给出。其他格式忽略。
 * - 每个会话一个 pi `Models` 注册表，只含这一个提供方和模型，Key 只在请求时由闭包提供，不进入环境变量。
 * - pi（SDK）自身的重试关闭（`maxRetries: 0`），失败如实上报，由 M1-14 的重试策略处理。
 */
import type { ProviderKind, ResolvedModel } from '@cairn/core'
import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICompletionsCompat,
  type ProviderStreams,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { PiModelIdentity } from './messages.js'

export const API_BY_KIND: Readonly<Record<ProviderKind, Api>> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
  gemini: 'google-generative-ai',
}

const STREAMS_BY_KIND: Readonly<Record<ProviderKind, () => ProviderStreams>> = {
  openai: openAICompletionsApi,
  anthropic: anthropicMessagesApi,
  gemini: googleGenerativeAIApi,
}

/** 没有 Key 的提供方（如本地模型）也要给 pi 一个值。 */
const NO_KEY = 'no-key'

/** pi 内置目录中的模型定义（只查 openai 格式的 DeepSeek）。 */
function catalogModel(resolved: ResolvedModel): Model<Api> | undefined {
  if (resolved.providerKind !== 'openai') return undefined
  return Object.values(DEEPSEEK_MODELS).find((m) => m.id === resolved.ref.modelId) as
    Model<Api> | undefined
}

export function toPiModel(resolved: ResolvedModel): Model<Api> {
  const { ref, baseUrl, profile } = resolved
  const catalog = catalogModel(resolved)
  const base: Model<Api> = catalog ?? {
    id: ref.modelId,
    name: ref.modelId,
    api: API_BY_KIND[resolved.providerKind],
    provider: ref.providerId,
    baseUrl,
    reasoning: profile.supportsReasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
  }
  const compat =
    resolved.providerKind === 'openai' && resolved.compat
      ? { ...(base.compat as OpenAICompletionsCompat | undefined), ...resolved.compat }
      : base.compat
  return {
    ...base,
    provider: ref.providerId,
    baseUrl,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
    ...(compat ? { compat } : {}),
  } as Model<Api>
}

export interface PiModelBinding {
  readonly model: Model<Api>
  readonly identity: PiModelIdentity
  readonly streamFn: StreamFn
  /** 一次非流式的完整请求（连接测试用，M2-10）。 */
  readonly complete: (context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>
}

export function bindModel(resolved: ResolvedModel): PiModelBinding {
  const definition = toPiModel(resolved)
  const apiKey = resolved.apiKey ?? NO_KEY
  const models = createModels()
  models.setProvider(
    createProvider({
      id: definition.provider,
      baseUrl: definition.baseUrl,
      auth: {
        apiKey: { name: 'Cairn credential', resolve: async () => ({ auth: { apiKey } }) },
      },
      models: [definition],
      api: STREAMS_BY_KIND[resolved.providerKind](),
    }),
  )
  const model = models.getModel(definition.provider, definition.id)
  /* v8 ignore next -- 刚注册的模型一定能查到 */
  if (!model) throw new Error(`pi 模型注册失败：${definition.provider}/${definition.id}`)
  return {
    model,
    identity: { ref: resolved.ref, provider: model.provider, api: model.api, id: model.id },
    streamFn: (m, context, options) =>
      models.streamSimple(m, context, { ...options, maxRetries: 0 }),
    complete: (context, options) =>
      models.completeSimple(model, context, { ...options, maxRetries: 0 }),
  }
}
