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
 * - **等待开始**：输入已发送、但这一轮还没开始（排队或宿主启动中）时，投影里还没有运行中的轮次；
 *   `awaitingTurn` 记下这段时间，界面与列表把会话当作运行中（可以停止、不能再发送）。收到
 *   `turn.started`（或该轮结束、会话崩溃）、发送失败或停止成功时清除。
 * - **事件记录**（开发模式的事件查看器，M0-15d）：`eventLogLimit` 大于 0 时按会话保存收到的原始
 *   事件（补发与实时推送，含增量），每个会话只保留最近的若干条，超出时先丢弃增量事件。默认不保存。
 * - **设置**：`loadSettings` 读取、`updateSettings` 保存设置，结果保存在 `settings`；失败时同样写入 `error`。
 *   Key 只能写入（`saveCredential`）与查询是否已保存（`credentialStatus`），没有读出明文的接口。
 * - **项目**（M1-16a）：`refreshProjects` 读取已打开过的项目；`openProject` 用系统对话框选择文件夹。
 * - **审批**（M1-11b）：当前会话的未决审批经 `approval.pending` 读取，订阅时与收到 `approval.changed`
 *   通知后重新读取；`resolveApproval` 作出决定（失败时写入 `error`，审批仍保留）。
 *
 * 不依赖 React 与 DOM，便于在 Node 中测试；组件通过 `useStore(store, selector)` 读取。
 */
import { createSessionView, reduceSession, sessionStatus, type SessionView } from '@nexus/core'
import {
  isPersistedEvent,
  RpcError,
  type ContentPart,
  type ApprovalDecision,
  type ErrorInfo,
  type EventEnvelope,
  type PendingApproval,
  type ProjectSummary,
  type SessionSummary,
  type Settings,
  type SettingsPatch,
} from '@nexus/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { MainApi } from './api.js'

export interface SessionState {
  /** 会话列表（按最近更新排序，由主进程决定）。 */
  readonly sessions: readonly SessionSummary[]
  /** 各会话的事件投影。 */
  readonly views: Readonly<Record<string, SessionView>>
  readonly activeSessionId: string | undefined
  /** 已发送输入、等待这一轮开始的会话。 */
  readonly awaitingTurn: Readonly<Record<string, true>>
  /** 各会话收到的原始事件（按到达顺序）；只在开启事件记录时保存。 */
  readonly eventLog: Readonly<Record<string, readonly EventEnvelope[]>>
  /** 各会话的未决审批（按请求顺序）；只读取当前会话的。 */
  readonly approvals: Readonly<Record<string, readonly PendingApproval[]>>
  /** 已打开过的项目（按打开时间倒序）。 */
  readonly projects: readonly ProjectSummary[]
  /** 最近读取或保存的设置；读取之前为 undefined。 */
  readonly settings: Settings | undefined
  /** 最近一次失败的错误；界面显示后可以清除。 */
  readonly error: ErrorInfo | undefined
}

export interface SessionActions {
  refreshSessions(): Promise<void>
  /** 新建会话并选中，返回会话 id；失败时返回 undefined。 */
  createSession(projectPath: string, title?: string): Promise<string | undefined>
  /** 选中会话并订阅其事件；传 undefined 取消选中。 */
  selectSession(sessionId: string | undefined): Promise<void>
  /** 向当前会话发送文本输入；没有发送（空输入、未选中会话或请求失败）时返回 false。 */
  sendPrompt(text: string): Promise<boolean>
  /** 停止当前会话正在进行的一轮。 */
  abort(): Promise<void>
  /** 决定当前会话的一个审批；成功时返回 true。 */
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ): Promise<boolean>
  refreshProjects(): Promise<void>
  /** 用系统对话框选择文件夹作为项目；取消或失败时返回 undefined。 */
  openProject(): Promise<ProjectSummary | undefined>
  loadSettings(): Promise<Settings | undefined>
  /** 保存设置，返回保存后的全部设置；失败时返回 undefined。 */
  updateSettings(patch: SettingsPatch): Promise<Settings | undefined>
  /** 保存 Key；成功时返回 true。 */
  saveCredential(ref: string, secret: string): Promise<boolean>
  /** Key 是否已保存、系统加密是否可用；失败时返回 undefined。 */
  credentialStatus(ref: string): Promise<{ configured: boolean; available: boolean } | undefined>
  clearError(): void
  /** 取消订阅并停止接收事件。 */
  dispose(): void
}

export type SessionStore = StoreApi<SessionState & SessionActions>

export interface SessionStoreOptions {
  /** 每个会话保存的原始事件条数上限；0（默认）表示不保存。 */
  readonly eventLogLimit?: number
}

const toError = (error: unknown): ErrorInfo =>
  error instanceof RpcError ? error.toInfo() : { code: 'unknown' }

/** 这些事件说明等待的那一轮已经开始或不会再开始。 */
const TURN_SETTLED = new Set(['turn.started', 'turn.failed', 'turn.aborted', 'session.crashed'])

/** 这些事件之后重新读取未决审批。 */

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string) => {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

/** 界面显示的会话状态：等待开始时视为运行中。 */
const displayStatus = (state: Pick<SessionState, 'awaitingTurn'>, view: SessionView) =>
  state.awaitingTurn[view.sessionId] ? 'running' : sessionStatus(view)

/** 只更新列表中一个会话的状态。 */
const withStatus = (
  sessions: readonly SessionSummary[],
  sessionId: string,
  status: SessionSummary['status'],
) => sessions.map((s) => (s.sessionId === sessionId && s.status !== status ? { ...s, status } : s))

/** 把事件归约进会话投影，并同步等待标记与列表中的状态。 */
function reduceInto(
  state: SessionState,
  sessionId: string,
  events: readonly EventEnvelope[],
): Pick<SessionState, 'views' | 'sessions' | 'awaitingTurn'> {
  let view = state.views[sessionId] ?? createSessionView(sessionId)
  for (const event of events) view = reduceSession(view, event)
  const awaitingTurn = events.some((e) => TURN_SETTLED.has(e.type))
    ? withoutKey(state.awaitingTurn, sessionId)
    : state.awaitingTurn
  return {
    views: { ...state.views, [sessionId]: view },
    awaitingTurn,
    sessions: withStatus(state.sessions, sessionId, displayStatus({ awaitingTurn }, view)),
  }
}

/**
 * 把事件追加到会话的记录中，最多保留 `limit` 条。超出时先丢弃最早的增量事件（一次长回复就有上千条），
 * 只剩持久化事件时再丢弃最早的。
 */
function appendLog(
  log: SessionState['eventLog'],
  sessionId: string,
  events: readonly EventEnvelope[],
  limit: number,
): SessionState['eventLog'] {
  if (limit <= 0 || events.length === 0) return log
  let next = [...(log[sessionId] ?? []), ...events]
  let excess = next.length - limit
  if (excess > 0) {
    next = next.filter((event) => isPersistedEvent(event) || excess-- <= 0)
    if (next.length > limit) next = next.slice(-limit)
  }
  return { ...log, [sessionId]: next }
}

export function createSessionStore(api: MainApi, options: SessionStoreOptions = {}): SessionStore {
  const eventLogLimit = options.eventLogLimit ?? 0
  const receive = (state: SessionState, sessionId: string, events: readonly EventEnvelope[]) => ({
    ...reduceInto(state, sessionId, events),
    eventLog: appendLog(state.eventLog, sessionId, events, eventLogLimit),
  })
  /** 正在等待订阅响应的会话 → 期间到达的实时事件。 */
  const pending = new Map<string, EventEnvelope[]>()
  /** 当前已订阅的会话（订阅响应已返回）。 */
  let subscribed: string | undefined

  let loadApprovalsFor: (sessionId: string) => Promise<void> = () => Promise.resolve()
  const store = createStore<SessionState & SessionActions>()((set, get) => {
    const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action()
      } catch (error) {
        set({ error: toError(error) })
        return undefined
      }
    }

    const setAwaiting = (sessionId: string, awaiting: boolean) =>
      set((state) => {
        const awaitingTurn = awaiting
          ? { ...state.awaitingTurn, [sessionId]: true as const }
          : withoutKey(state.awaitingTurn, sessionId)
        if (awaitingTurn === state.awaitingTurn) return {}
        const view = state.views[sessionId]
        return {
          awaitingTurn,
          sessions: view
            ? withStatus(state.sessions, sessionId, displayStatus({ awaitingTurn }, view))
            : state.sessions,
        }
      })

    /** 重新读取会话的未决审批；失败时保留之前的结果。 */
    const loadApprovals = async (sessionId: string) => {
      const result = await run(() => api.request('approval.pending', { sessionId }))
      if (result)
        set((state) => ({ approvals: { ...state.approvals, [sessionId]: result.approvals } }))
    }

    loadApprovalsFor = loadApprovals

    const unsubscribe = async (sessionId: string) => {
      pending.delete(sessionId)
      if (subscribed === sessionId) subscribed = undefined
      await run(() => api.request('session.unsubscribe', { sessionId }))
    }

    return {
      sessions: [],
      views: {},
      activeSessionId: undefined,
      awaitingTurn: {},
      eventLog: {},
      approvals: {},
      projects: [],
      settings: undefined,
      error: undefined,

      async refreshSessions() {
        const result = await run(() => api.request('session.list', {}))
        if (!result) return
        // 已订阅的会话以本地投影的状态为准（比列表请求更新）
        const state = get()
        set({
          sessions: result.sessions.map((s) => {
            const view = state.views[s.sessionId]
            return view && s.sessionId === subscribed
              ? { ...s, status: displayStatus(state, view) }
              : s
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
        set((state) => receive(state, sessionId, [...result.events, ...(buffered ?? [])]))
        await loadApprovals(sessionId)
      },

      async sendPrompt(text) {
        const sessionId = get().activeSessionId
        const trimmed = text.trim()
        if (sessionId === undefined || trimmed === '') return false
        const content: ContentPart[] = [{ type: 'text', text: trimmed }]
        // 先标记再请求：turn.started 可能早于请求响应到达
        setAwaiting(sessionId, true)
        const sent = await run(() => api.request('session.prompt', { sessionId, content }))
        if (sent === undefined) setAwaiting(sessionId, false)
        return sent !== undefined
      },

      async abort() {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return
        const stopped = await run(() => api.request('session.abort', { sessionId }))
        // 排队中的输入被取消时不会产生事件
        if (stopped !== undefined) setAwaiting(sessionId, false)
      },

      async resolveApproval(approvalId, decision, feedback) {
        const sessionId = get().activeSessionId
        if (sessionId === undefined) return false
        const trimmed = feedback?.trim()
        const resolved = await run(() =>
          api.request('approval.resolve', {
            sessionId,
            approvalId,
            decision,
            ...(decision === 'deny' && trimmed ? { feedback: trimmed } : {}),
          }),
        )
        await loadApprovals(sessionId)
        return resolved !== undefined
      },

      async refreshProjects() {
        const result = await run(() => api.request('project.list', {}))
        if (result) set({ projects: result.projects })
      },

      async openProject() {
        const result = await run(() => api.request('project.open', {}))
        const project = result?.project
        if (!project) return undefined
        set((state) => ({
          projects: [project, ...state.projects.filter((p) => p.projectId !== project.projectId)],
        }))
        return project
      },

      async loadSettings() {
        const result = await run(() => api.request('settings.get', {}))
        if (result) set({ settings: result })
        return result
      },

      async updateSettings(patch) {
        const result = await run(() => api.request('settings.update', patch))
        if (result) set({ settings: result })
        return result
      },

      async saveCredential(ref, secret) {
        return (await run(() => api.request('credentials.set', { ref, secret }))) !== undefined
      },

      credentialStatus: (ref) => run(() => api.request('credentials.status', { ref })),

      clearError: () => set({ error: undefined }),

      dispose() {
        offEvents()
        offApprovals()
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
    if (sessionId !== subscribed) return
    store.setState((state) => receive(state, sessionId, events))
  })
  const offApprovals = api.on('approval.changed', ({ sessionId }) => {
    if (sessionId === subscribed) void loadApprovalsFor(sessionId)
  })

  return store
}
