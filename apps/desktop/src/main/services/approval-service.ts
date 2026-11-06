/**
 * 审批（M1-11b，架构 §10.4，Runtime §7）：宿主的 `host.approval.request` 在这里等待用户在界面上决定。
 *
 * - 未决审批只在内存中：宿主取消（`host.approval.cancelled`）、宿主退出或崩溃时由监督器取消；应用重启后
 *   运行被标记为中断，审批不再恢复（架构 §10.4）。
 * - 界面经 `approval.pending` 读取会话中的未决审批，经 `approval.resolve` 决定；未决审批变化时通知
 *   订阅者（网关推送 `approval.changed`）。
 * - “本会话 / 本项目始终允许”：按请求的工具与目标生成规则（`approvalRule`：路径与命令按字面记录，
 *   命令按段），经权限服务保存，在结果中交给宿主立即生效，并通知其他运行中的宿主（`onRuleAdded`）。
 *   保存失败时审批保持未决，界面显示错误，用户可以改选“允许一次”。
 *
 * 不依赖 Electron。
 */
import { randomUUID } from 'node:crypto'
import { approvalRule } from '@cairn/core'
import {
  RpcError,
  type ApprovalDecision,
  type HostApprovalRequest,
  type HostApprovalResponse,
  type PermissionRule,
} from '@cairn/protocol'
import type { PermissionService } from './permission-service.js'

export const ApprovalErrorCode = {
  /** 审批不存在或已结束。 */
  NotFound: 'approval.not_found',
  /** 审批被取消（宿主停止或退出）。 */
  Cancelled: 'approval.cancelled',
} as const

export interface ApprovalServiceOptions {
  readonly permissions: Pick<PermissionService, 'addRule'>
  /** 新规则保存之后调用（通知运行中的宿主）。 */
  readonly onRuleAdded?: (sessionId: string, rule: PermissionRule) => void
  readonly createId?: () => string
}

export interface ResolveApprovalParams {
  readonly sessionId: string
  readonly approvalId: string
  readonly decision: ApprovalDecision
  readonly feedback?: string | undefined
}

export interface ApprovalService {
  /** 等待用户决定；被取消时以 `approval.cancelled` 失败。 */
  request(
    sessionId: string,
    runId: string,
    request: HostApprovalRequest,
  ): Promise<HostApprovalResponse>
  /** 宿主取消了审批；不存在时什么也不做。 */
  cancel(sessionId: string, approvalId: string): void
  /** 会话中的未决审批，按请求顺序。 */
  pending(params: { sessionId: string }): { approvals: HostApprovalRequest[] }
  resolve(params: ResolveApprovalParams): Record<string, never>
  /** 会话的未决审批有变化时调用；返回取消函数。 */
  subscribe(listener: (sessionId: string) => void): () => void
}

interface Pending {
  readonly sessionId: string
  readonly request: HostApprovalRequest
  readonly resolve: (response: HostApprovalResponse) => void
  readonly reject: (error: unknown) => void
}

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const createId = options.createId ?? randomUUID
  /** 按请求顺序（Map 保持插入顺序）。 */
  const pending = new Map<string, Pending>()
  const listeners = new Set<(sessionId: string) => void>()
  const changed = (sessionId: string) => {
    for (const listener of [...listeners]) listener(sessionId)
  }

  const take = (sessionId: string, approvalId: string): Pending | undefined => {
    const entry = pending.get(approvalId)
    return entry && entry.sessionId === sessionId ? entry : undefined
  }

  return {
    request(sessionId, _runId, request) {
      return new Promise<HostApprovalResponse>((resolve, reject) => {
        // 同一 id 重复请求：先取消之前的
        pending.get(request.approvalId)?.reject(new RpcError(ApprovalErrorCode.Cancelled))
        pending.set(request.approvalId, { sessionId, request, resolve, reject })
        changed(sessionId)
      })
    },

    cancel(sessionId, approvalId) {
      const entry = take(sessionId, approvalId)
      if (!entry) return
      pending.delete(approvalId)
      entry.reject(new RpcError(ApprovalErrorCode.Cancelled, { approvalId }))
      changed(sessionId)
    },

    pending: ({ sessionId }) => ({
      approvals: [...pending.values()]
        .filter((p) => p.sessionId === sessionId)
        .map((p) => p.request),
    }),

    resolve({ sessionId, approvalId, decision, feedback }) {
      const entry = take(sessionId, approvalId)
      if (!entry) throw new RpcError(ApprovalErrorCode.NotFound, { approvalId })
      let rule: PermissionRule | undefined
      if (decision === 'allow_session' || decision === 'allow_project') {
        // 保存失败时抛出，审批保持未决
        rule = options.permissions.addRule(
          sessionId,
          approvalRule({
            id: createId(),
            scope: decision === 'allow_session' ? 'session' : 'project',
            definition: { name: entry.request.tool.name },
            targets: {
              ...(entry.request.targets.paths ? { paths: entry.request.targets.paths } : {}),
              ...(entry.request.targets.command !== undefined
                ? { command: entry.request.targets.command }
                : {}),
            },
          }),
        )
      }
      pending.delete(approvalId)
      entry.resolve({
        decision,
        ...(decision === 'deny' && feedback ? { feedback } : {}),
        ...(rule ? { rule } : {}),
      })
      changed(sessionId)
      if (rule) options.onRuleAdded?.(sessionId, rule)
      return {}
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
