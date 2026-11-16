/**
 * 用户提问（`ask_user`）：宿主的 `host.question.request` 在这里等待界面上回答。
 *
 * 与审批一样，未决提问只在内存中：宿主取消（`host.question.cancelled`）、宿主退出或崩溃时由监督器
 * 取消；应用重启后运行被标记为中断，提问不再恢复。
 *
 * 界面经 `question.pending` 读取会话中的未决提问，经 `question.resolve` 回答；未决提问变化时通知
 * 订阅者（网关推送 `question.changed`）。
 *
 * 不依赖 Electron。
 */
import {
  RpcError,
  type AskUserAnswer,
  type AskUserRequest,
  type AskUserResponse,
} from '@cairn/protocol'

export const QuestionErrorCode = {
  /** 提问不存在或已结束。 */
  NotFound: 'question.not_found',
  /** 提问被取消（宿主停止或退出）。 */
  Cancelled: 'question.cancelled',
} as const

export interface QuestionServiceOptions {
  readonly now?: () => number
}

export interface ResolveQuestionParams {
  readonly sessionId: string
  readonly questionId: string
  readonly answers: readonly AskUserAnswer[]
}

export interface PendingQuestionEntry {
  readonly sessionId: string
  readonly requestedAt: number
  readonly request: AskUserRequest
}

export interface QuestionService {
  /** 等待用户回答；被取消时以 `question.cancelled` 失败。 */
  request(sessionId: string, request: AskUserRequest): Promise<AskUserResponse>
  /** 宿主取消了提问；不存在时什么也不做。 */
  cancel(sessionId: string, questionId: string): void
  /** 会话中的未决提问，按请求顺序。 */
  pending(params: { sessionId: string }): { questions: AskUserRequest[] }
  /** 所有会话中的未决提问，按请求顺序。 */
  list(): PendingQuestionEntry[]
  resolve(params: ResolveQuestionParams): Record<string, never>
  /** 会话的未决提问有变化时调用；返回取消函数。 */
  subscribe(listener: (sessionId: string) => void): () => void
}

interface Pending {
  readonly sessionId: string
  readonly requestedAt: number
  readonly request: AskUserRequest
  readonly resolve: (response: AskUserResponse) => void
  readonly reject: (error: unknown) => void
}

export function createQuestionService(options: QuestionServiceOptions = {}): QuestionService {
  const now = options.now ?? Date.now
  /** 按请求顺序（Map 保持插入顺序）。 */
  const pending = new Map<string, Pending>()
  const listeners = new Set<(sessionId: string) => void>()
  const changed = (sessionId: string) => {
    for (const listener of [...listeners]) listener(sessionId)
  }

  const take = (sessionId: string, questionId: string): Pending | undefined => {
    const entry = pending.get(questionId)
    return entry && entry.sessionId === sessionId ? entry : undefined
  }

  return {
    request(sessionId, request) {
      return new Promise<AskUserResponse>((resolve, reject) => {
        // 同一 id 重复请求：先取消之前的
        pending.get(request.questionId)?.reject(new RpcError(QuestionErrorCode.Cancelled))
        pending.set(request.questionId, {
          sessionId,
          requestedAt: now(),
          request,
          resolve,
          reject,
        })
        changed(sessionId)
      })
    },

    cancel(sessionId, questionId) {
      const entry = take(sessionId, questionId)
      if (!entry) return
      pending.delete(questionId)
      entry.reject(new RpcError(QuestionErrorCode.Cancelled, { questionId }))
      changed(sessionId)
    },

    pending: ({ sessionId }) => ({
      questions: [...pending.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.request),
    }),

    list: () =>
      [...pending.values()].map((entry) => ({
        sessionId: entry.sessionId,
        requestedAt: entry.requestedAt,
        request: entry.request,
      })),

    resolve({ sessionId, questionId, answers }) {
      const entry = take(sessionId, questionId)
      if (!entry) throw new RpcError(QuestionErrorCode.NotFound, { questionId })
      pending.delete(questionId)
      entry.resolve({ answers: [...answers] })
      changed(sessionId)
      return {}
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
