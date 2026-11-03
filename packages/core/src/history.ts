/**
 * 从持久化事件重建 `CanonicalMessage[]` 历史（架构 §8.4；Runtime §13.2）。
 *
 * 用于恢复：宿主重启后，主进程把某个运行的历史经 `host.init` 交给 `AgentRuntime` 继续对话。
 *
 * 规则：
 * - 只取指定运行的事件；按 seq 去重（seq 不大于已处理的最大值时忽略），增量事件忽略。
 * - 用户消息、助手完成消息按出现顺序转换。
 * - 工具结果按到达顺序紧跟在发出调用的助手消息之后：`tool.completed` → `ok`，`tool.failed` → `error`，
 *   `tool.cancelled` → `cancelled`，审批被拒绝 → `denied`，审批被取消 → `cancelled`。
 *   同一调用只取第一个结果；不属于待决调用的结果忽略。
 * - 遇到下一条用户或助手消息、轮次结束或事件结束时，仍未得到结果的工具调用补一条 `unknown` 结果
 *   （执行中被中断，结果未知）。不会让模型重新执行这些调用（Runtime §13.2）。
 *   这样每个工具调用都恰好有一个结果，满足各家接口"调用必须配对"的要求。
 */
import {
  isPersistedEvent,
  type CanonicalMessage,
  type ContentPart,
  type ErrorInfo,
  type EventEnvelope,
  type ToolCall,
} from '@nexus/protocol'

type ToolStatus = Extract<CanonicalMessage, { role: 'tool' }>['status']

/** 被中断的工具调用的结果文本（发给模型，因此用英文）。 */
export const INTERRUPTED_TOOL_RESULT_TEXT =
  'This tool call was interrupted while running and its result is unknown. ' +
  'Check the current state before retrying it.'

export interface RebuildHistoryOptions {
  /** 只重建该运行的历史。 */
  readonly runId: string
}

export function rebuildHistory(
  events: Iterable<EventEnvelope>,
  { runId }: RebuildHistoryOptions,
): CanonicalMessage[] {
  const history: CanonicalMessage[] = []
  /** 最近一条助手消息中尚未得到结果的调用，按调用顺序。 */
  let pending: ToolCall[] = []
  /** 审批 id → 工具调用 id。 */
  const approvals = new Map<string, string>()
  let lastSeq = 0
  let lastTs = 0

  const resolve = (toolCallId: string, status: ToolStatus, content: ContentPart[], ts: number) => {
    const index = pending.findIndex((call) => call.id === toolCallId)
    if (index === -1) return
    pending = pending.filter((_, i) => i !== index)
    history.push({ role: 'tool', toolCallId, content, status, ts })
  }

  const flush = (ts: number) => {
    for (const call of pending) {
      history.push({
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: INTERRUPTED_TOOL_RESULT_TEXT }],
        status: 'unknown',
        ts,
      })
    }
    pending = []
  }

  for (const event of events) {
    if (event.runId !== runId || !isPersistedEvent(event) || event.seq <= lastSeq) continue
    lastSeq = event.seq
    lastTs = event.ts

    switch (event.type) {
      case 'message.user':
        flush(event.ts)
        history.push({ role: 'user', content: event.payload.content, ts: event.ts })
        break
      case 'message.assistant.completed': {
        // 被打断的部分回复只用于显示（运行时自己的历史中也没有它）
        if (event.payload.incomplete) break
        flush(event.ts)
        const { content, reasoning, toolCalls, model } = event.payload
        history.push({
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
          model,
          ts: event.ts,
        })
        pending = [...(toolCalls ?? [])]
        break
      }
      case 'tool.completed':
        resolve(event.payload.toolCallId, 'ok', event.payload.output, event.ts)
        break
      case 'tool.failed':
        resolve(event.payload.toolCallId, 'error', [errorText(event.payload.error)], event.ts)
        break
      case 'tool.cancelled':
        resolve(
          event.payload.toolCallId,
          'cancelled',
          [{ type: 'text', text: `Tool call cancelled (${event.payload.reason}).` }],
          event.ts,
        )
        break
      case 'approval.requested':
        approvals.set(event.payload.approvalId, event.payload.toolCallId)
        break
      case 'approval.resolved': {
        const toolCallId = approvals.get(event.payload.approvalId)
        const { decision, feedback } = event.payload
        if (toolCallId === undefined) break
        if (decision === 'deny') {
          const text = feedback
            ? `The user denied this tool call: ${feedback}`
            : 'The user denied this tool call.'
          resolve(toolCallId, 'denied', [{ type: 'text', text }], event.ts)
        } else if (decision === 'cancelled') {
          resolve(
            toolCallId,
            'cancelled',
            [{ type: 'text', text: 'The approval request was cancelled.' }],
            event.ts,
          )
        }
        break
      }
      case 'turn.completed':
      case 'turn.aborted':
      case 'turn.failed':
        flush(event.ts)
        break
      default:
        break
    }
  }
  flush(lastTs)
  return history
}

function errorText(error: ErrorInfo): ContentPart {
  const params = error.params ? ` ${JSON.stringify(error.params)}` : ''
  return { type: 'text', text: `Tool call failed: ${error.code}${params}` }
}
