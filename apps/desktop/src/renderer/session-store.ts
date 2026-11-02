/**
 * 界面状态层（M0-15a，架构 §19、§22）：Zustand store 保存会话列表与各会话的事件投影。
 *
 * - **投影**：直接复用 `core` 的 `reduceSession`；持久化事件与实时增量都经它归约，seq 不大于
 *   `lastSeq` 的事件被忽略，因此补发与实时重叠时消息不重复。
 * - **订阅与恢复**：选中会话时 `session.subscribe(afterSeq)`，`afterSeq` 取已有投影的 `lastSeq`
 *   （首次或窗口刷新后为 0，从数据库补发）；订阅响应返回之前到达的实时事件先缓存，补发归约后再
 *   归约，避免补发的事件因 seq 较小被丢弃。同一时间只订阅当前会话，切走时取消订阅；投影保留，
 *   切回时只补发之后的事件。
 * - **动作**：刷新列表、新建会话、发送输入、停止。失败时把错误码写入 `error`，由界面经 i18n 显示。
 *
 * 不依赖 React 与 DOM，便于在 Node 中测试；组件通过 `useStore(store, selector)` 读取。
 */
import { createSessionView, reduceSession, sessionStatus, type SessionView } from '@nexus/core'
import {
  RpcError,
  type ContentPart,
  type ErrorInfo,
  type EventEnvelope,
  type SessionSummary,
} from '@nexus/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { MainApi } from './api.js'

export interface SessionState {
  /** 会话列表（按最近更新排序，由主进程决定）。 */
  readonly sessions: readonly SessionSummary[]
  /** 各会话的事件投影。 */
  readonly views: Readonly<Record<string, SessionView>>
  readonly activeSessionId: string | undefined
  /** 最近一次失败的错误；界面显示后可以清除。 */
  readonly error: ErrorInfo | undefined
}

export interface SessionActions {
  refreshSessions(): Promise<void>
  /** 新建会话并选中，返回会话 id；失败时返回 undefined。 */
  createSession(projectPath: string, title?: string): Promise<string | undefined>
  /** 选中会话并订阅其事件；传 undefined 取消选中。 */
  selectSession(sessionId: string | undefined): Promise<void>
  /** 向当前会话发送文本输入。 */
  sendPrompt(text: string): Promise<void>
  /** 停止当前会话正在进行的一轮。 */
  abort(): Promise<void>
  clearError(): void
  /** 取消订阅并停止接收事件。 */
  dispose(): void
}

export type SessionStore = StoreApi<SessionState & SessionActions>

const toError = (error: unknown): ErrorInfo =>
  error instanceof RpcError ? error.toInfo() : { code: 'unknown' }

/** 把事件归约进会话投影，并同步列表中的状态。 */
function reduceInto(
  state: SessionState,
  sessionId: string,
  events: readonly EventEnvelope[],
): Pick<SessionState, 'views' | 'sessions'> {
  let view = state.views[sessionId] ?? createSessionView(sessionId)
  for (const event of events) view = reduceSession(view, event)
  const status = sessionStatus(view)
  return {
    views: { ...state.views, [sessionId]: view },
    sessions: state.sessions.map((s) =>
      s.sessionId === sessionId && s.status !== status ? { ...s, status } : s,
    ),
  }
}

export function createSessionStore(api: MainApi): SessionStore {
  /** 正在等待订阅响应的会话 → 期间到达的实时事件。 */
  const pending = new Map<string, EventEnvelope[]>()
  /** 当前已订阅的会话（订阅响应已返回）。 */
  let subscribed: string | undefined

  const store = createStore<SessionState & SessionActions>()((set, get) => {
    const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action()
      } catch (error) {
        set({ error: toError(error) })
        return undefined
      }
    }

    const unsubscribe = async (sessionId: string) => {
      pending.delete(sessionId)
      if (subscribed === sessionId) subscribed = undefined
      await run(() => api.request('session.unsubscribe', { sessionId }))
    }

    return {
      sessions: [],
      views: {},
      activeSessionId: undefined,
      error: undefined,

      async refreshSessions() {
        const result = await run(() => api.request('session.list', {}))
        if (!result) return
        // 已订阅的会话以本地投影的状态为准（比列表请求更新）
        const { views } = get()
        set({
          sessions: result.sessions.map((s) => {
            const view = views[s.sessionId]
            return view && s.sessionId === subscribed ? { ...s, status: sessionStatus(view) } : s
          }),
        })
      },

      async createSession(projectPath, title) {
        const created = await run(() =>
          api.request(
            'session.create',
            title === undefined ? { projectPath } : { projectPath, title },
          ),
        )
        if (!created) return undefined
        await get().refreshSessions()
        await get().selectSession(created.sessionId)
        return created.sessionId
      },

      async selectSession(sessionId) {
        const previous = get().activeSessionId
        if (previous === sessionId) return
        set({ activeSessionId: sessionId })
        if (previous !== undefined) await unsubscribe(previous)
        if (sessionId === undefined) return
        pending.set(sessionId, [])
        const afterSeq = get().views[sessionId]?.lastSeq ?? 0
        const result = await run(() => api.request('session.subscribe', { sessionId, afterSeq }))
        const buffered = pending.get(sessionId)
        pending.delete(sessionId)
        // 等待期间已切到其他会话，或订阅失败
        if (!result || get().activeSessionId !== sessionId) {
          if (result) await unsubscribe(sessionId)
          return
        }
        subscribed = sessionId
        set((state) => reduceInto(state, sessionId, [...result.events, ...(buffered ?? [])]))
      },

      async sendPrompt(text) {
        const sessionId = get().activeSessionId
        const trimmed = text.trim()
        if (sessionId === undefined || trimmed === '') return
        const content: ContentPart[] = [{ type: 'text', text: trimmed }]
        await run(() => api.request('session.prompt', { sessionId, content }))
      },

      async abort() {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return
        await run(() => api.request('session.abort', { sessionId }))
      },

      clearError: () => set({ error: undefined }),

      dispose() {
        offEvents()
        pending.clear()
        subscribed = undefined
      },
    }
  })

  const offEvents = api.on('session.events', ({ sessionId, events }) => {
    const buffer = pending.get(sessionId)
    if (buffer) {
      buffer.push(...events)
      return
    }
    if (sessionId === subscribed) store.setState((state) => reduceInto(state, sessionId, events))
  })

  return store
}
