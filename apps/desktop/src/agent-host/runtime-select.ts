/**
 * 宿主选择运行时（M1-01d、M1-04b）。按顺序：
 *
 * 1. `host.init` 带有模型配置（主进程按提供方配置给出，M1-04b）：pi 适配器（`@nexus/runtime-pi`），
 *    模型由配置与 `host.init` 的凭据构造。
 * 2. `NEXUS_RUNTIME=pi`：pi 适配器，模型由环境变量给出（开发与冒烟测试用，打包后的应用不传入）：
 *    `NEXUS_MODEL_KIND`（openai / anthropic / gemini）、`NEXUS_MODEL_BASE_URL`、可选的
 *    `NEXUS_MODEL_ID`（默认用 `host.init` 中的模型 id）、`NEXUS_MODEL_REASONING=1`。
 *    Key 优先用 `host.init` 带来的凭据；没有时才用 `NEXUS_MODEL_API_KEY`。
 * 3. 其他：FakeRuntime，单元测试、界面开发与端到端测试使用（没有配置模型的会话）。
 *
 * Key 不写入任何文件或日志。
 */
import { resolveModel, type ProviderKind, type ResolvedModel } from '@nexus/core'
import type { HostModelConfig, ModelRef } from '@nexus/protocol'
import { PiRuntime } from '@nexus/runtime-pi'
import { createFakeHostRuntime } from './fake-model.js'
import type { HostCredential, HostRuntime } from './host.js'

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
export function modelFromEnv(ref: ModelRef, env: Env, credential?: HostCredential): ResolvedModel {
  const kind = env[MODEL_ENV.kind]
  const baseUrl = env[MODEL_ENV.baseUrl]
  if (!KINDS.includes(kind as ProviderKind)) {
    throw new Error(`${MODEL_ENV.kind} must be one of ${KINDS.join(', ')}`)
  }
  if (!baseUrl) throw new Error(`${MODEL_ENV.baseUrl} is required`)
  const apiKey = credential?.apiKey ?? env[MODEL_ENV.apiKey]
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

export function selectHostRuntime(
  env: Env,
): (ref: ModelRef, credential?: HostCredential, modelConfig?: HostModelConfig) => HostRuntime {
  return (ref, credential, modelConfig) => {
    if (modelConfig) {
      return { runtime: new PiRuntime(), model: resolveModel(ref, modelConfig, credential?.apiKey) }
    }
    if (runtimeKind(env) === 'fake') return createFakeHostRuntime(ref)
    return { runtime: new PiRuntime(), model: modelFromEnv(ref, env, credential) }
  }
}
