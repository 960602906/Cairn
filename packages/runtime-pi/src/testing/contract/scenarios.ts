/**
 * 契约场景（M1-02a，由 S8 移入）：三种接口格式（ADR-0021）× 若干模型行为。每个场景用 `PiRuntime`
 * 建一个会话跑一次 `prompt`，收集适配器发出的 `RuntimeEvent`、工具钩子收到的调用与最终历史。
 * 模型的 `baseUrl` 指向录制代理或回放服务（服务根地址 + 格式的路径前缀）。
 *
 * 不注入 `fetch`：pi-ai 的 Gemini 适配器不支持自定义 fetch，只能经 `baseUrl` 让 SDK 走真实的 HTTP
 * 请求，三种格式因此统一用本地 HTTP 服务录制与回放。
 */
import type {
  ProviderKind,
  ResolvedModel,
  RuntimeEvent,
  RuntimeToolCall,
  RuntimeToolResult,
} from '@cairn/core'
import type { CanonicalMessage } from '@cairn/protocol'
import { PiRuntime } from '../../session.js'

export type Format = ProviderKind

export interface Scenario {
  /** 文件名用的标识，`<格式>-<行为>`。 */
  readonly name: string
  readonly format: Format
  /** 合成上游的模型 id；从真实服务录制时由录制参数替换。 */
  readonly model: string
  readonly prompt: string
  /** 是否提供 `add` 工具。 */
  readonly tools?: boolean
  /** 收到第 n 个文本增量时中止。 */
  readonly abortAfterTextDeltas?: number
}

/** 各格式的路径前缀：SDK 在模型的 `baseUrl` 后拼接接口路径。 */
export const BASE_PATH: Readonly<Record<Format, string>> = {
  openai: '/v1',
  anthropic: '',
  gemini: '/v1beta',
}

const TOOL_PROMPT = 'What is 2 + 3? Use the add tool.'
const PARALLEL_PROMPT = 'Compute 2 + 3 and 10 + 20 with the add tool, in parallel.'

export const SCENARIOS: readonly Scenario[] = [
  ...(['openai', 'anthropic', 'gemini'] as const).flatMap((format): Scenario[] => [
    { name: `${format}-tool`, format, model: 'calc-tool', prompt: TOOL_PROMPT, tools: true },
    {
      name: `${format}-parallel`,
      format,
      model: 'calc-parallel',
      prompt: PARALLEL_PROMPT,
      tools: true,
    },
    { name: `${format}-auth-fail`, format, model: 'auth-fail', prompt: 'Hello' },
  ]),
  // 模型 id 以 gemini-3 开头时，pi-ai 把（自己生成的）工具调用 id 发回给服务
  {
    name: 'gemini-3-tool',
    format: 'gemini',
    model: 'gemini-3-calc-tool',
    prompt: TOOL_PROMPT,
    tools: true,
  },
  // 中止只在 OpenAI 格式上验证（中止逻辑在 pi-agent-core 与 SSE 读取中，与格式无关）
  {
    name: 'openai-abort',
    format: 'openai',
    model: 'calc-tool',
    prompt: TOOL_PROMPT,
    tools: true,
    abortAfterTextDeltas: 2,
  },
]

export function findScenario(name: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.name === name)
  if (!scenario) throw new Error(`unknown scenario ${name}`)
  return scenario
}

const ADD_TOOL = {
  name: 'add',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
}

export interface RunOptions {
  /** 服务根地址（录制代理或回放服务），格式的路径前缀在这里拼接。 */
  readonly baseUrl: string
  readonly apiKey: string
  /** 模型 id，默认用场景中的。 */
  readonly model?: string
  /** 模型是否按支持推理配置（决定 pi 的思考等级）。 */
  readonly reasoning: boolean
}

export interface ScenarioRun {
  readonly events: RuntimeEvent[]
  readonly toolCalls: RuntimeToolCall[]
  readonly history: CanonicalMessage[]
}

export function contractModel(scenario: Scenario, options: RunOptions): ResolvedModel {
  return {
    ref: { providerId: 'contract', modelId: options.model ?? scenario.model },
    providerKind: scenario.format,
    baseUrl: `${options.baseUrl}${BASE_PATH[scenario.format]}`,
    apiKey: options.apiKey,
    profile: {
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: options.reasoning,
    },
  }
}

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<ScenarioRun> {
  const toolCalls: RuntimeToolCall[] = []
  const session = await new PiRuntime().createSession({
    model: contractModel(scenario, options),
    systemPrompt: 'You are a calculator.',
    tools: scenario.tools ? [ADD_TOOL] : [],
    history: [],
    signal: new AbortController().signal,
    hooks: {
      beforeToolCall: async (call) => {
        toolCalls.push(call)
        return { action: 'allow' }
      },
      executeTool: async (call): Promise<RuntimeToolResult> => {
        const { a, b } = call.input as { a: number; b: number }
        return { status: 'ok', content: [{ type: 'text', text: String(a + b) }] }
      },
    },
  })
  const events: RuntimeEvent[] = []
  let textDeltas = 0
  session.onEvent((event) => {
    events.push(structuredClone(event))
    if (event.type === 'text.delta' && ++textDeltas === scenario.abortAfterTextDeltas) {
      void session.abort()
    }
  })
  try {
    await session.prompt({
      role: 'user',
      content: [{ type: 'text', text: scenario.prompt }],
      ts: 1,
    })
    return { events, toolCalls, history: session.exportHistory() }
  } finally {
    await session.dispose()
  }
}
