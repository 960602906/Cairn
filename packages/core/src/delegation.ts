/**
 * 委派协议与委派工具（多 Agent 协作设计 §5、§6、§10；ADR-0020、ADR-0030）。
 *
 * 这里负责：
 * - 委派策略的解析与钳位（`resolveDelegationPolicy`）；
 * - 委派前的校验（`validateDelegation`）：目标、深度、并发、循环、重复任务与任务书大小；
 * - 委派工具的说明与参数 schema（`delegateToolSpec`）；
 * - 委派记账（`DelegationSession`）：每轮的子运行数、并发数与重复任务；
 * - 执行一次委派（`runDelegation`）：创建子运行、等待、解析结构化结果、回填父运行。
 *
 * 目标 Agent 的定义、模型、凭据与工具由宿主解析（`host.delegate`）；凭据只在宿主内存中使用，
 * 不进入事件、日志或结果。
 */
import type {
  AgentDefinition,
  AgentDefinitionRef,
  DelegateInput,
  DelegateResult,
  DelegateStatus,
  DelegateUsage,
  DelegationIssue,
  DelegationPolicy,
  DelegationValidation,
  PermissionMode,
  RunLimits,
  RunState,
  TaskBrief,
  TokenUsage,
} from '@cairn/protocol'
import {
  DELEGATE_QUESTION_MAX_CHARS,
  DELEGATE_SUMMARY_MAX_CHARS,
  DELEGATION_DEFAULT_CHILD_BUDGET_SHARE,
  DELEGATION_DEFAULT_MAX_CHILDREN_PER_TURN,
  DELEGATION_DEFAULT_MAX_DEPTH,
  DELEGATION_DEFAULT_MAX_PARALLEL,
  DELEGATION_MAX_CHILDREN_PER_TURN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_MAX_PARALLEL,
  DelegateResult as DelegateResultSchema,
  TASK_BRIEF_CONTEXT_MAX_CHARS,
} from '@cairn/protocol'
import { z } from 'zod'
import type { AgentRunHandle, RunContext, WorkspaceInfo } from './run-supervisor.js'
import { computeChildLimits } from './run-supervisor.js'
import type { RunSupervisor } from './run-supervisor.js'
import type { RuntimeToolSpec } from './runtime.js'
import { billedTokens, estimateCost } from './usage.js'
import { ToolError, ToolErrorCode } from './tools.js'

/** 委派相关错误码：既用于工具失败，也用于宿主的 `host.delegate`。 */
export const DelegationErrorCode = {
  Disabled: 'delegation.disabled',
  AgentNotAllowed: 'delegation.agent_not_allowed',
  AgentNotPublished: 'delegation.agent_not_published',
  DepthExceeded: 'delegation.depth_exceeded',
  CycleDetected: 'delegation.cycle_detected',
  DuplicateTask: 'delegation.duplicate_task',
  ChildrenPerTurnExceeded: 'delegation.children_per_turn_exceeded',
  ParallelExceeded: 'delegation.parallel_exceeded',
  BriefTooLarge: 'delegation.brief_too_large',
  BudgetExceeded: 'delegation.budget_exceeded',
  WorkspaceUnsupported: 'delegation.workspace_unsupported',
  ResultInvalid: 'delegation.result_invalid',
} as const

/** 任务书总量的上限（各字段之和），避免把父运行上下文挤进子运行。 */
export const TASK_BRIEF_TOTAL_MAX_CHARS = TASK_BRIEF_CONTEXT_MAX_CHARS * 2

const clampInt = (
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

const clampNumber = (
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

/** 补全并钳位委派策略；省略的字段取默认值，数值不超过全局硬上限。 */
export function resolveDelegationPolicy(
  policy: Partial<DelegationPolicy> | undefined,
): DelegationPolicy {
  return {
    enabled: policy?.enabled ?? false,
    allowedAgents: [...(policy?.allowedAgents ?? [])],
    maxDepth: clampInt(policy?.maxDepth, 0, DELEGATION_MAX_DEPTH, DELEGATION_DEFAULT_MAX_DEPTH),
    maxChildrenPerTurn: clampInt(
      policy?.maxChildrenPerTurn,
      1,
      DELEGATION_MAX_CHILDREN_PER_TURN,
      DELEGATION_DEFAULT_MAX_CHILDREN_PER_TURN,
    ),
    maxParallel: clampInt(
      policy?.maxParallel,
      1,
      DELEGATION_MAX_PARALLEL,
      DELEGATION_DEFAULT_MAX_PARALLEL,
    ),
    childBudgetShare: clampNumber(
      policy?.childBudgetShare,
      0,
      1,
      DELEGATION_DEFAULT_CHILD_BUDGET_SHARE,
    ),
    defaultWorkspace: policy?.defaultWorkspace ?? 'auto',
    mergeReview: policy?.mergeReview ?? 'user',
  }
}

/** 委派链上的一环：根运行为 0，子运行 +1。 */
export interface DelegationChain {
  readonly agentIds: readonly string[]
  readonly depth: number
  /**
   * 这条链上沿用的深度上限（M4-02）：取祖先策略与当前策略的最小值。省略时只用当前策略。
   */
  readonly maxDepth?: number
}

export interface ValidateDelegationInput {
  readonly policy: DelegationPolicy
  readonly input: DelegateInput
  /** 委派链（含当前父运行）。 */
  readonly chain: DelegationChain
  /** 本轮已派出的子运行数。 */
  readonly childrenThisTurn: number
  /** 当前并行的子运行数。 */
  readonly runningChildren: number
  /** 本轮中同一 “目标 Agent + 任务” 已经出现的次数。 */
  readonly duplicateCount: number
  /** 目标 Agent 是否已发布；省略时不做这项检查。 */
  readonly targetPublished?: boolean
  /** 父运行本轮的剩余限额；给出时检查任务书预算是否超发。 */
  readonly parentRemaining?: Partial<RunLimits>
}

const issue = (
  code: string,
  params?: Record<string, string | number | boolean>,
  severity: DelegationIssue['severity'] = 'error',
): DelegationIssue => ({ code, severity, ...(params ? { params } : {}) })

/** 任务书的总字符数（只算文本字段），用于大小上限检查。 */
export function taskBriefSize(brief: TaskBrief): number {
  const text = [brief.goal, brief.context ?? '', brief.deliverable]
  return (
    text.reduce((sum, value) => sum + [...value].length, 0) +
    (brief.files ?? []).reduce((sum, value) => sum + [...value].length, 0) +
    (brief.constraints ?? []).reduce((sum, value) => sum + [...value].length, 0)
  )
}

/**
 * 委派前校验（设计 §5、§10.3）。返回全部问题；`ok` 表示没有 `error` 级别的问题。
 * 目标是否已发布由调用方解析后通过 `targetPublished` 给出。
 */
export function validateDelegation(input: ValidateDelegationInput): DelegationValidation {
  const { policy, input: delegate, chain, childrenThisTurn, runningChildren } = input
  const issues: DelegationIssue[] = []

  if (!policy.enabled) issues.push(issue(DelegationErrorCode.Disabled))
  if (!policy.allowedAgents.includes(delegate.agent)) {
    issues.push(issue(DelegationErrorCode.AgentNotAllowed, { agent: delegate.agent }))
  }
  if (input.targetPublished === false) {
    issues.push(issue(DelegationErrorCode.AgentNotPublished, { agent: delegate.agent }))
  }
  const maxDepth =
    chain.maxDepth === undefined ? policy.maxDepth : Math.min(chain.maxDepth, policy.maxDepth)
  if (chain.depth + 1 > maxDepth) {
    issues.push(
      issue(DelegationErrorCode.DepthExceeded, {
        depth: chain.depth + 1,
        maxDepth,
      }),
    )
  }
  if (chain.agentIds.includes(delegate.agent)) {
    issues.push(issue(DelegationErrorCode.CycleDetected, { agent: delegate.agent }))
  }
  if (input.duplicateCount >= 3) {
    issues.push(issue(DelegationErrorCode.DuplicateTask, { agent: delegate.agent }))
  } else if (input.duplicateCount === 2) {
    // 设计 §10.3：同一轮重复出现时先提醒父 Agent，再次重复才拒绝。
    issues.push(issue(DelegationErrorCode.DuplicateTask, { agent: delegate.agent }, 'warning'))
  }
  if (childrenThisTurn >= policy.maxChildrenPerTurn) {
    issues.push(
      issue(DelegationErrorCode.ChildrenPerTurnExceeded, {
        children: childrenThisTurn,
        maxChildrenPerTurn: policy.maxChildrenPerTurn,
      }),
    )
  }
  if (runningChildren >= policy.maxParallel) {
    issues.push(
      issue(DelegationErrorCode.ParallelExceeded, {
        running: runningChildren,
        maxParallel: policy.maxParallel,
      }),
    )
  }
  const size = taskBriefSize(delegate.brief)
  if (size > TASK_BRIEF_TOTAL_MAX_CHARS) {
    issues.push(
      issue(DelegationErrorCode.BriefTooLarge, {
        size,
        max: TASK_BRIEF_TOTAL_MAX_CHARS,
      }),
    )
  }
  if (resolveDelegationWorkspace(policy, delegate) === 'isolated') {
    // 隔离工作区在 M4-08 落地；在此之前的委派只能共享父运行的工作区。
    issues.push(issue(DelegationErrorCode.WorkspaceUnsupported))
  }
  const budget = delegate.brief.budget
  const remaining = input.parentRemaining
  if (budget && remaining) {
    const exceeded = (key: keyof RunLimits): boolean => {
      const requested = budget[key]
      const available = remaining[key]
      return typeof requested === 'number' && typeof available === 'number' && requested > available
    }
    if (
      exceeded('maxStepsPerTurn') ||
      exceeded('maxTokensPerTurn') ||
      exceeded('maxCostPerTurn') ||
      exceeded('maxTurnDurationMs')
    ) {
      issues.push(issue(DelegationErrorCode.BudgetExceeded))
    }
  } else if (
    remaining &&
    (remaining.maxStepsPerTurn === 0 ||
      remaining.maxTokensPerTurn === 0 ||
      remaining.maxCostPerTurn === 0 ||
      remaining.maxTurnDurationMs === 0)
  ) {
    // 父运行已经没有可用预算：即使任务书没有写预算，也不能再分派。
    issues.push(issue(DelegationErrorCode.BudgetExceeded))
  }

  const ok = !issues.some((entry) => entry.severity === 'error')
  return { ok, issues }
}

/** 子运行的工作区方式：`auto` 由目标 Agent 的权限决定；M4-02 只支持共享工作区。 */
export function resolveDelegationWorkspace(
  policy: DelegationPolicy,
  input: DelegateInput,
): 'shared' | 'isolated' {
  const requested = input.workspace ?? policy.defaultWorkspace
  return requested === 'isolated' ? 'isolated' : 'shared'
}

/** 可委派目标：工具说明里列出名称与描述，帮助模型选择。 */
export interface DelegateTargetInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 目标 Agent 的权限模式（M4-03）：写入类目标在委派前需要审批。 */
  readonly permissions?: PermissionMode
}

/** `delegate` 工具给模型看的名称。 */
export const DELEGATE_TOOL_NAME = 'delegate'

/** 构造 `delegate` 工具的 `inputSchema`（与 `DelegateInput` 对齐）。 */
export function delegateInputSchema(): Readonly<Record<string, unknown>> {
  const brief: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the sub-agent must accomplish.' },
      context: { type: 'string', description: 'Relevant background the sub-agent cannot see.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files to inspect first.' },
      constraints: { type: 'array', items: { type: 'string' } },
      deliverable: { type: 'string', description: 'What the result should contain.' },
      budget: {
        type: 'object',
        properties: {
          maxStepsPerTurn: { type: 'integer', minimum: 1 },
          maxTurnDurationMs: { type: 'integer', minimum: 1 },
          maxTokensPerTurn: { type: 'integer', minimum: 1 },
          maxCostPerTurn: { type: 'number', minimum: 0 },
          maxConsecutiveToolErrors: { type: 'integer', minimum: 1 },
        },
      },
    },
    required: ['goal', 'deliverable'],
  }
  return {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Target agent definition id. Must be one of the available agents.',
      },
      task: { type: 'string', description: 'One-line summary of the sub-task.' },
      brief: { ...brief, description: 'The structured task brief.' },
      workspace: { type: 'string', enum: ['shared', 'isolated'] },
    },
    required: ['agent', 'task', 'brief'],
  }
}

const describeTargets = (targets: readonly DelegateTargetInfo[]): string =>
  targets.map((target) => `- ${target.id}: ${target.name} — ${target.description}`).join('\n')

/** 构造交给模型的 `delegate` 工具说明；没有可委派目标时返回 undefined。 */
export function delegateToolSpec(
  targets: readonly DelegateTargetInfo[],
): RuntimeToolSpec | undefined {
  if (targets.length === 0) return undefined
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      'Delegate a focused sub-task to another agent and wait for its structured result. ' +
      'Use it when a task can be split into independent read-only work. The sub-agent only ' +
      'sees the task brief, not this conversation. Available agents:\n' +
      describeTargets(targets),
    inputSchema: delegateInputSchema(),
    parallel: true,
  }
}

/** 委派记账：每个父运行一份，跟踪深度链、每轮子运行数、并发数与重复任务。 */
export class DelegationSession {
  readonly policy: DelegationPolicy
  readonly chain: DelegationChain
  readonly #parent: AgentRunHandle
  #childrenThisTurn = 0
  #running = 0
  readonly #dispatched = new Map<string, number>()

  constructor(options: {
    readonly policy: DelegationPolicy
    readonly parent: AgentRunHandle
    readonly chain: DelegationChain
  }) {
    this.policy = options.policy
    this.#parent = options.parent
    this.chain = options.chain
    // 父运行进入新一轮时清空每轮计数与重复记录。
    this.#parent.onEvent((event) => {
      if (event.type === 'turn.started') this.beginTurn()
    })
  }

  /** 清空每轮计数与重复记录。 */
  beginTurn(): void {
    this.#childrenThisTurn = 0
    this.#dispatched.clear()
  }

  /** 当前并行的子运行数。 */
  get runningChildren(): number {
    return this.#running
  }

  /** 当前轮已派出的子运行数。 */
  get childrenThisTurn(): number {
    return this.#childrenThisTurn
  }

  /** 校验一次委派；`parentRemaining` 用于预算检查。 */
  validate(
    input: DelegateInput,
    options: {
      readonly targetPublished?: boolean
      readonly parentRemaining?: Partial<RunLimits>
    } = {},
  ): DelegationValidation {
    return validateDelegation({
      policy: this.policy,
      input,
      chain: this.chain,
      childrenThisTurn: this.#childrenThisTurn,
      runningChildren: this.#running,
      duplicateCount: this.#dispatched.get(dispatchKey(input)) ?? 0,
      ...(options.targetPublished !== undefined
        ? { targetPublished: options.targetPublished }
        : {}),
      ...(options.parentRemaining ? { parentRemaining: options.parentRemaining } : {}),
    })
  }

  /** 记一次委派（成功创建子运行前调用）。 */
  record(input: DelegateInput): void {
    const key = dispatchKey(input)
    this.#dispatched.set(key, (this.#dispatched.get(key) ?? 0) + 1)
    this.#childrenThisTurn += 1
  }

  /** 进入 / 离开并行计数。 */
  enter(): void {
    this.#running += 1
  }

  leave(): void {
    this.#running = Math.max(0, this.#running - 1)
  }
}

const dispatchKey = (input: DelegateInput): string => `${input.agent}\u0000${input.task}`

/** 宿主要为一次委派解析的目标：已发布定义 + 运行上下文 + 工作区。 */
export interface DelegationTarget {
  readonly definition: AgentDefinition
  readonly context: RunContext
  readonly workspace: WorkspaceInfo
}

export interface RunDelegationInput {
  readonly sessionId: string
  readonly supervisor: RunSupervisor
  readonly parent: AgentRunHandle
  readonly session: DelegationSession
  readonly target: DelegationTarget
  readonly input: DelegateInput
  /** 父运行本轮的剩余限额，用于计算子运行预算。 */
  readonly parentRemaining: Partial<RunLimits>
  /** 子运行本轮的系统提示词（带结果格式说明）。 */
  readonly systemPrompt: string
  /** 子运行创建后回调（宿主用它给嵌套委派绑定运行句柄）。 */
  readonly onChildCreated?: (child: AgentRunHandle) => void
  readonly now?: () => number
  readonly createId?: () => string
}

const textOf = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')

/** 子运行被要求返回的 JSON 信封。 */
const childEnvelope = z
  .object({
    status: z.enum(['completed', 'needs_input']).optional(),
    summary: z.string().min(1).max(DELEGATE_SUMMARY_MAX_CHARS),
    output: z.unknown().optional(),
    question: z.string().max(DELEGATE_QUESTION_MAX_CHARS).optional(),
  })
  .strict()

/** 子运行的固定系统提示词后缀：要求只返回 JSON 信封。 */
export const DELEGATE_RESULT_INSTRUCTION =
  'Return your final answer as a single JSON object with keys: ' +
  '{"status":"completed"|"needs_input","summary":string,"output"?:unknown,"question"?:string}. ' +
  'Do not wrap it in Markdown code fences. "summary" must be a concise result for the parent agent.'

const textPart = (text: string) => [{ type: 'text' as const, text }]

function toStatus(value: string | undefined): DelegateStatus {
  return value === 'needs_input' ? 'needs_input' : 'completed'
}

/** 从子运行的最后一条回复解析结构化结果；失败时返回 undefined。 */
export function parseDelegateReply(
  reply: string,
  outputSchema?: Readonly<Record<string, unknown>>,
):
  | {
      readonly status: DelegateStatus
      readonly summary: string
      readonly output?: unknown
      readonly question?: string
    }
  | undefined {
  const trimmed = reply.trim()
  const candidates = [trimmed]
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  if (fenced?.[1]) candidates.push(fenced[1])
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const envelope = childEnvelope.safeParse(parsed)
    if (!envelope.success) continue
    if (outputSchema && envelope.data.output !== undefined) {
      try {
        const schema = z.fromJSONSchema(outputSchema as z.core.JSONSchema.JSONSchema)
        if (!schema.safeParse(envelope.data.output).success) continue
      } catch {
        // 输出 schema 不受支持时不做结构校验，只保留摘要。
      }
    }
    return {
      status: toStatus(envelope.data.status),
      summary: envelope.data.summary,
      ...(envelope.data.output !== undefined ? { output: envelope.data.output } : {}),
      ...(envelope.data.question !== undefined ? { question: envelope.data.question } : {}),
    }
  }
  return undefined
}

export interface ChildTurnSummary {
  readonly reply: string | undefined
  readonly usage: TokenUsage
  readonly steps: number
  readonly durationMs: number
}

/** 汇总子运行的回复与用量（从 `run.*` 事件读取；时间取事件信封）。 */
export function summarizeChildTurn(
  events: readonly { readonly type: string; readonly payload: unknown; readonly ts: number }[],
): ChildTurnSummary {
  let reply: string | undefined
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let steps = 0
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'step.started') steps += 1
    else if (event.type === 'message.assistant.completed') {
      const content = payload['content']
      if (Array.isArray(content)) {
        reply = textOf(content as never)
      }
    } else if (event.type === 'usage.reported') {
      const reported = payload['usage'] as TokenUsage | undefined
      if (reported) {
        usage = {
          inputTokens: usage.inputTokens + reported.inputTokens,
          outputTokens: usage.outputTokens + reported.outputTokens,
        }
      }
    } else if (event.type === 'turn.started') {
      startedAt = event.ts
    } else if (
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.aborted'
    ) {
      endedAt = event.ts
    }
  }
  return {
    reply,
    usage,
    steps,
    durationMs:
      startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : 0,
  }
}

/** 从一轮事件里解析子运行的结构化结果；没有回复时返回 undefined。 */
function parseReplyOf(
  events: readonly { readonly type: string; readonly payload: unknown; readonly ts: number }[],
  outputSchema: Readonly<Record<string, unknown>> | undefined,
): ReturnType<typeof parseDelegateReply> {
  const reply = summarizeChildTurn(events).reply
  return reply ? parseDelegateReply(reply, outputSchema) : undefined
}

/**
 * 子运行的结果状态：限额 / 中止 / 失败以事件为准，否则采用结构化信封里的状态。
 * `turn.limit_reached` 之后还会发 `turn.failed`，所以先判断限额。
 */
function childStatus(
  state: RunState,
  events: readonly { readonly type: string }[],
  parsed: ReturnType<typeof parseDelegateReply>,
): DelegateStatus {
  const has = (type: string) => events.some((event) => event.type === type)
  if (has('turn.limit_reached')) return 'limit_reached'
  if (has('turn.aborted')) return 'aborted'
  if (has('turn.failed') || state === 'failed') return 'failed'
  if (state === 'interrupted' || state === 'aborting') return 'aborted'
  return parsed?.status ?? 'completed'
}

/** 父运行的任一剩余限额已经归零（M4-03）：不再分派，正在运行的子运行一起停止。 */
function limitsExhausted(remaining: Partial<RunLimits> | undefined): boolean {
  if (!remaining) return false
  return (
    remaining.maxStepsPerTurn === 0 ||
    remaining.maxTokensPerTurn === 0 ||
    remaining.maxCostPerTurn === 0 ||
    remaining.maxTurnDurationMs === 0
  )
}

/**
 * 执行一次委派（设计 §5、§6、§12）：
 * 创建子运行 → 进入 `awaiting_children` → 发送任务书 → 等待 → 解析结构化结果 → 回填父运行。
 * 不把子运行的对话历史交给父运行。
 */
export async function runDelegation(input: RunDelegationInput): Promise<DelegateResult> {
  const { supervisor, parent, session, target, input: delegate, parentRemaining } = input
  const now = input.now ?? Date.now
  const agentRef: AgentDefinitionRef = {
    id: target.definition.id,
    version: target.definition.version,
  }
  const limits = computeChildLimits({
    childAgentLimits: target.definition.limits,
    taskLimits: delegate.brief.budget,
    parentRemainingLimits: parentRemaining,
    childBudgetShare: session.policy.childBudgetShare,
  })

  const child = await supervisor.createRun({
    sessionId: input.sessionId,
    agent: agentRef,
    workspace: target.workspace,
    parentRunId: parent.runId,
    mode: 'interactive',
    limitsOverride: limits,
    context: { ...target.context, systemPrompt: input.systemPrompt },
  })
  input.onChildCreated?.(child)

  session.record(delegate)
  session.enter()
  parent.emitEvent('run.delegated', {
    childRunId: child.runId,
    agent: agentRef,
    task: delegate.task,
    workspace: resolveDelegationWorkspace(session.policy, delegate),
    workspacePath: child.workspace.path,
    budget: limits,
  })

  const collected: { type: string; payload: unknown; ts: number }[] = []
  const off = child.onEvent((event) => {
    collected.push({ type: event.type, payload: event.payload, ts: event.ts })
  })
  const startedAt = now()
  /** 一轮里收集到的事件；用于在修正轮里只看最后一次回复。 */
  const runTurn = async (
    content: readonly { type: 'text'; text: string }[],
    messageId: string,
  ): Promise<{ type: string; payload: unknown; ts: number }[]> => {
    const start = collected.length
    await parent.awaitChildren(async () => {
      await child.send({ messageId, content })
    })
    return collected.slice(start)
  }

  let turnEvents: { type: string; payload: unknown; ts: number }[]
  try {
    turnEvents = await runTurn(textPart(briefPrompt(delegate)), `${child.runId}-brief`)
    let parsed = parseReplyOf(turnEvents, delegate.brief.outputSchema)
    // 结构不合规时让子运行修正一次（设计 §5）；仍不合规就把原文当作摘要。
    if (!parsed && delegate.brief.outputSchema && child.state === 'completed') {
      const correction: { type: 'text'; text: string }[] = [
        {
          type: 'text',
          text:
            'Your previous reply could not be parsed as the required JSON object. ' +
            'Reply again with only the JSON object described in the system prompt.',
        },
      ]
      const retried = await runTurn(correction, `${child.runId}-brief-retry`)
      turnEvents = [...turnEvents, ...retried]
      parsed = parseReplyOf(retried, delegate.brief.outputSchema)
    }
    const summary = summarizeChildTurn(turnEvents)
    const usage: DelegateUsage = {
      tokens: billedTokens(summary.usage),
      durationMs: Math.max(0, now() - startedAt),
      steps: summary.steps,
      ...(target.context.model?.profile.pricing
        ? { cost: estimateCost(summary.usage, target.context.model.profile.pricing) }
        : {}),
    }
    parent.recordChildUsage(summary.usage)
    const parentAtLimit = limitsExhausted(parent.remainingLimits)
    const status = parentAtLimit ? 'limit_reached' : childStatus(child.state, collected, parsed)
    if (parentAtLimit) {
      // 父运行没有预算了：同一父运行下的其他子运行也停止（M4-03）。
      await Promise.all(
        supervisor
          .listChildren(parent.runId)
          .filter((sibling) => sibling.runId !== child.runId)
          .map((sibling) => sibling.abort('user')),
      )
    }
    parent.emitEvent('run.child.completed', {
      childRunId: child.runId,
      status,
      ...(parsed?.summary || summary.reply ? { summary: parsed?.summary ?? summary.reply } : {}),
      usage: summary.usage,
      ...(parsed?.question ? { issues: [parsed.question] } : {}),
    })

    const result: DelegateResult = {
      status,
      summary:
        parsed?.summary ??
        (summary.reply && summary.reply.length > 0
          ? summary.reply.slice(0, DELEGATE_SUMMARY_MAX_CHARS)
          : undefined) ??
        (status === 'completed'
          ? 'Sub-agent finished without a textual answer.'
          : 'Sub-agent did not finish.'),
      ...(parsed?.output !== undefined ? { output: parsed.output } : {}),
      ...(parsed?.question !== undefined ? { question: parsed.question } : {}),
      usage,
      childRunId: child.runId,
    }
    // 最后按协议校验一次，避免把不合规的结果交给模型。
    const checked = DelegateResultSchema.safeParse(result)
    if (!checked.success) {
      throw new ToolError(ToolErrorCode.ExecutionFailed, 'Delegation produced an invalid result.')
    }
    return checked.data
  } finally {
    off()
    session.leave()
  }
}

/** 交给子运行的用户消息：任务书。 */
export function briefPrompt(input: DelegateInput): string {
  const { brief } = input
  const lines = [`# Task`, brief.goal, '', `## Deliverable`, brief.deliverable]
  if (brief.context) lines.push('', '## Context', brief.context)
  if (brief.files && brief.files.length > 0) {
    lines.push('', '## Files to inspect first', ...brief.files.map((file) => `- ${file}`))
  }
  if (brief.constraints && brief.constraints.length > 0) {
    lines.push('', '## Constraints', ...brief.constraints.map((entry) => `- ${entry}`))
  }
  return lines.join('\n')
}
