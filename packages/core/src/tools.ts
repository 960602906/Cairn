/**
 * 工具定义与注册表（M1-05a；ADR-0017；架构 §9.1；Runtime §7、§21）。
 *
 * - 工具以统一结构注册，与 pi 无关；内置工具、MCP 工具、Skill 附带的能力都适配为 `ToolDefinition`，
 *   经同一条工具流水线（M1-05b）执行。
 * - 参数用 JSON Schema 描述（给模型看，也用于校验）。注册时把 schema 编译为校验器（zod 的
 *   `fromJSONSchema`，不使用 `eval`），schema 不受支持时拒绝注册。
 * - 工具只能通过 `ToolContext` 访问工作区、检查点等外部资源（架构 §9.1）。路径校验（M1-06）、
 *   检查点（M1-12）在这里只定义接口。
 */
import type { ContentPart } from '@nexus/protocol'
import { z } from 'zod'
import type { Logger } from './logger.js'
import type { AbortSignalLike, RuntimeToolSpec } from './runtime.js'

/** 工具类别（架构 §9.1）：权限默认值与并行策略据此决定（只有 `read` 可以并行，Runtime §6.2）。 */
export type ToolCategory = 'read' | 'write' | 'execute' | 'network' | 'delegate'

/** 工具来源（ADR-0017）。 */
export type ToolSource =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'mcp'; readonly serverId: string }
  | { readonly kind: 'skill'; readonly skillId: string }

/** 来源的可信程度（ADR-0017）：权限引擎据此设定默认值，例如第三方工具默认需要审批。 */
export type ToolTrust = 'builtin' | 'user-configured' | 'third-party'

/** JSON Schema 对象（参数定义）。 */
export type JsonSchema = Readonly<Record<string, unknown>>

/** 工作区内的路径（M1-06 的 `resolveWorkspacePath` 给出）。 */
export interface WorkspacePath {
  /** 规范化后的绝对路径。 */
  readonly absolute: string
  /** 相对工作区根目录的路径，使用 `/` 分隔。 */
  readonly relative: string
}

/** 路径校验结果：越界等情况返回错误码，不抛出。 */
export type PathResolution =
  | { readonly ok: true; readonly path: WorkspacePath }
  | { readonly ok: false; readonly code: string }

/** 检查点接口（M1-12 实现）。 */
export interface ToolCheckpoints {
  /** 在执行改动前创建检查点，返回检查点 id。 */
  create(reason: string): Promise<string>
}

/** 工具执行时可用的一切；工具不能绕过它直接访问外部资源。 */
export interface ToolContext {
  /** 工作区根目录（绝对路径）。 */
  readonly workspaceRoot: string
  readonly toolCallId: string
  /** 取消信号：用户停止、超时或运行结束时触发。 */
  readonly signal: AbortSignalLike
  /** 把模型给出的路径解析为工作区内的路径（M1-06）。 */
  resolvePath(input: string): Promise<PathResolution>
  readonly checkpoints: ToolCheckpoints
  readonly log: Logger
  /** 流式输出（如命令的标准输出），产生 `tool.output.delta`。 */
  progress(chunk: string, stream?: 'stdout' | 'stderr'): void
}

/** 工具执行的结果，交回模型。 */
export interface ToolOutput {
  readonly content: readonly ContentPart[]
}

/** 审批时展示给用户的预览（M1-11 细化）。 */
export interface ApprovalPreview {
  /** 一句话说明将要做什么。 */
  readonly summary: string
  /** 文件改动的 unified diff。 */
  readonly diff?: string
  /** 将要执行的完整命令。 */
  readonly command?: string
}

/** 权限判定用的目标：规范化后的路径（相对工作区，`/` 分隔）与命令。 */
export interface ToolTargets {
  readonly paths?: readonly string[]
  readonly command?: string
}

/** `normalize` 的结果：规范化后的参数与权限判定用的目标。 */
export interface NormalizedToolInput<I> {
  readonly input: I
  readonly targets: ToolTargets
}

export interface ToolDefinition<I = unknown> {
  /** 给模型的名称：字母开头，字母、数字、`_`、`-`，最长 64 个字符（各接口格式的公共子集）。 */
  readonly name: string
  /** 给模型看的说明（英文，模型理解更稳定）。 */
  readonly description: string
  /** 参数的 JSON Schema，顶层必须是 `type: "object"`。 */
  readonly inputSchema: JsonSchema
  readonly category: ToolCategory
  readonly source: ToolSource
  readonly trust: ToolTrust
  /**
   * 路径与命令规范化（Runtime §7 第 4 阶段）：把路径解析为工作区内的路径、解析命令，给出权限判定用的
   * 目标。越界等问题抛出 `ToolError`。省略时参数原样使用，没有目标。
   */
  normalize?(input: I, ctx: ToolContext): Promise<NormalizedToolInput<I>>
  /** 执行工具；失败时抛出 `ToolError`（或其他错误，按内部错误处理）。 */
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>
  /** 审批前生成预览，例如写文件前读取原文并计算 diff（Runtime §7）。 */
  describeForApproval?(input: I, ctx: ToolContext): Promise<ApprovalPreview>
}

export const ToolErrorCode = {
  /** 工具不存在。 */
  NotFound: 'tool.not_found',
  /** 参数不符合 `inputSchema`。 */
  InvalidInput: 'tool.invalid_input',
  /** 工具执行失败（工具自己报告的错误）。 */
  ExecutionFailed: 'tool.execution_failed',
} as const

/** 工具执行中可预期的失败；`message` 会交给模型（英文），`code` 与 `params` 用于事件与界面。 */
export class ToolError extends Error {
  readonly code: string
  readonly params: Readonly<Record<string, string | number | boolean>>

  constructor(
    code: string,
    message: string,
    params: Record<string, string | number | boolean> = {},
  ) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.params = params
  }
}

/** 参数校验的结果；失败时 `issues` 为英文说明，交给模型修正。 */
export type ToolInputValidation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly string[] }

export interface ToolRegistry {
  /** 名称重复、名称或 schema 不合法时抛出（程序错误）。 */
  register<I>(definition: ToolDefinition<I>): void
  get(name: string): ToolDefinition | undefined
  /** 按注册顺序。 */
  list(): ToolDefinition[]
  /** 给模型的工具说明；`include` 用于按 Agent 的 `tools.allow` 过滤。`read` 类工具标为可并行。 */
  specs(include?: (definition: ToolDefinition) => boolean): RuntimeToolSpec[]
  /** 按工具的 `inputSchema` 校验参数；工具不存在时同样返回失败，说明中写明。 */
  validate(name: string, input: unknown): ToolInputValidation
}

export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** 交给模型的校验说明，条数有上限，避免长输出。 */
const MAX_ISSUES = 10

function formatIssues(error: z.ZodError): string[] {
  const issues = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.map(String).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  if (error.issues.length > MAX_ISSUES) {
    issues.push(`(${error.issues.length - MAX_ISSUES} more issues omitted)`)
  }
  return issues
}

interface Entry {
  readonly definition: ToolDefinition
  readonly schema: z.ZodType
}

export function createToolRegistry(): ToolRegistry {
  const entries = new Map<string, Entry>()

  return {
    register(definition) {
      const { name } = definition
      if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`invalid tool name: ${name}`)
      if (entries.has(name)) throw new Error(`duplicate tool: ${name}`)
      if (definition.inputSchema['type'] !== 'object') {
        throw new Error(`tool ${name}: inputSchema must be an object schema`)
      }
      let schema: z.ZodType
      try {
        schema = z.fromJSONSchema(definition.inputSchema as z.core.JSONSchema.JSONSchema)
      } catch (cause) {
        throw new Error(`tool ${name}: unsupported inputSchema`, { cause })
      }
      entries.set(name, { definition: definition as ToolDefinition, schema })
    },

    get: (name) => entries.get(name)?.definition,

    list: () => [...entries.values()].map((e) => e.definition),

    specs(include) {
      return [...entries.values()]
        .map((e) => e.definition)
        .filter((d) => include?.(d) ?? true)
        .map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.inputSchema,
          ...(d.category === 'read' ? { parallel: true } : {}),
        }))
    },

    validate(name, input) {
      const entry = entries.get(name)
      if (!entry) return { ok: false, issues: [`Unknown tool: ${name}`] }
      const result = entry.schema.safeParse(input)
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, issues: formatIssues(result.error) }
    },
  }
}
