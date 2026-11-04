// @ts-check
/**
 * 被测目标：DeepSeek 官方接口，以及本地模型网关的三种接口格式（docs/dev/local-testing.md）。
 * 网关后端同样是 DeepSeek（deepseek-v4.1-flash，经反代），用来对比三种格式下 pi 的转换是否一致。
 *
 * Key 只从环境变量读取，不写入任何文件。
 */
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models'

const GATEWAY = process.env['NEXUS_GATEWAY_URL'] ?? 'http://127.0.0.1:3425'
const GATEWAY_MODEL = process.env['NEXUS_GATEWAY_MODEL'] ?? 'group/smart-split'

/** pi-ai 内置目录中的 DeepSeek V4.1 Flash（模型 id、兼容参数与思考等级映射都来自目录）。 */
const DEEPSEEK_FLASH = /** @type {any} */ (
  Object.values(DEEPSEEK_MODELS).find((m) => /** @type {any} */ (m).id === 'deepseek-flash')
)

/**
 * @typedef {object} Target
 * @property {string} id
 * @property {string} title
 * @property {string} lazy pi-ai 接口实现的模块
 * @property {string} factory
 * @property {string} keyEnv 读取 Key 的环境变量
 * @property {string} [defaultKey] 网关信任本机回环请求，Key 可填任意值
 * @property {() => any} model
 */

/** @param {Record<string, unknown>} fields */
const gatewayModel = (fields) => ({
  id: GATEWAY_MODEL,
  name: GATEWAY_MODEL,
  provider: 'nexus-spike',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  ...fields,
})

/** @type {Target[]} */
export const TARGETS = [
  {
    id: 'deepseek',
    title: 'DeepSeek 官方（openai 格式）',
    lazy: '@earendil-works/pi-ai/api/openai-completions.lazy',
    factory: 'openAICompletionsApi',
    keyEnv: 'DEEPSEEK_API_KEY',
    model: () => ({ ...DEEPSEEK_FLASH, provider: 'nexus-spike', maxTokens: 8_192 }),
  },
  {
    id: 'deepseek-anthropic',
    title: 'DeepSeek 官方（anthropic 格式）',
    lazy: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
    factory: 'anthropicMessagesApi',
    keyEnv: 'DEEPSEEK_API_KEY',
    model: () => ({
      id: DEEPSEEK_FLASH?.id ?? 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash (Anthropic)',
      api: 'anthropic-messages',
      provider: 'nexus-spike',
      baseUrl: 'https://api.deepseek.com/anthropic',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
  },
  {
    id: 'gateway-openai',
    title: '本地网关（openai 格式）',
    lazy: '@earendil-works/pi-ai/api/openai-completions.lazy',
    factory: 'openAICompletionsApi',
    keyEnv: 'NEXUS_GATEWAY_KEY',
    defaultKey: 'magpie',
    // 后端是 DeepSeek，但地址不含 deepseek.com，pi 不会自动识别，兼容参数按 DeepSeek 显式给出
    model: () =>
      gatewayModel({
        api: 'openai-completions',
        baseUrl: `${GATEWAY}/v1`,
        thinkingLevelMap: DEEPSEEK_FLASH?.thinkingLevelMap,
        compat: { ...DEEPSEEK_FLASH?.compat },
      }),
  },
  {
    id: 'gateway-anthropic',
    title: '本地网关（anthropic 格式）',
    lazy: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
    factory: 'anthropicMessagesApi',
    keyEnv: 'NEXUS_GATEWAY_KEY',
    defaultKey: 'magpie',
    model: () => gatewayModel({ api: 'anthropic-messages', baseUrl: GATEWAY }),
  },
  {
    id: 'gateway-gemini',
    title: '本地网关（gemini 格式）',
    lazy: '@earendil-works/pi-ai/api/google-generative-ai.lazy',
    factory: 'googleGenerativeAIApi',
    keyEnv: 'NEXUS_GATEWAY_KEY',
    defaultKey: 'magpie',
    model: () => gatewayModel({ api: 'google-generative-ai', baseUrl: `${GATEWAY}/v1beta` }),
  },
]

/** @param {Target} target */
export const apiKeyFor = (target) => process.env[target.keyEnv] || target.defaultKey
