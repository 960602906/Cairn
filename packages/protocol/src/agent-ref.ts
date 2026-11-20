/**
 * Agent 引用的判定（从 `common.ts` 拆出）：渲染进程多处用到，但不该为此加载 zod。
 * 只依赖类型，运行时没有依赖。
 */
import type { AgentDraftRef, RunAgentRef } from './common.js'

export const isAgentDraftRef = (agent: RunAgentRef): agent is AgentDraftRef => 'draftHash' in agent
