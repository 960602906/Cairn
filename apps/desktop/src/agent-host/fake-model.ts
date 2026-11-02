/**
 * M0 的运行时：FakeRuntime（ADR-0004）。没有脚本时原样回复用户输入，逐字流式输出，
 * 便于在界面中看到增量效果。真实模型（pi 适配器）在 M1 接入。
 */
import { FakeRuntime, type FakeScript, type ResolvedModel } from '@nexus/core'
import type { ModelRef } from '@nexus/protocol'
import type { HostRuntime } from './host.js'

/** 默认脚本：回显输入，每个字符间隔 15 ms。 */
export const DEFAULT_FAKE_SCRIPT: FakeScript = { turns: [], chunkSize: 1, delayMs: 15 }

export function fakeModel(ref: ModelRef): ResolvedModel {
  return {
    ref,
    providerKind: 'openai',
    baseUrl: '',
    profile: {
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsReasoning: false,
    },
  }
}

export function createFakeHostRuntime(
  ref: ModelRef,
  script: FakeScript = DEFAULT_FAKE_SCRIPT,
): HostRuntime {
  return { runtime: new FakeRuntime(script), model: fakeModel(ref) }
}
