/**
 * 记忆写入工具（M7-03，ADR-0019）：模型调用 `remember` 提议一条记忆，或按 Agent 的 `auto` 配置直接写入。
 *
 * - 工具本身不写存储：主进程按 Agent 定义检查写入方式与范围、落库并记事件，宿主只转交。
 * - 类别是 `read`：真正的把关是用户在聊天里的确认（`propose`），不需要再叠一层审批；
 *   写入方式为 `never` 时，宿主不登记这个工具，工具自身也会拒绝（防止旧工具列表残留）。
 * - 无人值守运行没有用户可确认，`propose` 在宿主侧直接拒绝，只有 `auto` 能写。
 */
import { z } from 'zod'
import { MEMORY_CONTENT_MAX, type MemoryScope } from '@cairn/protocol'

export { MEMORY_CONTENT_MAX }
import { ToolError, ToolErrorCode, type ToolDefinition, type ToolRegistry } from './tools.js'

export const REMEMBER_TOOL = 'remember'

export type MemoryWriteMode = 'never' | 'propose' | 'auto'

export interface RememberInput {
  readonly scope: MemoryScope
  readonly content: string
}

export interface RememberedMemory {
  readonly memoryId: string
  readonly status: 'proposed' | 'active'
}

export interface RememberToolDeps {
  /** Agent 定义里声明可读取（也是可写入）的范围。 */
  readonly scopes: readonly MemoryScope[]
  readonly write: MemoryWriteMode
  /** 交互运行才有用户确认；无人值守运行不能 `propose`。 */
  readonly mode: 'interactive' | 'unattended'
  /** 交给主进程：受策略与设置限制，可能抛出 `RpcError`。 */
  readonly remember: (input: RememberInput) => Promise<RememberedMemory>
}

const SCOPE_LABELS: Readonly<Record<MemoryScope, string>> = {
  session: 'this session',
  project: 'this project',
  global: 'all projects',
}

export const REMEMBER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['session', 'project', 'global'],
      description:
        'Where the note applies: session (this conversation only), project (every session in this project), or global (every project).',
    },
    content: {
      type: 'string',
      minLength: 1,
      maxLength: MEMORY_CONTENT_MAX,
      description:
        'One short, self-contained note in the language the user writes in. Do not copy secrets, keys or personal data.',
    },
  },
  required: ['scope', 'content'],
  additionalProperties: false,
} as const

const RememberArguments = z.object({
  scope: z.enum(['session', 'project', 'global']),
  content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX),
})

export function createRememberTool(deps: RememberToolDeps): ToolDefinition {
  return {
    name: REMEMBER_TOOL,
    description:
      'Save a short note for later runs: a preference, a project convention or a constraint the user stated. Pick the narrowest scope that still helps (session, then project, then global). The note is proposed to the user for confirmation unless this agent is configured for automatic memory; never store secrets, credentials or personal data.',
    inputSchema: REMEMBER_INPUT_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(raw) {
      if (deps.write === 'never') {
        throw new ToolError(
          ToolErrorCode.ExecutionFailed,
          'Memory writes are turned off for this agent (memory.write = "never"). Do not try again; if the user wants Cairn to remember something, they can turn memory on for this agent.',
          { name: REMEMBER_TOOL },
        )
      }
      const parsed = RememberArguments.safeParse(raw)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid memory: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
            .join('; ')}`,
          { name: REMEMBER_TOOL },
        )
      }
      const { scope, content } = parsed.data
      if (!deps.scopes.includes(scope)) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          deps.scopes.length === 0
            ? 'This agent cannot read any memory scope, so nothing can be saved.'
            : `This agent can only use these memory scopes: ${deps.scopes.join(', ')}.`,
          { name: REMEMBER_TOOL, scope },
        )
      }
      if (deps.mode !== 'interactive' && deps.write !== 'auto') {
        throw new ToolError(
          ToolErrorCode.ExecutionFailed,
          'This run has no user to confirm a memory proposal, so nothing was saved. Only automatic memory (memory.write = "auto") can write here.',
          { name: REMEMBER_TOOL },
        )
      }
      // 主进程按最新的 Agent 定义再判断一次（工具列表可能来自旧定义），拒绝时抛出由运行时转成工具失败。
      const saved = await deps.remember({ scope, content })
      return {
        content: [
          {
            type: 'text',
            text:
              saved.status === 'active'
                ? `Saved a note for ${SCOPE_LABELS[scope]} (memoryId: ${saved.memoryId}). Do not repeat it in later turns.`
                : `Proposed a note for ${SCOPE_LABELS[scope]} (memoryId: ${saved.memoryId}). The user can confirm or ignore it in the chat; do not propose the same note again.`,
          },
        ],
      }
    },
  }
}

export function registerRememberTool(registry: ToolRegistry, deps: RememberToolDeps): void {
  registry.register(createRememberTool(deps))
}
