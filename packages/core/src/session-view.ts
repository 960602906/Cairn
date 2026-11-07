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
 * - **工具调用**（M1-05c）：`tool.*` 持久化事件归约为 `tools`；`tool.output.delta` 只进入
 *   `liveToolOutput`（保留最后 `MAX_LIVE_TOOL_OUTPUT_CHARS` 个字符），工具结束、轮次结束或宿主崩溃时丢弃，
 *   规则与进行中的消息相同。
 * - 状态以不可变方式更新：只替换发生变化的部分，便于界面按引用比较。
 */
import {
  isPersistedEvent,
  type AgentDefinitionRef,
  type ContentPart,
  type ErrorInfo,
  type EventEnvelope,
  type EventPayload,
  type LiveEvent,
  type ModelRef,
  type PersistedEvent,
  type ReasoningPart,
  type RunLimits,
  type RunMode,
  type RunState,
  type CheckpointReason,
  type SessionStatus,
  type TokenUsage,
  type ToolCall,
  type ToolDisplay,
  type ToolOutputChunk as ProtocolToolOutputChunk,
} from '@cairn/protocol'
import { canTransition } from './run-state.js'

/** 会话基本信息（来自 `session.created` / `session.renamed` / `session.model.changed`）。 */
export interface SessionInfo {
  readonly projectId: string
  readonly projectPath: string
  readonly workspacePath: string
  readonly title: string
  /** 会话使用的模型（下一轮起）；M1-04a 之前创建、没有记录模型的会话为 undefined。 */
  readonly model: ModelRef | undefined
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
  /** 被停止或出错打断的部分回复。 */
  readonly incomplete: boolean
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

export type ToolCallStatus = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled'

/** 一次工具调用（来自 `tool.*` 持久化事件）。 */
export interface ToolCallView {
  readonly toolCallId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly name: string
  readonly input: unknown
  readonly status: ToolCallStatus
  readonly requestedAt: number
  /** 交给模型的输出（`tool.completed`）。 */
  readonly output: readonly ContentPart[] | undefined
  /** 只给界面显示的结果（`tool.completed.display`，M2-06）。 */
  readonly display: ToolDisplay | undefined
  readonly truncated: boolean
  readonly error: ErrorInfo | undefined
  readonly cancelReason: EventPayload<'tool.cancelled'>['reason'] | undefined
  readonly durationMs: number | undefined
}

export type ToolOutputChunk = Readonly<ProtocolToolOutputChunk>

/** 执行中的工具的实时输出（只来自 `tool.output.delta`，不落库）。 */
export interface LiveToolOutputView {
  readonly toolCallId: string
  readonly runId: string
  /** 相邻的同一输出流合并为一段。 */
  readonly chunks: readonly ToolOutputChunk[]
  /** 超过上限后从开头丢弃的字符数。 */
  readonly omittedChars: number
  readonly lastDeltaSeq: number
}

/** 每个工具调用保留的实时输出上限（字符数）；完整结果以 `tool.completed` 为准。 */
export const MAX_LIVE_TOOL_OUTPUT_CHARS = 64 * 1024

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
  /**
   * 模型请求失败、正在等待重试（`model.retry`，M1-14a）；下一步开始或本轮结束时清除。
   * `at` 为事件时间，界面据此与 `delayMs` 显示剩余等待。
   */
  readonly retry: RetryView | undefined
}

export interface RetryView {
  readonly attempt: number
  readonly maxRetries: number
  readonly delayMs: number
  readonly error: ErrorInfo
  readonly at: number
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

/** 会话的一个检查点（`checkpoint.created`，M2-08 的检查点分隔线与历史菜单）。 */
export interface CheckpointView {
  readonly checkpointId: string
  readonly reason: CheckpointReason
  readonly seq: number
  readonly runId: string
  /** 创建时所在的轮次；恢复前创建的检查点没有。 */
  readonly turnId: string | undefined
  readonly createdAt: number
}

/** 一次恢复（`checkpoint.restored`）。 */
export interface RestoreView {
  readonly checkpointId: string
  readonly seq: number
  readonly ts: number
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
  /** 工具调用，按 toolCallId 索引。 */
  readonly tools: Readonly<Record<string, ToolCallView>>
  /** 执行中的工具的实时输出，按 toolCallId 索引。 */
  readonly liveToolOutput: Readonly<Record<string, LiveToolOutputView>>
  /** 会话累计用量（只统计 `usage.reported`，不重复计入 `step.completed.usage`）。 */
  readonly usage: TokenUsage
  /** 各轮的用量（M2-03，界面在轮次操作中显示 token 数），按 turnId 索引；没有 turnId 的用量不计入。 */
  readonly usageByTurn: Readonly<Record<string, TokenUsage>>
  /**
   * 上下文占用（M2-04，输入框的圆环）：最近一次主模型 `usage.reported` 的输入 + 输出 token 数，
   * 即下一次请求大约要带上的上下文；还没有用量时为 undefined。辅助模型用量（`auxiliary`，M3-01）
   * 计入 `usage`，不更新这里。
   */
  readonly contextTokens: number | undefined
  /** 检查点，按创建顺序（M2-08）。 */
  readonly checkpoints: readonly CheckpointView[]
  /** 恢复，按发生顺序（M2-08）。 */
  readonly restores: readonly RestoreView[]
  /**
   * 最近一轮读到的项目说明（M3-02）。这一轮没读到时不出现，顶栏的标记随之消失。
   */
  readonly agentsMd?: { readonly lines: number; readonly truncated: boolean }
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
    tools: {},
    liveToolOutput: {},
    usage: ZERO_USAGE,
    usageByTurn: {},
    contextTokens: undefined,
    checkpoints: [],
    restores: [],
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
  return dropFinishedToolOutput(dropFinishedLive(next, event), event)
}

/** 合并一条增量事件；返回 `undefined` 表示忽略。 */
function applyLive(view: SessionView, event: LiveEvent): SessionView | undefined {
  if (event.type === 'tool.output.delta') return applyToolOutput(view, event)
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

/** 合并一条工具输出增量：只接受尚未结束的已知调用。 */
function applyToolOutput(
  view: SessionView,
  event: Extract<LiveEvent, { type: 'tool.output.delta' }>,
): SessionView | undefined {
  const { toolCallId, stream, text } = event.payload
  const tool = view.tools[toolCallId]
  if (!tool || (tool.status !== 'requested' && tool.status !== 'running')) return undefined
  const prev = view.liveToolOutput[toolCallId]
  if (prev && event.seq <= prev.lastDeltaSeq) return undefined
  if (text === '') return undefined
  const chunks = [...(prev?.chunks ?? [])]
  const last = chunks.at(-1)
  if (last?.stream === stream) chunks[chunks.length - 1] = { stream, text: last.text + text }
  else chunks.push({ stream, text })
  let omitted = prev?.omittedChars ?? 0
  let total = chunks.reduce((n, c) => n + c.text.length, 0)
  while (total > MAX_LIVE_TOOL_OUTPUT_CHARS) {
    const first = chunks[0]!
    const excess = total - MAX_LIVE_TOOL_OUTPUT_CHARS
    if (first.text.length <= excess) {
      chunks.shift()
      omitted += first.text.length
      total -= first.text.length
    } else {
      chunks[0] = { stream: first.stream, text: first.text.slice(excess) }
      omitted += excess
      total -= excess
    }
  }
  const live: LiveToolOutputView = {
    toolCallId,
    runId: tool.runId,
    chunks,
    omittedChars: omitted,
    lastDeltaSeq: event.seq,
  }
  return { ...view, liveToolOutput: { ...view.liveToolOutput, [toolCallId]: live } }
}

/** 工具结束、轮次结束或宿主崩溃时丢弃实时输出（与进行中的消息相同）。 */
function dropFinishedToolOutput(view: SessionView, event: PersistedEvent): SessionView {
  const ids = Object.keys(view.liveToolOutput)
  if (ids.length === 0) return view
  let keep: (live: LiveToolOutputView) => boolean
  switch (event.type) {
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.cancelled':
      keep = (live) => live.toolCallId !== event.payload.toolCallId
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
  const kept = ids.filter((id) => keep(view.liveToolOutput[id]!))
  if (kept.length === ids.length) return view
  return {
    ...view,
    liveToolOutput: Object.fromEntries(kept.map((id) => [id, view.liveToolOutput[id]!])),
  }
}

/** 更新一个尚未结束的工具调用。 */
function updateTool(
  view: SessionView,
  toolCallId: string,
  fn: (tool: ToolCallView) => ToolCallView,
): SessionView | undefined {
  const tool = view.tools[toolCallId]
  if (!tool || (tool.status !== 'requested' && tool.status !== 'running')) return undefined
  const next = fn(tool)
  return next === tool ? undefined : { ...view, tools: { ...view.tools, [toolCallId]: next } }
}

/** 返回 `undefined` 表示事件内容被忽略（只推进 lastSeq）。 */
function apply(view: SessionView, event: PersistedEvent): SessionView | undefined {
  switch (event.type) {
    case 'session.created': {
      if (view.info) return undefined
      const { projectId, projectPath, workspacePath, title, model } = event.payload
      return {
        ...view,
        info: { projectId, projectPath, workspacePath, title, model, createdAt: event.ts },
      }
    }
    case 'session.renamed':
      return view.info ? { ...view, info: { ...view.info, title: event.payload.title } } : undefined
    case 'session.model.changed':
      return view.info ? { ...view, info: { ...view.info, model: event.payload.model } } : undefined
    case 'session.archived':
      return { ...view, archived: true }
    case 'checkpoint.created': {
      const checkpoint: CheckpointView = {
        checkpointId: event.payload.checkpointId,
        reason: event.payload.reason,
        seq: event.seq,
        runId: event.runId,
        turnId: event.turnId,
        createdAt: event.ts,
      }
      return { ...view, checkpoints: [...view.checkpoints, checkpoint] }
    }
    case 'checkpoint.restored': {
      const restore: RestoreView = {
        checkpointId: event.payload.checkpointId,
        seq: event.seq,
        ts: event.ts,
      }
      return { ...view, restores: [...view.restores, restore] }
    }
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
      const loaded = event.payload.context?.agentsMd
      const next = updateRun(view, event.runId, (run) =>
        run.turn?.turnId === turnId ? undefined : { ...run, turn: newTurn(turnId, event.ts) },
      )
      // 重复的 turn.started，而且标记不用变：只推进 seq
      if (!next && view.agentsMd === undefined && loaded === undefined) return undefined
      const { agentsMd: _previous, ...rest } = next ?? view
      return {
        ...rest,
        crash: undefined,
        ...(loaded ? { agentsMd: { lines: loaded.lines, truncated: loaded.truncated } } : {}),
      }
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
    case 'model.retry':
      return updateTurn(view, event, (turn) =>
        turn.status === 'running'
          ? { ...turn, retry: { ...event.payload, at: event.ts } }
          : undefined,
      )

    case 'step.started': {
      const { stepId } = event
      if (stepId === undefined) return undefined
      return updateTurn(view, event, (turn) =>
        turn.status !== 'running' || turn.step?.stepId === stepId
          ? undefined
          : {
              ...turn,
              retry: undefined,
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
      const { messageId, content, reasoning, toolCalls, model, incomplete } = event.payload
      return upsertMessage(view, {
        role: 'assistant',
        ...meta(event, messageId),
        content,
        reasoning,
        toolCalls: toolCalls ?? [],
        model,
        incomplete: incomplete ?? false,
      })
    }

    case 'usage.reported': {
      const usage = event.payload.usage
      const withRun = updateRun(view, event.runId, (run) => ({
        ...run,
        usage: addUsage(run.usage, usage),
      }))
      const turnId = event.turnId
      return {
        ...(withRun ?? view),
        usage: addUsage(view.usage, usage),
        contextTokens: event.payload.auxiliary
          ? view.contextTokens
          : usage.inputTokens + usage.outputTokens,
        ...(turnId === undefined
          ? {}
          : {
              usageByTurn: {
                ...view.usageByTurn,
                [turnId]: addUsage(view.usageByTurn[turnId] ?? ZERO_USAGE, usage),
              },
            }),
      }
    }

    case 'tool.requested': {
      const { toolCallId, name, input } = event.payload
      if (view.tools[toolCallId]) return undefined
      const tool: ToolCallView = {
        toolCallId,
        runId: event.runId,
        turnId: event.turnId,
        name,
        input,
        status: 'requested',
        requestedAt: event.ts,
        output: undefined,
        display: undefined,
        truncated: false,
        error: undefined,
        cancelReason: undefined,
        durationMs: undefined,
      }
      return { ...view, tools: { ...view.tools, [toolCallId]: tool } }
    }
    case 'tool.started':
      return updateTool(view, event.payload.toolCallId, (tool) =>
        tool.status === 'running' ? tool : { ...tool, status: 'running' },
      )
    case 'tool.completed': {
      const { toolCallId, output, truncated, durationMs, display } = event.payload
      return updateTool(view, toolCallId, (tool) => ({
        ...tool,
        status: 'completed',
        output,
        display,
        truncated: truncated ?? false,
        durationMs,
      }))
    }
    case 'tool.failed':
      return updateTool(view, event.payload.toolCallId, (tool) => ({
        ...tool,
        status: 'failed',
        error: event.payload.error,
      }))
    case 'tool.cancelled':
      return updateTool(view, event.payload.toolCallId, (tool) => ({
        ...tool,
        status: 'cancelled',
        cancelReason: event.payload.reason,
      }))

    default:
      // 审批、检查点等事件由后续阶段的投影处理。
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
    retry: undefined,
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
    turn.status === 'running'
      ? { ...turn, ...patch, retry: undefined, endedAt: event.ts }
      : undefined,
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

/** 最近创建的顶层运行（无 `parentRunId`）；会话的状态与输入都以它为准。 */
export function rootRun(view: SessionView): RunView | undefined {
  return view.runOrder
    .map((id) => view.runs[id])
    .findLast((run) => run !== undefined && run.parentRunId === undefined)
}

/**
 * 会话在列表中显示的状态（`SessionStatus`）。
 * 以最近创建的顶层运行（`rootRun`）为准；归档与崩溃优先。
 */
export function sessionStatus(view: SessionView): SessionStatus {
  if (view.archived) return 'archived'
  if (view.crash) return 'crashed'
  switch (rootRun(view)?.state) {
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
