/**
 * 事件模型（ADR-0005，架构 §7，Runtime §12）。
 *
 * 所有会话活动都表示为事件，追加写入事件日志；界面状态是事件的投影。
 * 规则：
 * - 事件类型一旦登记就不能改名或删除；新字段只能向后兼容地追加（可选字段）。
 *   不兼容的变化必须提升 EVENT_SCHEMA_VERSION 并提供迁移。
 * - 增量事件（LIVE_EVENT_TYPES）只用于实时显示，不写数据库；对应的完成事件携带完整内容。
 * - 宿主发出的事件没有 seq（UnsequencedEvent），由主进程分配 seq 后成为 EventEnvelope。
 */
import { z } from 'zod'
import {
  AgentDefinitionRef,
  ContentPart,
  DurationMs,
  ErrorInfo,
  Id,
  ModelRef,
  ReasoningPart,
  RunLimits,
  RunMode,
  RunState,
  Timestamp,
  TokenUsage,
  ToolCall,
} from './common.js'
import { FileChangeKind } from './changes.js'

/** 事件信封的 schema 版本（架构 §7.1 `EventEnvelope.v`）。 */
export const EVENT_SCHEMA_VERSION = 1 as const

const ApprovalDecision = z.enum(['allow_once', 'allow_session', 'allow_project', 'deny'])

/**
 * 每种事件的 payload schema。
 * M0 用到的事件（session / run / step / turn / message / usage）给出完整定义；
 * 其余事件给出当前设计确定的最小字段，后续阶段只能追加可选字段。
 */
const payloadSchemas = {
  // ---------- 会话 ----------
  'session.created': z.object({
    projectId: Id,
    projectPath: z.string().min(1),
    /** agent 实际工作的目录；第一版与 projectPath 相同（架构 §14.3）。 */
    workspacePath: z.string().min(1),
    title: z.string(),
    /** 会话使用的模型（M1-04a）。 */
    model: ModelRef.optional(),
  }),
  'session.renamed': z.object({ title: z.string() }),
  'session.crashed': z.object({ error: ErrorInfo }),
  'session.archived': z.object({}),
  /** 会话要点（Runtime §25.2）。 */
  'session.brief.updated': z.object({
    content: z.string(),
    editedBy: z.enum(['agent', 'user']),
  }),

  // ---------- 运行 ----------
  'run.created': z.object({
    agent: AgentDefinitionRef,
    model: ModelRef,
    mode: RunMode,
    limits: RunLimits,
  }),
  'run.state.changed': z.object({
    from: RunState,
    to: RunState,
    reason: z.string().optional(),
  }),
  'run.disposed': z.object({ reason: z.string().optional() }),
  /** 多 Agent 委派（ADR-0020，第一版预留）。 */
  'run.delegated': z.object({
    childRunId: Id,
    agent: AgentDefinitionRef,
    task: z.string(),
  }),
  'run.child.completed': z.object({
    childRunId: Id,
    status: z.enum(['completed', 'failed', 'aborted']),
    summary: z.string().optional(),
  }),

  // ---------- 步骤（一次模型调用） ----------
  'step.started': z.object({ model: ModelRef }),
  'step.completed': z.object({
    model: ModelRef,
    finishReason: z.enum(['stop', 'tool_calls', 'length', 'aborted', 'error']),
    durationMs: DurationMs,
    usage: TokenUsage.optional(),
  }),

  // ---------- 轮次（一次用户输入到 agent 结束） ----------
  'turn.started': z.object({}),
  'turn.completed': z.object({ durationMs: DurationMs }),
  'turn.aborted': z.object({ reason: z.enum(['user', 'shutdown', 'superseded']) }),
  'turn.failed': z.object({ error: ErrorInfo, retryable: z.boolean() }),
  'turn.limit_reached': z.object({
    limit: RunLimits.keyof(),
    value: z.number().nonnegative(),
  }),

  // ---------- 消息 ----------
  'message.user': z.object({
    messageId: Id,
    content: z.array(ContentPart),
  }),
  /** 实时：助手回复的文本增量。 */
  'message.assistant.delta': z.object({ messageId: Id, text: z.string() }),
  /** 实时：推理内容增量。 */
  'message.reasoning.delta': z.object({ messageId: Id, text: z.string() }),
  'message.assistant.completed': z.object({
    messageId: Id,
    content: z.array(ContentPart),
    reasoning: ReasoningPart.optional(),
    toolCalls: z.array(ToolCall).optional(),
    model: ModelRef,
    /**
     * 本步被停止或出错打断，内容是已收到的部分回复（Runtime §10.2）。只用于显示，不进入发给模型的
     * 历史，也不带工具调用。
     */
    incomplete: z.literal(true).optional(),
  }),

  // ---------- 工具 ----------
  'tool.requested': z.object({ toolCallId: Id, name: Id, input: z.unknown() }),
  'tool.started': z.object({ toolCallId: Id }),
  /** 实时：工具输出增量（如命令的标准输出）。 */
  'tool.output.delta': z.object({
    toolCallId: Id,
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  'tool.completed': z.object({
    toolCallId: Id,
    output: z.array(ContentPart),
    truncated: z.boolean().optional(),
    durationMs: DurationMs,
  }),
  'tool.failed': z.object({ toolCallId: Id, error: ErrorInfo }),
  'tool.cancelled': z.object({
    toolCallId: Id,
    reason: z.enum(['user', 'shutdown', 'timeout', 'approval_cancelled']),
  }),

  // ---------- 审批 ----------
  'approval.requested': z.object({
    approvalId: Id,
    toolCallId: Id,
    matchedRuleIds: z.array(Id),
    reasonCode: z.string().min(1),
  }),
  'approval.resolved': z.object({
    approvalId: Id,
    /** cancelled：应用重启等原因导致未决审批被取消（架构 §10.4）。 */
    decision: z.union([ApprovalDecision, z.literal('cancelled')]),
    decidedBy: z.enum(['user', 'rule', 'system']),
    feedback: z.string().optional(),
  }),

  // ---------- 改动与检查点 ----------
  /** 只引用改动记录 id，不内嵌文件内容（M1-08b）。 */
  'file.changed': z.object({
    changeId: Id,
    path: z.string().min(1),
    kind: FileChangeKind,
    /** 撤销产生的改动：被撤销的改动 id。 */
    revertOf: Id.optional(),
  }),
  'checkpoint.created': z.object({
    checkpointId: Id,
    reason: z.enum(['turn_start', 'before_command', 'before_restore']),
  }),
  'checkpoint.restored': z.object({
    checkpointId: Id,
    truncateConversation: z.boolean(),
  }),

  // ---------- 其他 ----------
  'usage.reported': z.object({ model: ModelRef, usage: TokenUsage }),
  'context.compacted': z.object({
    summary: z.string(),
    coversTurns: z.tuple([Id, Id]),
  }),
  'model.fallback': z.object({ from: ModelRef, to: ModelRef, error: ErrorInfo }),

  // ---------- 计划模式（Runtime §25.1，M3） ----------
  'plan.proposed': z.object({ planId: Id, content: z.string() }),
  'plan.approved': z.object({ planId: Id }),
  'plan.rejected': z.object({ planId: Id, feedback: z.string().optional() }),
  'plan.step.updated': z.object({
    planId: Id,
    stepIndex: z.number().int().nonnegative(),
    status: z.enum(['pending', 'in_progress', 'done', 'skipped']),
  }),
} satisfies Record<string, z.ZodType>

type PayloadSchemas = typeof payloadSchemas

export type EventType = keyof PayloadSchemas
export type EventPayload<T extends EventType> = z.infer<PayloadSchemas[T]>

export const EVENT_TYPES = Object.keys(payloadSchemas) as EventType[]

/** 只用于实时显示、不写数据库的增量事件（架构 §7.3）。 */
export const LIVE_EVENT_TYPES = [
  'message.assistant.delta',
  'message.reasoning.delta',
  'tool.output.delta',
] as const satisfies readonly EventType[]

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number]
export type PersistedEventType = Exclude<EventType, LiveEventType>

const liveTypes: ReadonlySet<string> = new Set(LIVE_EVENT_TYPES)

export function isLiveEventType(type: EventType): type is LiveEventType {
  return liveTypes.has(type)
}

// ---------- 信封 ----------

const headerShape = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  sessionId: Id,
  runId: Id,
  parentRunId: Id.optional(),
  ts: Timestamp,
  turnId: Id.optional(),
  stepId: Id.optional(),
}

/** 宿主发出、尚未由主进程分配 seq 的事件。 */
export interface UnsequencedHeader {
  v: typeof EVENT_SCHEMA_VERSION
  sessionId: string
  runId: string
  parentRunId?: string | undefined
  ts: number
  turnId?: string | undefined
  stepId?: string | undefined
}

/** 会话内单调递增，由主进程分配（架构 §7.1）。 */
export interface SequencedHeader extends UnsequencedHeader {
  seq: number
}

/** 按 type 区分的事件联合；`EventEnvelope<'turn.started'>` 只表示该类型。 */
export type EventEnvelope<T extends EventType = EventType> = T extends EventType
  ? SequencedHeader & { type: T; payload: EventPayload<T> }
  : never

export type UnsequencedEvent<T extends EventType = EventType> = T extends EventType
  ? UnsequencedHeader & { type: T; payload: EventPayload<T> }
  : never

/** 会写入数据库的事件。增量事件在类型上无法赋值给它。 */
export type PersistedEvent = EventEnvelope<PersistedEventType>
export type LiveEvent = EventEnvelope<LiveEventType>

export function isPersistedEvent(event: EventEnvelope): event is PersistedEvent {
  return !isLiveEventType(event.type)
}

function buildUnion(withSeq: boolean) {
  const variants = EVENT_TYPES.map((type) =>
    z.object({
      ...headerShape,
      ...(withSeq ? { seq: z.number().int().nonnegative() } : {}),
      type: z.literal(type),
      payload: payloadSchemas[type],
    }),
  )
  return z.discriminatedUnion('type', variants as [(typeof variants)[number], ...typeof variants])
}

const eventEnvelopeSchema = buildUnion(true)
const unsequencedEventSchema = buildUnion(false)

/** 已分配 seq 的事件 schema，供 IPC 消息定义引用。 */
export const EventEnvelopeSchema = eventEnvelopeSchema as unknown as z.ZodType<EventEnvelope>
/** 宿主发出的事件 schema，供 IPC 消息定义引用。 */
export const UnsequencedEventSchema =
  unsequencedEventSchema as unknown as z.ZodType<UnsequencedEvent>

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: z.ZodError }

/** 运行时校验一条已分配 seq 的事件（来自数据库或主进程推送）。 */
export function parseEvent(input: unknown): ParseResult<EventEnvelope> {
  const result = eventEnvelopeSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data as EventEnvelope }
    : { ok: false, error: result.error }
}

/** 运行时校验一条宿主发出的事件（尚无 seq）。 */
export function parseUnsequencedEvent(input: unknown): ParseResult<UnsequencedEvent> {
  const result = unsequencedEventSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data as UnsequencedEvent }
    : { ok: false, error: result.error }
}

/** 某种事件的 payload schema，供需要单独校验 payload 的场景使用。 */
export function payloadSchemaOf<T extends EventType>(type: T): PayloadSchemas[T] {
  return payloadSchemas[type]
}
