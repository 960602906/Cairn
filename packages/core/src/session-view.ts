/**
 * 会话投影（架构 §7.3；Runtime §5、§17）。
 *
 * `reduceSession(view, event)` 是纯函数：由事件得到消息列表、会话信息与运行状态，
 * 界面（M0-15）和测试共用。规则：
 *
 * - **幂等**：`seq` 不大于 `lastSeq` 的事件（重复补发、乱序到达）和其他会话的事件直接忽略，
 *   返回原对象。因此"补发 + 实时"重叠时不会出现重复消息。
 * - **容错**：引用未知运行 / 轮次 / 步骤的事件、非法的状态转换都只推进 `lastSeq`，不改变内容，
 *   不抛出。
 * - **增量事件**（`*.delta`）只更新 `live` 中"进行中"的消息，不推进 `lastSeq`（`lastSeq` 只表示
 *   已归约的最后一条持久化事件，可直接作为 `afterSeq`）。`message.assistant.completed` 以完整内容
 *   写入 `messages` 并移除对应的进行中消息；轮次结束或宿主崩溃时丢弃该运行剩余的进行中消息。
 *   因此只用持久化事件与"持久化 + 增量"归约，最终结果相同。
 * - 状态以不可变方式更新：只替换发生变化的部分，便于界面按引用比较。
 */
import {
  isPersistedEvent,
  type AgentDefinitionRef,
  type ContentPart,
  type ErrorInfo,
  type EventEnvelope,
  type LiveEvent,
  type ModelRef,
  type PersistedEvent,
  type ReasoningPart,
  type RunLimits,
  type RunMode,
  type RunState,
  type SessionStatus,
  type TokenUsage,
  type ToolCall,
} from '@nexus/protocol'
import { canTransition } from './run-state.js'

/** 会话基本信息（来自 `session.created` / `session.renamed`）。 */
export interface SessionInfo {
  readonly projectId: string
  readonly projectPath: string
  readonly workspacePath: string
  readonly title: string
  readonly createdAt: number
}

interface MessageMeta {
  readonly messageId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly seq: number
  readonly ts: number
}

export interface UserMessageView extends MessageMeta {
  readonly role: 'user'
  readonly content: readonly ContentPart[]
}

export interface AssistantMessageView extends MessageMeta {
  readonly role: 'assistant'
  readonly content: readonly ContentPart[]
  readonly reasoning: ReasoningPart | undefined
  readonly toolCalls: readonly ToolCall[]
  readonly model: ModelRef
}

export type MessageView = UserMessageView | AssistantMessageView

/** 正在流式输出、尚未完成的助手消息（只来自增量事件，不落库）。 */
export interface LiveMessageView {
  readonly messageId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly text: string
  readonly reasoning: string
  /** 已合并的最后一条增量的 seq，用于丢弃重复或迟到的增量。 */
  readonly lastDeltaSeq: number
  readonly startedAt: number
}

export type StepStatus = 'running' | 'completed'

export interface StepView {
  readonly stepId: string
  readonly model: ModelRef
  readonly status: StepStatus
  readonly startedAt: number
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' | undefined
  readonly durationMs: number | undefined
}

export type TurnStatus = 'running' | 'completed' | 'aborted' | 'failed'

export interface TurnView {
  readonly turnId: string
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt: number | undefined
  /** 本轮已开始的步骤数。 */
  readonly stepCount: number
  /** 当前（或最后一个）步骤。 */
  readonly step: StepView | undefined
  readonly durationMs: number | undefined
  readonly abortReason: 'user' | 'shutdown' | 'superseded' | undefined
  readonly error: ErrorInfo | undefined
  readonly retryable: boolean | undefined
  /** 本轮触发的限额（`turn.limit_reached`）；轮次随后仍以失败或完成结束。 */
  readonly limitReached: { readonly limit: keyof RunLimits; readonly value: number } | undefined
}

export interface RunView {
  readonly runId: string
  readonly parentRunId: string | undefined
  readonly agent: AgentDefinitionRef
  readonly model: ModelRef
  readonly mode: RunMode
  readonly limits: RunLimits
  readonly state: RunState
  readonly createdAt: number
  /** 最近一轮；尚未开始时为 `undefined`。 */
  readonly turn: TurnView | undefined
  readonly usage: TokenUsage
}

export interface SessionView {
  readonly sessionId: string
  /** 已归约的最后一条持久化事件的 seq；0 表示尚未处理任何事件（seq 从 1 开始）。 */
  readonly lastSeq: number
  /** 收到 `session.created` 之前为 `undefined`。 */
  readonly info: SessionInfo | undefined
  readonly archived: boolean
  /** 最近一次宿主崩溃；之后开始新一轮时清除。 */
  readonly crash: ErrorInfo | undefined
  readonly runs: Readonly<Record<string, RunView>>
  /** 按创建顺序排列的运行 id。 */
  readonly runOrder: readonly string[]
  /** 按 seq 顺序的消息；同一 `messageId` 只出现一次。 */
  readonly messages: readonly MessageView[]
  /** 进行中的消息，按 messageId 索引；界面显示在 `messages` 之后。 */
  readonly live: Readonly<Record<string, LiveMessageView>>
  /** 会话累计用量（只统计 `usage.reported`，不重复计入 `step.completed.usage`）。 */
  readonly usage: TokenUsage
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

export function createSessionView(sessionId: string): SessionView {
  return {
    sessionId,
    lastSeq: 0,
    info: undefined,
    archived: false,
    crash: undefined,
    runs: {},
    runOrder: [],
    messages: [],
    live: {},
    usage: ZERO_USAGE,
  }
}

/** 依次归约一组事件。 */
export function reduceSessionEvents(
  view: SessionView,
  events: Iterable<EventEnvelope>,
): SessionView {
  let next = view
  for (const event of events) next = reduceSession(next, event)
  return next
}

/** 归约一条事件；被忽略的事件返回原对象。 */
export function reduceSession(view: SessionView, event: EventEnvelope): SessionView {
  if (event.sessionId !== view.sessionId) return view
  if (event.seq <= view.lastSeq) return view
  if (!isPersistedEvent(event)) return applyLive(view, event) ?? view
  const advanced: SessionView = { ...view, lastSeq: event.seq }
  const next = apply(advanced, event) ?? advanced
  return dropFinishedLive(next, event)
}

/** 合并一条增量事件；返回 `undefined` 表示忽略。 */
function applyLive(view: SessionView, event: LiveEvent): SessionView | undefined {
  if (event.type === 'tool.output.delta') return undefined // 工具输出由后续阶段的投影处理
  const { messageId, text } = event.payload
  if (view.messages.some((m) => m.messageId === messageId)) return undefined
  const prev = view.live[messageId]
  if (prev && event.seq <= prev.lastDeltaSeq) return undefined
  const base: LiveMessageView = prev ?? {
    messageId,
    runId: event.runId,
    turnId: event.turnId,
    text: '',
    reasoning: '',
    lastDeltaSeq: 0,
    startedAt: event.ts,
  }
  const live: LiveMessageView =
    event.type === 'message.assistant.delta'
      ? { ...base, text: base.text + text, lastDeltaSeq: event.seq }
      : { ...base, reasoning: base.reasoning + text, lastDeltaSeq: event.seq }
  return { ...view, live: { ...view.live, [messageId]: live } }
}

/**
 * 持久化事件之后清理进行中的消息：完成事件移除对应消息；
 * 轮次结束移除该运行的全部进行中消息；宿主崩溃移除全部。
 */
function dropFinishedLive(view: SessionView, event: PersistedEvent): SessionView {
  const ids = Object.keys(view.live)
  if (ids.length === 0) return view
  let keep: (live: LiveMessageView) => boolean
  switch (event.type) {
    case 'message.assistant.completed':
      keep = (live) => live.messageId !== event.payload.messageId
      break
    case 'turn.completed':
    case 'turn.aborted':
    case 'turn.failed':
    case 'run.disposed':
      keep = (live) => live.runId !== event.runId
      break
    case 'session.crashed':
      keep = () => false
      break
    default:
      return view
  }
  const kept = ids.filter((id) => keep(view.live[id]!))
  if (kept.length === ids.length) return view
  return { ...view, live: Object.fromEntries(kept.map((id) => [id, view.live[id]!])) }
}

/** 返回 `undefined` 表示事件内容被忽略（只推进 lastSeq）。 */
function apply(view: SessionView, event: PersistedEvent): SessionView | undefined {
  switch (event.type) {
    case 'session.created': {
      if (view.info) return undefined
      const { projectId, projectPath, workspacePath, title } = event.payload
      return {
        ...view,
        info: { projectId, projectPath, workspacePath, title, createdAt: event.ts },
      }
    }
    case 'session.renamed':
      return view.info ? { ...view, info: { ...view.info, title: event.payload.title } } : undefined
    case 'session.archived':
      return { ...view, archived: true }
    case 'session.crashed':
      return { ...view, crash: event.payload.error }

    case 'run.created': {
      if (view.runs[event.runId]) return undefined
      const run: RunView = {
        runId: event.runId,
        parentRunId: event.parentRunId,
        ...event.payload,
        state: 'idle',
        createdAt: event.ts,
        turn: undefined,
        usage: ZERO_USAGE,
      }
      return {
        ...view,
        runs: { ...view.runs, [run.runId]: run },
        runOrder: [...view.runOrder, run.runId],
      }
    }
    case 'run.state.changed':
      return updateRun(view, event.runId, (run) =>
        canTransition(run.state, event.payload.to)
          ? { ...run, state: event.payload.to }
          : undefined,
      )
    case 'run.disposed':
      return updateRun(view, event.runId, (run) =>
        run.state === 'disposed' ? undefined : { ...run, state: 'disposed' },
      )

    case 'turn.started': {
      const { turnId } = event
      if (turnId === undefined) return undefined
      const next = updateRun(view, event.runId, (run) =>
        run.turn?.turnId === turnId ? undefined : { ...run, turn: newTurn(turnId, event.ts) },
      )
      return next && { ...next, crash: undefined }
    }
    case 'turn.completed':
      return endTurn(view, event, { status: 'completed', durationMs: event.payload.durationMs })
    case 'turn.aborted':
      return endTurn(view, event, { status: 'aborted', abortReason: event.payload.reason })
    case 'turn.failed':
      return endTurn(view, event, {
        status: 'failed',
        error: event.payload.error,
        retryable: event.payload.retryable,
      })
    case 'turn.limit_reached':
      return updateTurn(view, event, (turn) =>
        turn.status === 'running' ? { ...turn, limitReached: { ...event.payload } } : undefined,
      )

    case 'step.started': {
      const { stepId } = event
      if (stepId === undefined) return undefined
      return updateTurn(view, event, (turn) =>
        turn.status !== 'running' || turn.step?.stepId === stepId
          ? undefined
          : {
              ...turn,
              stepCount: turn.stepCount + 1,
              step: {
                stepId,
                model: event.payload.model,
                status: 'running',
                startedAt: event.ts,
                finishReason: undefined,
                durationMs: undefined,
              },
            },
      )
    }
    case 'step.completed':
      return updateTurn(view, event, (turn) => {
        const { step } = turn
        if (!step || step.stepId !== event.stepId || step.status !== 'running') return undefined
        const { finishReason, durationMs } = event.payload
        return { ...turn, step: { ...step, status: 'completed', finishReason, durationMs } }
      })

    case 'message.user':
      return upsertMessage(view, {
        role: 'user',
        ...meta(event, event.payload.messageId),
        content: event.payload.content,
      })
    case 'message.assistant.completed': {
      const { messageId, content, reasoning, toolCalls, model } = event.payload
      return upsertMessage(view, {
        role: 'assistant',
        ...meta(event, messageId),
        content,
        reasoning,
        toolCalls: toolCalls ?? [],
        model,
      })
    }

    case 'usage.reported': {
      const usage = event.payload.usage
      const withRun = updateRun(view, event.runId, (run) => ({
        ...run,
        usage: addUsage(run.usage, usage),
      }))
      return { ...(withRun ?? view), usage: addUsage(view.usage, usage) }
    }

    default:
      // 工具、审批、检查点等事件由后续阶段的投影处理。
      return undefined
  }
}

function newTurn(turnId: string, ts: number): TurnView {
  return {
    turnId,
    status: 'running',
    startedAt: ts,
    endedAt: undefined,
    stepCount: 0,
    step: undefined,
    durationMs: undefined,
    abortReason: undefined,
    error: undefined,
    retryable: undefined,
    limitReached: undefined,
  }
}

function updateRun(
  view: SessionView,
  runId: string,
  fn: (run: RunView) => RunView | undefined,
): SessionView | undefined {
  const run = view.runs[runId]
  if (!run) return undefined
  const next = fn(run)
  return next && { ...view, runs: { ...view.runs, [runId]: next } }
}

/** 只更新事件 `turnId` 所指的当前轮次。 */
function updateTurn(
  view: SessionView,
  event: PersistedEvent,
  fn: (turn: TurnView) => TurnView | undefined,
): SessionView | undefined {
  return updateRun(view, event.runId, (run) => {
    if (!run.turn || run.turn.turnId !== event.turnId) return undefined
    const turn = fn(run.turn)
    return turn && { ...run, turn }
  })
}

function endTurn(
  view: SessionView,
  event: PersistedEvent,
  patch: Partial<TurnView> & { status: Exclude<TurnStatus, 'running'> },
): SessionView | undefined {
  return updateTurn(view, event, (turn) =>
    turn.status === 'running' ? { ...turn, ...patch, endedAt: event.ts } : undefined,
  )
}

function meta(event: PersistedEvent, messageId: string): MessageMeta {
  return { messageId, runId: event.runId, turnId: event.turnId, seq: event.seq, ts: event.ts }
}

/** 新消息追加到末尾；同一 messageId 已存在时原位替换（保持显示顺序）。 */
function upsertMessage(view: SessionView, message: MessageView): SessionView {
  const index = view.messages.findIndex((m) => m.messageId === message.messageId)
  const messages = index === -1 ? [...view.messages, message] : view.messages.with(index, message)
  return { ...view, messages }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  }
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) {
    sum.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
  }
  return sum
}

/**
 * 会话在列表中显示的状态（`SessionStatus`）。
 * 以最近创建的顶层运行（无 `parentRunId`）为准；归档与崩溃优先。
 */
export function sessionStatus(view: SessionView): SessionStatus {
  if (view.archived) return 'archived'
  if (view.crash) return 'crashed'
  const root = view.runOrder
    .map((id) => view.runs[id])
    .findLast((run) => run !== undefined && run.parentRunId === undefined)
  switch (root?.state) {
    case 'thinking':
    case 'tooling':
    case 'awaiting_children':
    case 'aborting':
      return 'running'
    case 'awaiting_approval':
      return 'waiting_approval'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'idle'
  }
}
