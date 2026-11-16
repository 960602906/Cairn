/**
 * 宿主一侧的用户提问（`ask_user`）：工具流水线需要用户回答时，经 `host.question.request` 请主进程
 * 转给界面，等到用户回答才返回（没有超时）。
 *
 * 等待期间取消信号触发（用户停止、轮次中止、宿主退出）：发出 `host.question.cancelled`，主进程收起
 * 问题卡片；流水线随即按取消处理，不再等待请求的结果。
 */
import type { AskUserGate } from '@cairn/core'
import type { HostForMain, MainForHost, RpcEndpoint } from '@cairn/protocol'

export interface HostQuestionGateOptions {
  readonly endpoint: Pick<RpcEndpoint<typeof HostForMain, typeof MainForHost>, 'request' | 'emit'>
}

export function createHostQuestionGate(options: HostQuestionGateOptions): AskUserGate {
  const { endpoint } = options
  return {
    async ask(request) {
      const { questionId, signal } = request
      const cancel = () => endpoint.emit('host.question.cancelled', { questionId })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        return await endpoint.request(
          'host.question.request',
          {
            questionId,
            toolCallId: request.toolCallId,
            questions: [...request.questions],
          },
          { timeoutMs: 0 },
        )
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}
