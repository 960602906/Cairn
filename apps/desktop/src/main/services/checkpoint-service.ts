/**
 * 检查点的列表、预览与恢复（M1-12c；ADR-0008；架构 §11.3）。实现 IPC 网关的 `CheckpointCommands`。
 *
 * - **列表**（`checkpoint.list`）：由会话的 `checkpoint.created` 事件得出，按创建顺序。
 * - **预览**（`checkpoint.preview`）：先建检查点，返回恢复将改动的文件，不改动工作区。
 * - **恢复**（`checkpoint.restore`）：先建检查点并写入 `checkpoint.created`（`before_restore`，恢复到它
 *   即可撤销这次恢复），再改写工作区并写入 `checkpoint.restored`。对话不截断（M1 不提供）。
 *
 * 恢复后，本会话在这个检查点之后记录的、仍然有效的文件改动（`file.changed` 晚于该检查点的
 * `checkpoint.created`）标记为 `reverted`（M2-07）：文件已经回到检查点时的内容，本轮变更与顶栏摘要不再
 * 列出它们，也不能再整文件撤销。撤销这次恢复（恢复到 `before_restore`）不会把它们重新标记为有效（M2-08
 * 提供撤销恢复时一并处理）。
 *
 * 只能预览与恢复这个会话自己的检查点（同一项目的会话共用影子仓库，对象互相可见）。同一项目有会话正在运行
 * （或正在撤销改动、恢复检查点）时拒绝，因为它们改动的是同一个工作区；恢复期间会话不接受输入
 * （`isRestoring`）。
 *
 * 在主进程中执行，不启动宿主：启动宿主需要模型凭据，恢复与模型无关。宿主中的影子仓库每次创建检查点前
 * 重新读取引用，主进程在同一引用上创建的检查点不会让它失效。
 */
import { CheckpointError, type ShadowRepo, type ShadowRepoOptions } from '@cairn/checkpoint'
import {
  RpcError,
  type CheckpointRestorePlan,
  type CheckpointSummary,
  type ErrorInfo,
} from '@cairn/protocol'
import type { Storage } from '@cairn/storage'
import type { SessionEventService } from './event-service.js'
import type { HostCheckpointLocation } from './host-supervisor.js'

export const CheckpointServiceErrorCode = {
  /** 会话不存在，或检查点不属于该会话。 */
  NotFound: 'checkpoint.not_found',
  /** 同一项目有会话正在运行、撤销改动或恢复检查点。 */
  Busy: 'run.busy',
} as const

export type OpenCheckpointRepo = (
  options: ShadowRepoOptions,
) => Promise<Pick<ShadowRepo, 'preview' | 'restore'>>

export interface CheckpointServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'changes'>
  readonly events: Pick<SessionEventService, 'publish' | 'readAfter'>
  /** 会话的检查点位置（与宿主相同，`checkpoint-location.ts`）；没有时会话没有检查点。 */
  readonly location: (sessionId: string) => HostCheckpointLocation | undefined
  /** 打开影子仓库（`@cairn/checkpoint` 的 `openShadowRepo`）。 */
  readonly open: OpenCheckpointRepo
  /** 会话是否正在运行或撤销改动（会话管理器与改动服务提供）。 */
  readonly isBusy: (sessionId: string) => boolean
  readonly now?: () => number
}

export interface CheckpointService {
  list(params: { sessionId: string }): { checkpoints: CheckpointSummary[] }
  preview(params: { sessionId: string; checkpointId: string }): Promise<CheckpointRestorePlan>
  restore(params: { sessionId: string; checkpointId: string }): Promise<CheckpointRestorePlan>
  /** 会话所属项目是否正在恢复检查点（期间不接受新的输入，也不能撤销改动）。 */
  isRestoring(sessionId: string): boolean
}

/** `@cairn/checkpoint` 的错误交给界面时保留错误码与参数。 */
function toRpcError(error: unknown): unknown {
  if (!(error instanceof CheckpointError)) return error
  const params: ErrorInfo['params'] = { ...error.params }
  return new RpcError(error.code, params)
}

export function createCheckpointService(options: CheckpointServiceOptions): CheckpointService {
  const { storage, events } = options
  const now = options.now ?? Date.now
  /** 正在预览或恢复的项目。 */
  const working = new Set<string>()

  const requireSession = (sessionId: string) => {
    const session = storage.sessions.get(sessionId)
    if (!session) throw new RpcError(CheckpointServiceErrorCode.NotFound, { sessionId })
    return session
  }

  function list(sessionId: string): CheckpointSummary[] {
    requireSession(sessionId)
    if (!options.location(sessionId)) return []
    const out: CheckpointSummary[] = []
    for (const event of events.readAfter(sessionId, 0)) {
      if (event.type !== 'checkpoint.created') continue
      out.push({
        checkpointId: event.payload.checkpointId,
        reason: event.payload.reason,
        seq: event.seq,
        runId: event.runId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        createdAt: event.ts,
      })
    }
    return out
  }

  /** 核对后在项目上独占执行：预览与恢复都会在影子仓库中创建检查点。 */
  async function exclusive<T>(
    sessionId: string,
    checkpointId: string,
    task: (repo: Pick<ShadowRepo, 'preview' | 'restore'>) => Promise<T>,
  ): Promise<T> {
    const session = requireSession(sessionId)
    const location = options.location(sessionId)
    if (!location || !list(sessionId).some((c) => c.checkpointId === checkpointId)) {
      throw new RpcError(CheckpointServiceErrorCode.NotFound, { sessionId, checkpointId })
    }
    const siblings = storage.sessions
      .list({ includeArchived: true })
      .filter((s) => s.projectId === session.projectId)
      .map((s) => s.sessionId)
    if (working.has(session.projectId) || siblings.some((id) => options.isBusy(id))) {
      throw new RpcError(CheckpointServiceErrorCode.Busy, { sessionId })
    }
    working.add(session.projectId)
    try {
      const repo = await options.open({
        gitDir: location.gitDir,
        workTree: session.workspacePath,
        ref: location.ref,
      })
      return await task(repo)
    } catch (error) {
      throw toRpcError(error)
    } finally {
      working.delete(session.projectId)
    }
  }

  /** 检查点之后记录的有效改动随恢复撤销：标记为 `reverted`。 */
  function markRestored(sessionId: string, checkpointId: string) {
    let after: number | undefined
    const changed: string[] = []
    for (const event of events.readAfter(sessionId, 0)) {
      if (
        after === undefined &&
        event.type === 'checkpoint.created' &&
        event.payload.checkpointId === checkpointId
      ) {
        after = event.seq
      } else if (after !== undefined && event.type === 'file.changed') {
        changed.push(event.payload.changeId)
      }
    }
    for (const changeId of changed) {
      const change = storage.changes.get(changeId)
      if (change && change.status !== 'reverted' && change.revertOf === undefined) {
        storage.changes.setStatus(changeId, 'reverted')
      }
    }
  }

  const toPlan = (plan: Awaited<ReturnType<ShadowRepo['preview']>>): CheckpointRestorePlan => ({
    before: plan.before,
    files: plan.changes.map(({ path, status }) => ({ path, status })),
  })

  return {
    list: ({ sessionId }) => ({ checkpoints: list(sessionId) }),

    preview: ({ sessionId, checkpointId }) =>
      exclusive(sessionId, checkpointId, async (repo) => toPlan(await repo.preview(checkpointId))),

    restore: ({ sessionId, checkpointId }) =>
      exclusive(sessionId, checkpointId, async (repo) => {
        const plan = toPlan(await repo.restore(checkpointId))
        markRestored(sessionId, checkpointId)
        const header = { v: 1 as const, sessionId, runId: sessionId, ts: now() }
        events.publish([
          {
            ...header,
            type: 'checkpoint.created',
            payload: { checkpointId: plan.before, reason: 'before_restore' },
          },
          {
            ...header,
            type: 'checkpoint.restored',
            payload: { checkpointId, truncateConversation: false },
          },
        ])
        return plan
      }),

    isRestoring(sessionId) {
      const session = storage.sessions.get(sessionId)
      return session !== undefined && working.has(session.projectId)
    },
  }
}
