// @ts-check
/**
 * 契约场景：三种接口格式（ADR-0021）× 若干模型行为。每个场景用 pi-agent-core 的 `Agent` 跑一次
 * `prompt()`，收集全部事件；模型经 `createProvider` 指向 `baseUrl`（录制代理或回放服务）。
 *
 * 不注入 `fetch`：pi-ai 的 Gemini 适配器不支持自定义 fetch（会直接报错），只能经 `baseUrl`
 * 让 SDK 走真实的 HTTP 请求，三种格式因此统一用本地 HTTP 服务录制与回放。
 */

/**
 * @typedef {'openai' | 'anthropic' | 'gemini'} Format
 *
 * @typedef {object} Scenario
 * @property {string} name 文件名用的标识，`<格式>-<行为>`
 * @property {Format} format
 * @property {string} model 上游模型 id
 * @property {string} prompt
 * @property {boolean} [tools] 是否提供 `add` 工具
 * @property {number} [abortAfterTextDeltas] 收到第 n 个文本增量时 `abort()`
 */

/** @type {Record<Format, { api: string, basePath: string, lazy: string, factory: string }>} */
export const FORMATS = {
  openai: {
    api: 'openai-completions',
    basePath: '/v1',
    lazy: '@earendil-works/pi-ai/api/openai-completions.lazy',
    factory: 'openAICompletionsApi',
  },
  anthropic: {
    api: 'anthropic-messages',
    basePath: '',
    lazy: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
    factory: 'anthropicMessagesApi',
  },
  gemini: {
    api: 'google-generative-ai',
    basePath: '/v1beta',
    lazy: '@earendil-works/pi-ai/api/google-generative-ai.lazy',
    factory: 'googleGenerativeAIApi',
  },
}

const TOOL_PROMPT = 'What is 2 + 3? Use the add tool.'
const PARALLEL_PROMPT = 'Compute 2 + 3 and 10 + 20 with the add tool, in parallel.'

/** @type {Scenario[]} */
export const SCENARIOS = /** @type {Format[]} */ (['openai', 'anthropic', 'gemini']).flatMap(
  (format) => [
    { name: `${format}-tool`, format, model: 'calc-tool', prompt: TOOL_PROMPT, tools: true },
    {
      name: `${format}-parallel`,
      format,
      model: 'calc-parallel',
      prompt: PARALLEL_PROMPT,
      tools: true,
    },
    { name: `${format}-auth-fail`, format, model: 'auth-fail', prompt: 'Hello' },
  ],
)

SCENARIOS.push(
  // 模型 id 为 gemini-3 起时，pi-ai 把（自己生成的）工具调用 id 发回给服务
  {
    name: 'gemini-3-tool',
    format: 'gemini',
    model: 'gemini-3-calc-tool',
    prompt: TOOL_PROMPT,
    tools: true,
  },
)

/** 中止场景只在 OpenAI 格式上验证（中止逻辑在 pi-agent-core 与 SSE 读取中，与格式无关）。 */
SCENARIOS.push({
  name: 'openai-abort',
  format: 'openai',
  model: 'calc-tool',
  prompt: TOOL_PROMPT,
  tools: true,
  abortAfterTextDeltas: 2,
})

/**
 * @param {Scenario} scenario
 * @param {{ baseUrl: string, apiKey: string }} options `baseUrl` 为服务根地址，格式的路径前缀在这里拼接
 * @returns {Promise<{ events: any[], toolCalls: unknown[] }>}
 */
export async function runScenario(scenario, { baseUrl, apiKey }) {
  const format = FORMATS[scenario.format]
  const [{ Agent }, { createModels, createProvider }, lazy] = await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
    import(format.lazy),
  ])
  const providerBaseUrl = `${baseUrl}${format.basePath}`
  const model = {
    id: scenario.model,
    name: scenario.model,
    api: format.api,
    provider: 'contract',
    baseUrl: providerBaseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1_024,
    ...(scenario.format === 'openai'
      ? {
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStore: false,
          },
        }
      : {}),
  }
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'contract',
      name: 'Contract',
      baseUrl: providerBaseUrl,
      auth: { apiKey: { name: 'Contract', resolve: async () => ({ auth: { apiKey } }) } },
      models: [/** @type {any} */ (model)],
      api: lazy[format.factory](),
    }),
  )

  /** @type {unknown[]} */
  const toolCalls = []
  const addTool = {
    name: 'add',
    label: 'Add',
    description: 'Add two numbers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    execute: async (/** @type {string} */ _id, /** @type {any} */ params) => {
      toolCalls.push(params)
      return { content: [{ type: 'text', text: String(params.a + params.b) }], details: {} }
    },
  }

  const resolved = models.getModel('contract', scenario.model)
  if (!resolved) throw new Error(`model ${scenario.model} not found`)
  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are a calculator.',
      model: resolved,
      tools: scenario.tools ? [addTool] : [],
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: 'contract-session',
    identity: null,
  })

  /** @type {any[]} */
  const events = []
  let textDeltas = 0
  agent.subscribe((/** @type {any} */ event) => {
    events.push(structuredClone(event))
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      textDeltas++
      if (textDeltas === scenario.abortAfterTextDeltas) agent.abort()
    }
  })
  await agent.prompt(scenario.prompt)
  return { events, toolCalls }
}
