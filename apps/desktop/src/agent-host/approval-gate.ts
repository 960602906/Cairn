/**
 * 宿主一侧的审批（M1-11a，架构 §10.4，Runtime §7）：工具流水线需要审批时，经 `host.approval.request`
 * 请主进程转给界面，等到用户决定才返回（没有超时）。
 *
 * - 等待期间取消信号触发（用户停止、轮次中止、宿主退出）：发出 `host.approval.cancelled`，主进程收起
 *   审批卡片；流水线随即按取消处理，不再等待请求的结果。
 * - 用户选择“本会话 / 本项目始终允许”时，主进程保存生成的规则并在结果中给出，交给 `onRule` 立即生效。
 */
import type { ApprovalGate, ApprovalResponse } from '@cairn/core'
import type {
  HostForMain,
  MainForHost,
  PermissionRule,
  RunAgentRef,
  RpcEndpoint,
} from '@cairn/protocol'

/** 审批的归属（M4-03）：哪个运行、哪个 Agent 发起的调用。 */
export interface HostApprovalAttribution {
  readonly runId: string
  readonly parentRunId?: string
  readonly agent: RunAgentRef
}

export interface HostApprovalGateOptions {
  readonly endpoint: Pick<RpcEndpoint<typeof HostForMain, typeof MainForHost>, 'request' | 'emit'>
  /** 审批生成的规则（本会话 / 本项目始终允许）。 */
  readonly onRule: (rule: PermissionRule) => void
  /** 这个流水线所属的运行与 Agent；每次请求时读取。 */
  readonly attribution: () => HostApprovalAttribution
}

export function createHostApprovalGate(options: HostApprovalGateOptions): ApprovalGate {
  const { endpoint } = options
  return {
    async request(request) {
      const { approvalId, signal } = request
      const cancel = () => endpoint.emit('host.approval.cancelled', { approvalId })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const attribution = options.attribution()
        const response = await endpoint.request(
          'host.approval.request',
          {
            approvalId,
            toolCallId: request.toolCallId,
            runId: attribution.runId,
            ...(attribution.parentRunId ? { parentRunId: attribution.parentRunId } : {}),
            agent: attribution.agent,
            tool: { name: request.definition.name, category: request.definition.category },
            input: request.input,
            targets: {
              ...(request.targets.paths ? { paths: [...request.targets.paths] } : {}),
              ...(request.targets.command !== undefined
                ? { command: request.targets.command }
                : {}),
            },
            kind: request.kind,
            ...(request.definition.sandbox ? { sandbox: request.definition.sandbox } : {}),
            ...(request.overridable === false ? { overridable: false } : {}),
            ...(request.preview ? { preview: { ...request.preview } } : {}),
            reasonCode: request.reasonCode,
            matchedRuleIds: [...request.matchedRuleIds],
          },
          { timeoutMs: 0 },
        )
        if (response.rule) options.onRule(response.rule)
        const result: ApprovalResponse = {
          decision: response.decision,
          ...(response.feedback ? { feedback: response.feedback } : {}),
        }
        return result
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}
