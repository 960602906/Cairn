// @ts-check
/**
 * 场景与检查。每次运行新建一个 pi-agent-core `Agent`，收集全部事件后做检查：
 *
 * - `chain`：必须按顺序调用三个工具（订单 → 客户 → 天气），每一步的参数来自上一步的结果；
 *   再追问一轮，答案要从上下文中得出。思考模式下，DeepSeek 要求后续请求带回 `reasoning_content`，
 *   多轮工具调用能否走通正好检验这一点。
 * - `parallel`：两个互不依赖的查询，记录模型是否在同一条回复中发出两个工具调用。
 *
 * 每条助手消息另做流式完整性检查：增量拼接结果与最终内容一致，思考内容没有混进正文，
 * 工具参数是合法 JSON，用量不为 0。
 */
import { apiKeyFor } from './targets.mjs'

const ORDERS = /** @type {Record<string, { customer_id: string, item: string }>} */ ({
  'A-1024': { customer_id: 'C-77', item: '机械键盘' },
})
const CUSTOMERS = /** @type {Record<string, { name: string, city: string }>} */ ({
  'C-77': { name: '张晓明', city: '杭州' },
})
const WEATHER = /** @type {Record<string, number>} */ ({ 杭州: 23, 北京: 12, 上海: 18 })

/**
 * @param {string} name
 * @param {string} description
 * @param {string} param
 * @param {(value: string) => unknown} lookup
 * @param {{ name: string, args: Record<string, unknown> }[]} calls
 */
function tool(name, description, param, lookup, calls) {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: 'object',
      properties: { [param]: { type: 'string' } },
      required: [param],
      additionalProperties: false,
    },
    execute: async (/** @type {string} */ _id, /** @type {any} */ args) => {
      calls.push({ name, args })
      const result = lookup(String(args?.[param] ?? ''))
      if (result === undefined) throw new Error(`未找到：${args?.[param]}`)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }
    },
  }
}

/** @param {{ name: string, args: Record<string, unknown> }[]} calls */
const makeTools = (calls) => [
  tool('get_order', '按订单号查询订单，返回客户编号与商品', 'order_id', (v) => ORDERS[v], calls),
  tool(
    'get_customer',
    '按客户编号查询客户姓名与所在城市',
    'customer_id',
    (v) => CUSTOMERS[v],
    calls,
  ),
  tool(
    'get_weather',
    '查询城市当前气温（摄氏度）',
    'city',
    (v) => WEATHER[v.replace(/市$/, '')],
    calls,
  ),
]

/**
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} title
 * @property {string[]} prompts 依次发送的用户消息
 * @property {(r: RunData) => { ok: boolean, detail: string }} check
 *
 * @typedef {object} RunData
 * @property {{ name: string, args: Record<string, unknown> }[]} calls 工具实际收到的调用
 * @property {any[]} assistants 每条助手消息（message_end）
 * @property {string[]} answers 每轮用户消息后的最后一条回复正文
 */

const textOf = (/** @type {any} */ m) =>
  (m?.content ?? [])
    .filter((/** @type {any} */ c) => c.type === 'text')
    .map((/** @type {any} */ c) => c.text)
    .join('')

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: 'chain',
    title: '多轮工具调用（订单 → 客户 → 天气，再追问一轮）',
    prompts: [
      '订单 A-1024 的客户所在城市现在多少度？请用工具查询，不要猜测。',
      '这位客户叫什么名字？',
    ],
    check: (r) => {
      const seq = r.calls.map((c) => `${c.name}(${Object.values(c.args).join(',')})`)
      const want = ['get_order(A-1024)', 'get_customer(C-77)', 'get_weather(杭州)']
      const ordered = want.every(
        (w, i) =>
          seq.indexOf(w) >= 0 &&
          (i === 0 || seq.indexOf(w) > seq.indexOf(/** @type {string} */ (want[i - 1]))),
      )
      const first = r.answers[0] ?? ''
      const second = r.answers[1] ?? ''
      const ok = ordered && first.includes('23') && second.includes('张晓明')
      return {
        ok,
        detail: ok
          ? `${seq.length} 次调用`
          : `调用=${seq.join(' ')} 回答1=${JSON.stringify(first.slice(0, 60))} 回答2=${JSON.stringify(second.slice(0, 40))}`,
      }
    },
  },
  {
    id: 'parallel',
    title: '并行工具调用（北京、上海天气）',
    prompts: ['同时查一下北京和上海现在的气温。'],
    check: (r) => {
      const cities = r.calls
        .filter((c) => c.name === 'get_weather')
        .map((c) => String(c.args['city']))
      const answer = r.answers[0] ?? ''
      const ok =
        cities.some((c) => c.includes('北京')) &&
        cities.some((c) => c.includes('上海')) &&
        answer.includes('12') &&
        answer.includes('18')
      const parallel = r.assistants.some(
        (m) => m.content.filter((/** @type {any} */ c) => c.type === 'toolCall').length >= 2,
      )
      return {
        ok,
        detail: `${parallel ? '同一回复中并行调用' : '分多次调用'}${ok ? '' : ` 调用=${cities.join(',')} 回答=${JSON.stringify(answer.slice(0, 60))}`}`,
      }
    },
  },
]

/**
 * 一条助手消息的流式完整性。
 * @param {any} message message_end 中的最终消息
 * @param {Map<number, { text: string, thinking: string, toolArgs: string }>} deltas 按 contentIndex 拼接的增量
 */
export function checkMessage(message, deltas) {
  /** @type {string[]} */
  const problems = []
  message.content.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const d = deltas.get(i)
    if (c.type === 'text' && d && d.text !== c.text)
      problems.push(`正文增量与最终内容不一致(#${i})`)
    if (c.type === 'thinking' && d && d.thinking !== c.thinking)
      problems.push(`思考增量与最终内容不一致(#${i})`)
    if (c.type === 'text' && /<\/?think>/i.test(c.text)) problems.push('正文中出现 <think> 标签')
    if (c.type === 'toolCall' && c.argumentsError)
      problems.push(`工具参数不是合法 JSON：${c.argumentsError.slice(0, 80)}`)
  })
  const thinking = message.content
    .filter((/** @type {any} */ c) => c.type === 'thinking')
    .map((/** @type {any} */ c) => c.thinking)
    .join('')
  const text = textOf(message)
  if (thinking.length > 40 && text.includes(thinking.slice(0, 40)))
    problems.push('思考内容混入正文')
  if (message.stopReason === 'error')
    problems.push(`错误：${String(message.errorMessage).slice(0, 160)}`)
  if (message.stopReason !== 'error' && !(message.usage?.output > 0)) problems.push('用量为 0')
  return problems
}

/**
 * @param {import('./targets.mjs').Target} target
 * @param {Scenario} scenario
 * @param {'off' | 'high'} thinkingLevel
 */
export async function runOnce(target, scenario, thinkingLevel) {
  const [{ Agent }, { createModels, createProvider }, lazy] = await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
    import(target.lazy),
  ])
  const model = target.model()
  const apiKey = apiKeyFor(target)
  if (!apiKey) throw new Error(`环境变量 ${target.keyEnv} 为空`)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'nexus-spike',
      name: 'NEXUS spike',
      baseUrl: model.baseUrl,
      auth: { apiKey: { name: target.keyEnv, resolve: async () => ({ auth: { apiKey } }) } },
      models: [model],
      api: lazy[target.factory](),
    }),
  )
  const resolved = models.getModel('nexus-spike', model.id)
  if (!resolved) throw new Error(`model ${model.id} not found`)

  /** @type {RunData['calls']} */
  const calls = []
  const agent = new Agent({
    initialState: {
      systemPrompt: '你是一个客服助手。需要数据时调用工具，不要编造。回答用中文，简短。',
      model: resolved,
      thinkingLevel,
      tools: makeTools(calls),
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: `s2-${Date.now()}`,
    identity: null,
  })

  /** @type {any[]} */
  const assistants = []
  /** @type {string[]} */
  const problems = []
  /** @type {Map<number, { text: string, thinking: string, toolArgs: string }>} */
  let deltas = new Map()
  let thinkingChars = 0
  agent.subscribe((/** @type {any} */ event) => {
    if (event.type === 'message_start' && event.message?.role === 'assistant') deltas = new Map()
    if (event.type === 'message_update') {
      const e = event.assistantMessageEvent
      if (e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'toolcall_delta') {
        const d = deltas.get(e.contentIndex) ?? { text: '', thinking: '', toolArgs: '' }
        if (e.type === 'text_delta') d.text += e.delta
        else if (e.type === 'thinking_delta') d.thinking += e.delta
        else d.toolArgs += e.delta
        deltas.set(e.contentIndex, d)
      }
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const m = structuredClone(event.message)
      assistants.push(m)
      problems.push(...checkMessage(m, deltas))
      for (const c of m.content) if (c.type === 'thinking') thinkingChars += c.thinking.length
    }
  })

  const started = performance.now()
  /** @type {string[]} */
  const answers = []
  for (const prompt of scenario.prompts) {
    await agent.prompt(prompt)
    answers.push(textOf(assistants.at(-1)))
  }
  const ms = Math.round(performance.now() - started)
  const outcome = scenario.check({ calls, assistants, answers })
  return {
    ok: outcome.ok && problems.length === 0,
    detail: [outcome.detail, ...problems].filter(Boolean).join('；'),
    ms,
    requests: assistants.length,
    thinkingChars,
    usage: assistants.reduce(
      (s, m) => ({
        input: s.input + (m.usage?.input ?? 0),
        output: s.output + (m.usage?.output ?? 0),
        reasoning: s.reasoning + (m.usage?.reasoning ?? 0),
      }),
      { input: 0, output: 0, reasoning: 0 },
    ),
    transcript: assistants.map((m) => ({
      stopReason: m.stopReason,
      content: m.content.map((/** @type {any} */ c) =>
        c.type === 'toolCall'
          ? { type: 'toolCall', name: c.name, arguments: c.arguments }
          : c.type === 'thinking'
            ? { type: 'thinking', chars: c.thinking.length }
            : { type: c.type, text: c.text },
      ),
      errorMessage: m.errorMessage,
    })),
  }
}
