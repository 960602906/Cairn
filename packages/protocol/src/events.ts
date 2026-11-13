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
import { PLAN_STEP_MAX, PlanDocument, PlanStep, PlanStepStatus } from './plan.js'
import {
  AgentDefinitionRef,
  RunAgentRef,
  ContentPart,
  DurationMs,
  ErrorInfo,
  Id,
  ModelRef,
  PromptAgent,
  PromptSkill,
  ReasoningPart,
  ResolvedMention,
  RunLimits,
  RunMode,
  RunState,
  Timestamp,
  TokenUsage,
  ToolCall,
} from './common.js'
import { FileChangeKind } from './changes.js'
import { CheckpointReason } from './checkpoints.js'
import { BackgroundCommandStatus } from './commands.js'
import { SandboxExecution } from './sandbox.js'

/** 事件信封的 schema 版本（架构 §7.1 `EventEnvelope.v`）。 */
export const EVENT_SCHEMA_VERSION = 1 as const

/** 工具输出的一段（标准输出或标准错误）。 */
export const ToolOutputChunk = z.object({
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
})
export type ToolOutputChunk = z.infer<typeof ToolOutputChunk>

/**
 * 只给界面显示的工具结果（M2-06），不进入发给模型的历史。`terminal`：`run_command` 的原始输出
 * （保留 ANSI 控制符，用于着色）与执行信息；输出过长时保留开头和结尾，`omittedAt` 是省略处之后
 * 第一段的下标。
 */
export const ToolDisplay = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('terminal'),
    exitCode: z.number().int().nullable(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    durationMs: DurationMs,
    shell: z.string(),
    cwd: z.string(),
    /** 实际使用的沙箱（M5-04）；旧数据没有这个字段时按“未知/未启用”展示。 */
    sandbox: SandboxExecution.optional(),
    chunks: z.array(ToolOutputChunk),
    omittedChars: z.number().int().nonnegative(),
    omittedAt: z.number().int().nonnegative().optional(),
  }),
])
export type ToolDisplay = z.infer<typeof ToolDisplay>

/** 审批的决定（架构 §10.4）：允许一次、本会话始终允许、本项目始终允许、拒绝。 */
export const ApprovalDecision = z.enum(['allow_once', 'allow_session', 'allow_project', 'deny'])
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

/**
 * 本轮读到的 `AGENTS.md`（M3-02）。`sha256` 是纳入提示词的字节（截断时是前缀）的哈希，
 * `bytes` 是文件的完整大小，`lines` 是纳入的行数（不含截断说明）。
 */
export const AgentsMdContext = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  lines: z.number().int().positive(),
})
export type AgentsMdContext = z.infer<typeof AgentsMdContext>

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
  /**
   * 重命名会话。`source` 为 `auto` 时是自动标题（M3-01）；省略或 `user` 表示用户改过，
   * 之后不再自动改标题。
   */
  'session.renamed': z.object({
    title: z.string(),
    source: z.enum(['user', 'auto']).optional(),
  }),
  /** 会话换了模型（M2-04），从下一轮起使用。 */
  'session.model.changed': z.object({ model: ModelRef }),
  'session.crashed': z.object({ error: ErrorInfo }),
  'session.archived': z.object({}),
  /** 会话要点（Runtime §25.2）。 */
  'session.brief.updated': z.object({
    content: z.string(),
    editedBy: z.enum(['agent', 'user']),
  }),

  // ---------- 运行 ----------
  'run.created': z.object({
    agent: RunAgentRef,
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
  /** 多 Agent 委派（ADR-0020、ADR-0030）。 */
  'run.delegated': z.object({
    childRunId: Id,
    agent: AgentDefinitionRef,
    task: z.string(),
    workspace: z.enum(['shared', 'isolated', 'auto']).optional(),
    workspacePath: z.string().optional(),
    /** 这次子运行可用的限额（M4-03）；界面据此显示并行分派的预计最大消耗。 */
    budget: RunLimits.optional(),
  }),
  'run.child.completed': z.object({
    childRunId: Id,
    status: z.enum(['completed', 'failed', 'aborted', 'needs_input', 'limit_reached']),
    summary: z.string().optional(),
    usage: TokenUsage.optional(),
    changeSetId: Id.optional(),
    issues: z.array(z.string()).optional(),
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
  /** 没有读到 `AGENTS.md` 时 `context` 不出现（M3-02）。 */
  'turn.started': z.object({
    context: z
      .object({
        agentsMd: AgentsMdContext.optional(),
      })
      .optional(),
  }),
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
    /** 展开成功的 `@` 引用（ADR-0037），界面用它高亮消息里的引用。 */
    mentions: z.array(ResolvedMention).optional(),
    /** 这一轮使用的技能（`/技能名`）；界面在消息气泡里显示标记。 */
    skills: z.array(PromptSkill).optional(),
    /** 这一轮要求委派的 Agent（`@Agent名`）；界面用来高亮引用。 */
    agents: z.array(PromptAgent).optional(),
    /**
     * 引用展开后的上下文。只发给模型（接在 `content` 之后），界面不显示；
     * 恢复会话重建历史时同样带上，保证模型看到的输入前后一致。
     */
    context: z.string().optional(),
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
  'tool.started': z.object({ toolCallId: Id, sandbox: SandboxExecution.optional() }),
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
    /** 只给界面显示（M2-06）。 */
    display: ToolDisplay.optional(),
    /**
     * `load_skill` 成功时记下名称与 `SKILL.md` 的内容哈希（M3-07）。
     * 没有这个字段的完成事件不是加载技能。
     */
    skill: z
      .object({
        name: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
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
    /**
     * 按块撤销（M3-06）时，被撤销的是 `revertOf` 那条改动的第几块（0 起）。
     * 没有这个字段的撤销是整文件撤销。
     */
    hunkIndex: z.number().int().nonnegative().optional(),
  }),
  'checkpoint.created': z.object({
    checkpointId: Id,
    reason: CheckpointReason,
  }),
  'checkpoint.restored': z.object({
    checkpointId: Id,
    truncateConversation: z.boolean(),
  }),

  // ---------- 改动集（M4-09，ADR-0031） ----------
  /**
   * 子运行在隔离工作区里的改动已算出。挂在父运行上（`runId` 为父运行 id），并带子运行 id；
   * 在 `run.child.completed` 之前写入，界面据此把改动集与子运行对应起来。
   */
  'changeset.created': z.object({
    changeSetId: Id,
    childRunId: Id,
    /** 改动的文件数。 */
    files: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  /** 改动集已合并到主工作区；`checkpointCommit` 是合并前创建的检查点，恢复它即可回退。 */
  'changeset.applied': z.object({
    changeSetId: Id,
    paths: z.array(z.string()),
    checkpointCommit: z.string().optional(),
  }),
  /** 改动集被整体拒绝。 */
  'changeset.rejected': z.object({ changeSetId: Id }),
  /** 某个文件与主工作区冲突；`resolution` 为 `pending` 表示尚未处理。 */
  'changeset.conflict': z.object({
    changeSetId: Id,
    path: z.string(),
    resolution: z.enum(['pending', 'keep-main', 'take-child', 'manual']),
  }),

  // ---------- 其他 ----------
  /**
   * 一次模型调用的用量。`auxiliary`（M3-01）表示后台补全（标题、会话要点、压缩摘要）：计入会话 token 统计，
   * 不更新上下文圆环（圆环只看主模型最近一次用量）。
   */
  'usage.reported': z.object({
    model: ModelRef,
    usage: TokenUsage,
    auxiliary: z.literal(true).optional(),
  }),
  /**
   * 上下文已压缩（M3-03，Runtime §8.3）。原始事件保留，界面仍显示完整历史。
   * `degraded`：摘要失败，改成丢掉 `omittedToolCallIds` 的工具输出。
   * `replacedSeq` 是被摘要替换的事件 seq 范围（含端点）。`tokensBefore` / `tokensAfter`
   * 是压缩前后的估算占用（系统提示词、工具定义与历史）。
   */
  'context.compacted': z.object({
    summary: z.string(),
    coversTurns: z.tuple([Id, Id]),
    replacedSeq: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    tokensBefore: z.number().int().nonnegative().optional(),
    tokensAfter: z.number().int().nonnegative().optional(),
    degraded: z.literal(true).optional(),
    omittedToolCallIds: z.array(Id).optional(),
  }),
  'model.fallback': z.object({ from: ModelRef, to: ModelRef, error: ErrorInfo }),
  'command.started': z.object({
    commandId: Id,
    command: z.string(),
    cwd: z.string(),
    sandbox: SandboxExecution.optional(),
  }),
  'command.output.delta': z.object({
    commandId: Id,
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  'command.exited': z.object({
    commandId: Id,
    status: BackgroundCommandStatus,
    exitCode: z.number().int().nullable(),
  }),
  'command.stopped': z.object({ commandId: Id }),
  /**
   * 模型请求失败且可以重试（网络、限流、5xx），等待 `delayMs` 后重新请求（M1-14a，架构 §21）。
   * `attempt` 从 1 起，不超过 `maxRetries`；重试耗尽后本轮以 `turn.failed` 结束。
   */
  'model.retry': z.object({
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().positive(),
    delayMs: DurationMs,
    error: ErrorInfo,
  }),

  // ---------- 计划模式（Runtime §25.1，M3-05） ----------
  /** 模型调用 `propose_plan` 后写入。`content.markdown` 是给界面显示的原文。 */
  'plan.proposed': z.object({ planId: Id, content: PlanDocument }),
  /**
   * 用户批准。`content` 是批准时的计划（步骤标题可能被改过）；省略时沿用 `plan.proposed`。
   */
  'plan.approved': z.object({ planId: Id, content: PlanDocument.optional() }),
  'plan.rejected': z.object({ planId: Id, feedback: z.string().optional() }),
  /** 执行时按用户的新消息调整步骤；同 id 的步骤保留进度，新步骤从 pending 开始。 */
  'plan.steps.revised': z.object({
    planId: Id,
    steps: z.array(PlanStep).min(1).max(PLAN_STEP_MAX),
  }),
  'plan.step.updated': z.object({
    planId: Id,
    /** 新事件用步骤 id 定位，旧事件仍按 index 重放。 */
    stepId: PlanStep.shape.id.optional(),
    stepIndex: z.number().int().nonnegative(),
    status: PlanStepStatus,
    /** 模型对这一步的说明。偏离计划时写在这里，不阻止执行。 */
    note: z.string().max(2_000).optional(),
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
  'command.output.delta',
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
