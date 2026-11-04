/**
 * 宿主选择运行时（M1-01d）。
 *
 * - `NEXUS_RUNTIME=pi`：pi 适配器（`@nexus/runtime-pi`）。模型由环境变量给出：
 *   `NEXUS_MODEL_KIND`（openai / anthropic / gemini）、`NEXUS_MODEL_BASE_URL`、可选的
 *   `NEXUS_MODEL_ID`（默认用 `host.init` 中的模型 id）、`NEXUS_MODEL_API_KEY`、`NEXUS_MODEL_REASONING=1`。
 * - 其他（默认）：FakeRuntime，单元测试、界面开发与端到端测试使用。
 *
 * 环境变量只是 M1-03（凭据服务）与 M1-04（提供方配置）完成之前的开发入口：之后模型配置与凭据
 * 由主进程经 `host.init` 传入，这里改为按配置构造 `ResolvedModel`。Key 不写入任何文件或日志。
 */
import type { ProviderKind, ResolvedModel } from '@nexus/core'
import type { ModelRef } from '@nexus/protocol'
import { PiRuntime } from '@nexus/runtime-pi'
import { createFakeHostRuntime } from './fake-model.js'
import type { HostRuntime } from './host.js'

export const RUNTIME_ENV = 'NEXUS_RUNTIME'
export const MODEL_ENV = {
  kind: 'NEXUS_MODEL_KIND',
  baseUrl: 'NEXUS_MODEL_BASE_URL',
  id: 'NEXUS_MODEL_ID',
  apiKey: 'NEXUS_MODEL_API_KEY',
  reasoning: 'NEXUS_MODEL_REASONING',
} as const

type Env = Readonly<Record<string, string | undefined>>

const KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'gemini']

export function runtimeKind(env: Env): 'pi' | 'fake' {
  return env[RUNTIME_ENV] === 'pi' ? 'pi' : 'fake'
}

/** 由环境变量得到 pi 使用的模型；配置不完整时抛出，`host.init` 因此失败。 */
export function modelFromEnv(ref: ModelRef, env: Env): ResolvedModel {
  const kind = env[MODEL_ENV.kind]
  const baseUrl = env[MODEL_ENV.baseUrl]
  if (!KINDS.includes(kind as ProviderKind)) {
    throw new Error(`${MODEL_ENV.kind} must be one of ${KINDS.join(', ')}`)
  }
  if (!baseUrl) throw new Error(`${MODEL_ENV.baseUrl} is required`)
  const apiKey = env[MODEL_ENV.apiKey]
  return {
    ref: { providerId: ref.providerId, modelId: env[MODEL_ENV.id] || ref.modelId },
    providerKind: kind as ProviderKind,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    profile: {
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: env[MODEL_ENV.reasoning] === '1',
    },
  }
}

export function selectHostRuntime(env: Env): (ref: ModelRef) => HostRuntime {
  if (runtimeKind(env) === 'fake') return (ref) => createFakeHostRuntime(ref)
  return (ref) => ({ runtime: new PiRuntime(), model: modelFromEnv(ref, env) })
}
