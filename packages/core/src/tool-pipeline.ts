/**
 * 工具执行流水线（M1-05b；Runtime §7）。每个工具调用依次经过十个阶段：
 *
 * | 阶段 | 内容 | 失败时（结果交回模型） |
 * |---|---|---|
 * | 1. 解析 | 找到工具定义 | `tool.not_found` |
 * | 2. 参数校验 | 按 `inputSchema` 校验 | `tool.invalid_input`，附问题说明 |
 * | 3. 可用性 | 是否在当前 Agent 的允许列表内 | `tool.not_available` |
 * | 4. 规范化 | 工具的 `normalize`：解析路径、命令，得到权限判定用的目标 | 工具给出的错误（如路径越界） |
 * | 5. 权限 | `PermissionGate` 返回 allow / ask / deny | deny → `tool.denied` |
 * | 6. 审批 | ask 时先生成预览，再请求审批（运行进入 `awaiting_approval`） | 拒绝 → `tool.denied`，附用户说明 |
 * | 7. 前置检查点 | 写入与执行类工具在执行前创建检查点 | 失败时请用户确认是否继续，不继续 → `tool.denied` |
 * | 8. 执行 | 带取消信号执行，流式输出；同时执行的调用数受 `maxParallel` 限制 | 工具错误 → 对应错误码；其他异常 → `tool.execution_failed` |
 * | 9. 后处理 | 输出预算：超过上限时保留开头和结尾，中间截断并注明 | — |
 * | 10. 返回 | 结果交回 agent 循环 | — |
 *
 * 任何阶段收到取消信号都返回 `cancelled`。权限（M1-10）、审批（M1-11）、检查点（M1-12）、路径校验
 * （M1-06）通过接口注入。流水线只给出结果，`tool.*` 事件由 RunEngine 按结果发出；审批事件由流水线
 * 经 `emit` 发出。
 */
import type { ContentPart, ErrorInfo, EventPayload } from '@nexus/protocol'
import type { Logger } from './logger.js'
import type { ApprovalDecision } from './run-supervisor.js'
import type { AbortSignalLike, RuntimeToolCall } from './runtime.js'
import {
  ToolError,
  ToolErrorCode,
  type ApprovalPreview,
  type PathResolution,
  type ToolCategory,
  type ToolCheckpoints,
  type ToolContext,
  type ToolDefinition,
  type ToolFileChange,
  type ToolOutput,
  type ToolRegistry,
  type ToolTargets,
} from './tools.js'

export const ToolPipelineErrorCode = {
  NotFound: ToolErrorCode.NotFound,
  InvalidInput: ToolErrorCode.InvalidInput,
  ExecutionFailed: ToolErrorCode.ExecutionFailed,
  /** 不在当前 Agent 的允许列表内。 */
  NotAvailable: 'tool.not_available',
  /** 被权限规则拒绝，或用户拒绝审批。 */
  Denied: 'tool.denied',
} as const

/** 权限判定（M1-10 的 PermissionEngine 实现）。 */
export interface PermissionRequest {
  readonly toolCallId: string
  readonly definition: ToolDefinition
  readonly input: unknown
  readonly targets: ToolTargets
}

export type PermissionDecision =
  | { readonly decision: 'allow' }
  | {
      readonly decision: 'ask' | 'deny'
      /** 判定理由的代码，用于审批界面与拒绝说明。 */
      readonly reasonCode: string
      readonly matchedRuleIds?: readonly string[]
      /** deny 时交给模型的说明（英文）。 */
      readonly reason?: string
    }

export interface PermissionGate {
  decide(request: PermissionRequest): Promise<PermissionDecision>
}

export interface ApprovalRequest {
  readonly approvalId: string
  readonly toolCallId: string
  readonly definition: ToolDefinition
  readonly input: unknown
  readonly targets: ToolTargets
  /** `tool`：权限判定为 ask；`no_checkpoint`：检查点创建失败，确认是否不带检查点继续。 */
  readonly kind: 'tool' | 'no_checkpoint'
  readonly preview?: ApprovalPreview
  readonly reasonCode: string
  readonly signal: AbortSignalLike
}

export interface ApprovalResponse {
  readonly decision: ApprovalDecision
  /** 用户附加的说明，拒绝时交给模型。 */
  readonly feedback?: string
}

/** 审批（M1-11 实现）：等待用户决定；取消信号触发时应尽快返回。 */
export interface ApprovalGate {
  request(request: ApprovalRequest): Promise<ApprovalResponse>
}

/** 流水线对单次调用的回调（RunEngine 提供）。 */
export interface ToolCallObserver {
  /** 进入执行阶段，对应 `tool.started`。 */
  started(): void
  /** 工具的流式输出，对应 `tool.output.delta`。 */
  output(text: string, stream: 'stdout' | 'stderr'): void
  /** 开始与结束等待审批（运行状态在 `tooling` 与 `awaiting_approval` 之间切换）。 */
  awaitingApproval(waiting: boolean): void
  /** 当前轮次，写入改动记录。 */
  readonly turnId?: string
  emit<T extends 'approval.requested' | 'approval.resolved' | 'file.changed'>(
    type: T,
    payload: EventPayload<T>,
  ): void
}

/** 流水线给出的结果：交给模型的内容，以及事件所需的信息。 */
export type ToolOutcome =
  | { readonly status: 'ok'; readonly content: readonly ContentPart[]; readonly truncated: boolean }
  | {
      readonly status: 'error' | 'denied'
      readonly content: readonly ContentPart[]
      readonly error: ErrorInfo
    }
  | { readonly status: 'cancelled'; readonly content: readonly ContentPart[] }

/** 改动记录（M1-08b）：宿主经主进程写入 blob 存储与 `file_changes`。 */
export interface ToolChangeRecorder {
  record(
    change: ToolFileChange & { readonly toolCallId: string; readonly turnId?: string },
  ): Promise<{ changeId: string }>
}

export interface ToolPipelineOptions {
  readonly registry: ToolRegistry
  /** 当前 Agent 是否可以使用该工具（`tools.allow`），默认都可以。 */
  readonly isAvailable?: (definition: ToolDefinition) => boolean
  readonly permissions: PermissionGate
  readonly approvals: ApprovalGate
  readonly checkpoints: ToolCheckpoints
  /** 改动记录；省略时写类工具的改动不留记录。 */
  readonly changes?: ToolChangeRecorder
  readonly workspaceRoot: string
  readonly resolvePath: (input: string) => Promise<PathResolution>
  readonly log: Logger
  /** 交给模型的输出上限（字符数），默认 30 000；按模型上下文动态计算在 M1-13。 */
  readonly maxOutputChars?: number
  /** 同时执行的调用上限，默认 4（Runtime §6.2）；只限制执行阶段，等待审批不占名额。 */
  readonly maxParallel?: number
  readonly createId: () => string
}

export interface ToolPipeline {
  run(
    call: RuntimeToolCall,
    signal: AbortSignalLike,
    observer: ToolCallObserver,
  ): Promise<ToolOutcome>
}

/** 执行前需要检查点的类别（Runtime §7 第 7 阶段）。 */
const CHECKPOINT_CATEGORIES: ReadonlySet<ToolCategory> = new Set(['write', 'execute'])

const DEFAULT_MAX_OUTPUT_CHARS = 30_000
const DEFAULT_MAX_PARALLEL = 4

/** 简单的计数信号量：`acquire` 在有空位时 resolve，返回释放函数。 */
function createLimiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
  return {
    acquire(): Promise<() => void> {
      if (active < max) {
        active++
        return Promise.resolve(release)
      }
      return new Promise((resolve) => waiting.push(() => resolve(release)))
    },
  }
}

const text = (value: string): ContentPart[] => [{ type: 'text', text: value }]

const errorOutcome = (
  code: string,
  message: string,
  params: Record<string, string | number | boolean> = {},
  status: 'error' | 'denied' = 'error',
): ToolOutcome => ({
  status,
  content: text(message),
  error: Object.keys(params).length > 0 ? { code, params } : { code },
})

const cancelled: ToolOutcome = { status: 'cancelled', content: text('Tool call was cancelled.') }

/** 超过上限时保留开头和结尾，中间注明截断的字符数（架构 §9.4）。 */
export function truncateOutput(
  content: readonly ContentPart[],
  maxChars: number,
): { content: ContentPart[]; truncated: boolean } {
  const total = content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0)
  if (total <= maxChars) return { content: [...content], truncated: false }
  const joined = content.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const head = Math.ceil(maxChars / 2)
  const tail = maxChars - head
  const omitted = joined.length - head - tail
  return {
    content: text(
      `${joined.slice(0, head)}\n\n[... ${omitted} characters truncated ...]\n\n${joined.slice(joined.length - tail)}`,
    ),
    truncated: true,
  }
}

/** 中止时 reject，用来与可能不响应信号的等待竞争。 */
function whenAborted(signal: AbortSignalLike): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(new CancelledError())
    signal.addEventListener('abort', listener, { once: true })
  })
  promise.catch(() => undefined)
  return { promise, dispose: () => signal.removeEventListener('abort', listener!) }
}

class CancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

export function createToolPipeline(options: ToolPipelineOptions): ToolPipeline {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const limiter = createLimiter(Math.max(1, options.maxParallel ?? DEFAULT_MAX_PARALLEL))

  /** 等待执行名额；取消时放弃等待（拿到的名额立即归还）。 */
  async function acquireSlot(signal: AbortSignalLike): Promise<() => void> {
    const pending = limiter.acquire()
    try {
      return await guard(signal, () => pending)
    } catch (error) {
      void pending.then((release) => release())
      throw error
    }
  }

  /** 在取消信号与 `work` 之间竞争；取消时抛出 CancelledError。 */
  async function guard<T>(signal: AbortSignalLike, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new CancelledError()
    const aborted = whenAborted(signal)
    try {
      return await Promise.race([work(), aborted.promise])
    } finally {
      aborted.dispose()
    }
  }

  async function approve(
    request: Omit<ApprovalRequest, 'approvalId'>,
    matchedRuleIds: readonly string[],
    observer: ToolCallObserver,
  ): Promise<ApprovalResponse> {
    const approvalId = options.createId()
    observer.awaitingApproval(true)
    observer.emit('approval.requested', {
      approvalId,
      toolCallId: request.toolCallId,
      matchedRuleIds: [...matchedRuleIds],
      reasonCode: request.reasonCode,
    })
    try {
      const response = await guard(request.signal, () =>
        options.approvals.request({ ...request, approvalId }),
      )
      observer.emit('approval.resolved', {
        approvalId,
        decision: response.decision,
        decidedBy: 'user',
        ...(response.feedback ? { feedback: response.feedback } : {}),
      })
      return response
    } catch (error) {
      observer.emit('approval.resolved', { approvalId, decision: 'cancelled', decidedBy: 'system' })
      throw error
    } finally {
      observer.awaitingApproval(false)
    }
  }

  const denied = (reason: string, feedback?: string) =>
    errorOutcome(
      ToolPipelineErrorCode.Denied,
      feedback ? `${reason} User feedback: ${feedback}` : reason,
      { reason },
      'denied',
    )

  async function run(
    call: RuntimeToolCall,
    signal: AbortSignalLike,
    observer: ToolCallObserver,
  ): Promise<ToolOutcome> {
    // 1. 解析
    const definition = options.registry.get(call.name)
    if (!definition) {
      return errorOutcome(ToolPipelineErrorCode.NotFound, `Unknown tool: ${call.name}`, {
        name: call.name,
      })
    }
    // 2. 参数校验
    const validation = options.registry.validate(call.name, call.input)
    if (!validation.ok) {
      return errorOutcome(
        ToolPipelineErrorCode.InvalidInput,
        `Invalid input for tool ${call.name}:\n${validation.issues.map((i) => `- ${i}`).join('\n')}`,
        { name: call.name },
      )
    }
    // 3. 可用性
    if (options.isAvailable && !options.isAvailable(definition)) {
      return errorOutcome(
        ToolPipelineErrorCode.NotAvailable,
        `This agent is not allowed to use tool ${call.name}.`,
        { name: call.name },
      )
    }

    const ctx: ToolContext = {
      workspaceRoot: options.workspaceRoot,
      toolCallId: call.id,
      signal,
      resolvePath: options.resolvePath,
      checkpoints: options.checkpoints,
      log: options.log.child({ toolCallId: call.id, tool: call.name }),
      progress: (chunk, stream = 'stdout') => observer.output(chunk, stream),
      recordChange: async (change) => {
        if (!options.changes) return
        const { changeId } = await options.changes.record({
          ...change,
          toolCallId: call.id,
          ...(observer.turnId === undefined ? {} : { turnId: observer.turnId }),
        })
        observer.emit('file.changed', { changeId, path: change.path, kind: change.kind })
      },
    }

    try {
      // 4. 规范化
      let input = validation.value
      let targets: ToolTargets = {}
      if (definition.normalize) {
        const normalized = await guard(signal, () => definition.normalize!(input, ctx))
        input = normalized.input
        targets = normalized.targets
      }
      // 5. 权限
      const permission = await guard(signal, () =>
        options.permissions.decide({ toolCallId: call.id, definition, input, targets }),
      )
      if (permission.decision === 'deny') {
        return denied(permission.reason ?? `Tool call denied (${permission.reasonCode}).`)
      }
      // 6. 审批
      if (permission.decision === 'ask') {
        const preview = definition.describeForApproval
          ? await guard(signal, () => definition.describeForApproval!(input, ctx))
          : undefined
        const response = await approve(
          {
            toolCallId: call.id,
            definition,
            input,
            targets,
            kind: 'tool',
            ...(preview ? { preview } : {}),
            reasonCode: permission.reasonCode,
            signal,
          },
          permission.matchedRuleIds ?? [],
          observer,
        )
        if (response.decision === 'deny') {
          return denied('The user denied this tool call.', response.feedback)
        }
      }
      // 7. 前置检查点
      if (CHECKPOINT_CATEGORIES.has(definition.category)) {
        try {
          await guard(signal, () => options.checkpoints.create(`before ${call.name}`))
        } catch (error) {
          if (error instanceof CancelledError) throw error
          ctx.log.warn('checkpoint failed', { error: String(error) })
          const response = await approve(
            {
              toolCallId: call.id,
              definition,
              input,
              targets,
              kind: 'no_checkpoint',
              reasonCode: 'checkpoint.failed',
              signal,
            },
            [],
            observer,
          )
          if (response.decision === 'deny') {
            return denied('No checkpoint could be created and the user chose not to continue.')
          }
        }
      }
      // 8. 执行（并行调用受 maxParallel 限制）
      const release = await acquireSlot(signal)
      let output: ToolOutput
      try {
        observer.started()
        output = await guard(signal, () => definition.execute(input, ctx))
      } finally {
        release()
      }
      // 9. 后处理
      const { content, truncated } = truncateOutput(output.content, maxOutputChars)
      // 10. 返回
      return { status: 'ok', content, truncated }
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) return cancelled
      if (error instanceof ToolError) {
        return errorOutcome(error.code, error.message, { ...error.params })
      }
      ctx.log.error('tool threw', { error: String(error) })
      return errorOutcome(
        ToolPipelineErrorCode.ExecutionFailed,
        `Tool ${call.name} failed unexpectedly.`,
        { name: call.name },
      )
    }
  }

  return { run }
}
