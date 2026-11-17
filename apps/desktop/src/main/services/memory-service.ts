/**
 * 记忆写入（M7-03，ADR-0019）：宿主的 `remember` 工具在这里落库并记事件，用户经界面确认或忽略。
 *
 * - 写入方式由 Agent 定义决定：`never` 拒绝；`propose` 写入 `proposed` 并等用户确认；
 *   `auto` 只有在该 Agent 配置为 `auto` **且** 用户在设置里打开“允许 Agent 自动记忆”时才直接写入，
 *   否则退回 `propose`（默认关闭，见 `SettingsPatch.agentAutoMemory`）。
 * - 范围必须在 Agent 声明的 `memory.scopes` 里；项目记忆归属会话所在项目，会话记忆归属当前会话。
 * - 条目记录来源（运行与 Agent），事件写进事件日志：`memory.proposed`、`memory.accepted`、
 *   `memory.rejected`（M7-04 的删除也复用 `memory.deleted`）。
 *
 * 不依赖 Electron。
 */
import { randomUUID } from 'node:crypto'
import {
  RpcError,
  type AgentDefinition,
  type MemoryEntry,
  type MemoryScope,
  type MemoryStatus,
  type RunAgentRef,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'

export const MemoryErrorCode = {
  /** 条目不存在。 */
  NotFound: 'memory.not_found',
  /** Agent 没有开启记忆写入。 */
  Disabled: 'memory.disabled',
  /** 范围不在 Agent 声明的范围里。 */
  ScopeNotAllowed: 'memory.scope_not_allowed',
  /** 条目已经确认过，不能再次处理。 */
  AlreadyHandled: 'memory.already_handled',
} as const

export interface RememberParams {
  readonly sessionId: string
  readonly runId: string
  readonly agent: RunAgentRef
  readonly scope: MemoryScope
  readonly content: string
}

export interface RespondMemoryParams {
  readonly sessionId: string
  readonly memoryId: string
  readonly action: 'accept' | 'reject'
}

export interface RememberedMemory {
  readonly memoryId: string
  readonly status: 'proposed' | 'active'
}

export interface ListMemoriesParams {
  readonly scope?: MemoryScope | undefined
  readonly status?: MemoryStatus | undefined
}

export interface UpdateMemoryParams {
  readonly memoryId: string
  readonly content: string
}

export interface DeleteMemoryParams {
  readonly memoryId: string
  /** 从某个会话的管理面板删除时给出：事件记到这个会话，卡片随之消失。 */
  readonly sessionId?: string | undefined
}

export interface MemoryServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'memories'>
  readonly events: Pick<SessionEventService, 'publish'>
  readonly definition: (agent: RunAgentRef) => AgentDefinition | undefined
  /** 设置里是否打开“允许 Agent 自动记忆”；默认关闭。 */
  readonly autoWriteEnabled: () => boolean
  readonly createId?: () => string
  readonly now?: () => number
}

export interface MemoryService {
  /** 按 Agent 的策略提议或直接写入；`never` 与不允许的范围报错。 */
  remember(params: RememberParams): RememberedMemory
  /** 用户确认或忽略一条提议。已经确认过的条目再次确认时什么也不做。 */
  respond(params: RespondMemoryParams): Record<string, never>
  /** 管理界面：列出全部条目，可按范围与状态筛选（M7-04）。 */
  list(params?: ListMemoriesParams): { readonly entries: MemoryEntry[] }
  /** 管理界面：编辑正文，更新时间随之变化。 */
  update(params: UpdateMemoryParams): { readonly entry: MemoryEntry }
  /** 管理界面：删除条目；会话上下文里的删除会让提议卡片一起消失。 */
  remove(params: DeleteMemoryParams): Record<string, never>
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const createId = options.createId ?? randomUUID
  const now = options.now ?? Date.now

  return {
    remember({ sessionId, runId, agent, scope, content }) {
      const policy = options.definition(agent)?.memory
      if (!policy || policy.write === 'never') {
        throw new RpcError(MemoryErrorCode.Disabled, { agentId: agent.id })
      }
      if (!policy.scopes.includes(scope)) {
        throw new RpcError(MemoryErrorCode.ScopeNotAllowed, {
          scope,
          scopes: policy.scopes.join(','),
        })
      }
      const session = options.storage.sessions.get(sessionId)
      if (!session) throw new RpcError('storage.not_found', { sessionId })
      const memoryId = createId()
      options.storage.memories.propose({
        memoryId,
        scope,
        content: content.trim(),
        ...(scope === 'session' ? { sessionId } : {}),
        ...(scope === 'project' ? { projectId: session.projectId } : {}),
        sourceRunId: runId,
        sourceAgentId: agent.id,
      })
      const auto = policy.write === 'auto' && options.autoWriteEnabled()
      if (auto) {
        options.storage.memories.confirm(memoryId)
        options.events.publish([
          {
            v: 1,
            sessionId,
            runId,
            ts: now(),
            type: 'memory.accepted',
            payload: { memoryId, scope, content: content.trim(), origin: 'auto' },
          },
        ])
        return { memoryId, status: 'active' }
      }
      options.events.publish([
        {
          v: 1,
          sessionId,
          runId,
          ts: now(),
          type: 'memory.proposed',
          payload: { memoryId, scope, content: content.trim(), sourceAgentId: agent.id },
        },
      ])
      return { memoryId, status: 'proposed' }
    },

    list({ scope, status } = {}) {
      return {
        entries: options.storage.memories.listAll({
          ...(scope === undefined ? {} : { scope }),
          ...(status === undefined ? {} : { status }),
        }),
      }
    },

    update({ memoryId, content }) {
      if (!options.storage.memories.get(memoryId)) {
        throw new RpcError(MemoryErrorCode.NotFound, { memoryId })
      }
      return { entry: options.storage.memories.update(memoryId, content) }
    },

    remove({ memoryId, sessionId }) {
      const existing = options.storage.memories.get(memoryId)
      if (!existing) throw new RpcError(MemoryErrorCode.NotFound, { memoryId })
      const entry = options.storage.memories.delete(memoryId)
      // 会话范围的条目知道自己在哪个会话；项目与全局条目没有会话，只能改存储。
      const target = sessionId ?? (entry.scope === 'session' ? entry.sessionId : undefined)
      if (target !== undefined) {
        options.events.publish([
          {
            v: 1,
            sessionId: target,
            runId: entry.sourceRunId ?? target,
            ts: now(),
            type: 'memory.deleted',
            payload: { memoryId, scope: entry.scope },
          },
        ])
      }
      return {}
    },

    respond({ sessionId, memoryId, action }) {
      const entry = options.storage.memories.get(memoryId)
      if (!entry) throw new RpcError(MemoryErrorCode.NotFound, { memoryId })
      // 入口只能处理还没确认的提议；已经确认的再点一次是界面重复提交，不算错误。
      if (entry.status === 'active') {
        if (action === 'accept') return {}
        throw new RpcError(MemoryErrorCode.AlreadyHandled, { memoryId })
      }
      // 事件属于提议它的那一轮；旧条目没有来源运行时退回会话 id（与检查点事件的做法一致）。
      const runId = entry.sourceRunId ?? sessionId
      if (action === 'accept') {
        options.storage.memories.confirm(memoryId)
        options.events.publish([
          {
            v: 1,
            sessionId,
            runId,
            ts: now(),
            type: 'memory.accepted',
            payload: { memoryId, scope: entry.scope, content: entry.content, origin: 'propose' },
          },
        ])
        return {}
      }
      options.storage.memories.delete(memoryId)
      options.events.publish([
        {
          v: 1,
          sessionId,
          runId,
          ts: now(),
          type: 'memory.rejected',
          payload: { memoryId },
        },
      ])
      return {}
    },
  }
}
