// @ts-check
/**
 * 在当前进程中用 pi-agent-core + pi-ai 跑三个场景，返回观察结果（判定在 `checks.mjs`，因为 mock 端点
 * 可能在另一个进程中，需要结合它记录的请求）：
 *
 * 1. `tool`：带一次工具调用的对话（推理内容 → 工具调用 → 工具结果 → 最终回复）；
 * 2. `abort`：流式输出过程中 `agent.abort()`；
 * 3. `error`：端点返回 401。
 *
 * 模型经 `createProvider` + `openAICompletionsApi` 指向 mock 端点；API Key 由调用方传入（ADR-0010：
 * 宿主从主进程拿到凭据），不从环境变量读取。
 */

/** @param {unknown} message */
const textOf = (message) =>
  /** @type {any} */ (message)?.content
    ?.filter((/** @type {any} */ part) => part.type === 'text')
    .map((/** @type {any} */ part) => part.text)
    .join('') ?? ''

/** @param {unknown} message */
const thinkingOf = (message) =>
  /** @type {any} */ (message)?.content
    ?.filter((/** @type {any} */ part) => part.type === 'thinking')
    .map((/** @type {any} */ part) => part.thinking)
    .join('') ?? ''

/**
 * @param {{ baseUrl: string, apiKey: string }} options
 */
export async function runScenarios({ baseUrl, apiKey }) {
  const loadStart = performance.now()
  const [{ Agent }, { createModels, createProvider }, { openAICompletionsApi }] = await Promise.all(
    [
      import('@earendil-works/pi-agent-core'),
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    ],
  )
  const loadMs = performance.now() - loadStart

  /** @param {string} id @param {boolean} reasoning */
  const model = (id, reasoning) => ({
    id,
    name: id,
    api: /** @type {const} */ ('openai-completions'),
    provider: 'spike',
    baseUrl,
    reasoning,
    input: /** @type {('text')[]} */ (['text']),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
  })
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'spike',
      name: 'Spike',
      baseUrl,
      auth: { apiKey: { name: 'Spike', resolve: async () => ({ auth: { apiKey } }) } },
      models: [
        model('tool-model', true),
        model('slow-model', false),
        model('auth-fail-model', false),
      ],
      api: openAICompletionsApi(),
    }),
  )

  /** @type {{ a: number, b: number }[]} */
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

  /** @param {string} modelId @param {any[]} tools */
  const createAgent = (modelId, tools) => {
    const m = models.getModel('spike', modelId)
    if (!m) throw new Error(`model ${modelId} not found`)
    return new Agent({
      initialState: { systemPrompt: 'You are a calculator.', model: m, tools },
      streamFn: models.streamSimple.bind(models),
      sessionId: 'spike-session',
      identity: null,
    })
  }

  /** 订阅事件，统计类型与增量；`onDelta` 在每个文本增量后调用。 */
  const watch = (/** @type {any} */ agent, onDelta = (/** @type {number} */ _n) => {}) => {
    /** @type {Record<string, number>} */
    const counts = {}
    const deltas = { text: 0, thinking: 0, toolcall: 0 }
    agent.subscribe((/** @type {any} */ event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1
      if (event.type !== 'message_update') return
      const kind = event.assistantMessageEvent.type
      if (kind === 'text_delta') onDelta(++deltas.text)
      if (kind === 'thinking_delta') deltas.thinking++
      if (kind === 'toolcall_delta') deltas.toolcall++
    })
    return { counts, deltas }
  }

  /** @param {() => Promise<unknown>} fn */
  const timed = async (fn) => {
    const start = performance.now()
    let error = null
    try {
      await fn()
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
    return { ms: performance.now() - start, error }
  }

  // 1. 工具调用
  const toolAgent = createAgent('tool-model', [addTool])
  const toolWatch = watch(toolAgent)
  const toolRun = await timed(() => toolAgent.prompt('What is 2 + 3? Use the add tool.'))
  const toolMessages = toolAgent.state.messages
  const assistants = toolMessages.filter((/** @type {any} */ m) => m.role === 'assistant')
  const tool = {
    ...toolRun,
    events: toolWatch.counts,
    deltas: toolWatch.deltas,
    roles: toolMessages.map((/** @type {any} */ m) => m.role),
    toolCalls,
    requestedCall:
      assistants[0]?.content.find((/** @type {any} */ p) => p.type === 'toolCall') ?? null,
    firstStopReason: assistants[0]?.stopReason ?? null,
    thinking: thinkingOf(assistants[0]),
    finalText: textOf(assistants.at(-1)),
    finalStopReason: assistants.at(-1)?.stopReason ?? null,
    usage: assistants.map((/** @type {any} */ m) => m.usage?.totalTokens ?? null),
  }

  // 2. 中止：收到 3 个文本增量后 abort
  const abortAgent = createAgent('slow-model', [])
  let abortedAt = 0
  const abortWatch = watch(abortAgent, (n) => {
    if (n === 3) {
      abortedAt = performance.now()
      abortAgent.abort()
    }
  })
  const abortRun = await timed(() => abortAgent.prompt('Write a long story.'))
  const abortLast = abortAgent.state.messages.at(-1)
  const abort = {
    ...abortRun,
    events: abortWatch.counts,
    textDeltas: abortWatch.deltas.text,
    settleMsAfterAbort: abortedAt === 0 ? null : performance.now() - abortedAt,
    lastRole: abortLast?.role ?? null,
    stopReason: /** @type {any} */ (abortLast)?.stopReason ?? null,
    partialText: textOf(abortLast),
  }

  // 3. 错误：401
  const errorAgent = createAgent('auth-fail-model', [])
  const errorWatch = watch(errorAgent)
  const errorRun = await timed(() => errorAgent.prompt('Hello'))
  const errorLast = /** @type {any} */ (errorAgent.state.messages.at(-1))
  const error = {
    ...errorRun,
    events: errorWatch.counts,
    lastRole: errorLast?.role ?? null,
    stopReason: errorLast?.stopReason ?? null,
    errorMessage: errorLast?.errorMessage ?? null,
  }

  return { loadMs, tool, abort, error }
}
