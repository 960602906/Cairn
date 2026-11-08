/**
 * Agent 定义的内置数据、工具 / Skills 选择与校验（M3-11，Runtime §3）。
 *
 * 这里不读写存储：校验需要的工具、MCP 与 Skills 清单由主进程传入。内置 Agent 由代码提供，只读，
 * 版本随应用。工具选择同时用于宿主过滤（`toolSelected`）与生效配置预览。
 */
import type {
  AgentDefinition,
  AgentContextPolicy,
  AgentDraftFields,
  AgentMemoryPolicy,
  AgentSkillSelection,
  AgentToolSelection,
  AgentValidationIssue,
  AgentValidationResult,
  ModelRef,
  SkillCatalogEntry,
  ToolCategory,
} from '@cairn/protocol'
import { AGENT_INSTRUCTIONS_MAX_CHARS } from '@cairn/protocol'

export const BUILTIN_CODER_ID = 'builtin.coder'
export const BUILTIN_EXPLORER_ID = 'builtin.explorer'
export const BUILTIN_REVIEWER_ID = 'builtin.reviewer'
export const BUILTIN_TESTER_ID = 'builtin.tester'

export interface BuiltinToolInfo {
  readonly name: string
  readonly description: string
  readonly category: ToolCategory
}

/** 宿主实际注册的内置工具（与 `@cairn/tools` / 计划工具一致），用于校验与生效配置。 */
export const BUILTIN_TOOL_CATALOG: readonly BuiltinToolInfo[] = [
  { name: 'read_file', description: 'Read a file from the workspace.', category: 'read' },
  { name: 'list_dir', description: 'List a directory in the workspace.', category: 'read' },
  { name: 'search', description: 'Search file contents with ripgrep.', category: 'read' },
  { name: 'write_file', description: 'Create or overwrite a workspace file.', category: 'write' },
  { name: 'edit_file', description: 'Apply a small edit to a workspace file.', category: 'write' },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace.',
    category: 'execute',
  },
  { name: 'load_skill', description: 'Read the full instructions of a skill.', category: 'read' },
  { name: 'propose_plan', description: 'Propose a plan in plan mode.', category: 'read' },
  {
    name: 'update_plan_step',
    description: 'Update a step of the approved plan.',
    category: 'read',
  },
]

/** 选择器里可以写的类别名。 */
export const TOOL_SELECTOR_CATEGORIES: readonly ToolCategory[] = [
  'read',
  'write',
  'execute',
  'network',
  'delegate',
]

/** 内置编程助手：跟随会话模型、使用全部工具、权限“询问”。 */
export const BUILTIN_CODER: AgentDefinition = {
  id: BUILTIN_CODER_ID,
  version: 1,
  source: 'builtin',
  status: 'published',
  name: { 'zh-CN': '编程助手', 'en-US': 'Coder' },
  description: {
    'zh-CN': '读写代码、执行命令的通用编程助手。',
    'en-US': 'General coding assistant that reads and changes code and runs commands.',
  },
  icon: 'code',
  color: 'agent-blue',
  instructions: '',
  model: { mode: 'inherit' },
  tools: { allow: ['*'] },
  skills: { allow: ['*'] },
  permissions: 'ask',
  limits: {},
  context: { includeProjectInstructions: true, compaction: 'auto' },
  memory: { scopes: ['session', 'project'], write: 'never' },
  delegation: {
    enabled: true,
    allowedAgents: [BUILTIN_EXPLORER_ID, BUILTIN_REVIEWER_ID, BUILTIN_TESTER_ID],
    maxDepth: 1,
    maxChildrenPerTurn: 6,
    maxParallel: 3,
    childBudgetShare: 0.5,
    defaultWorkspace: 'auto',
    mergeReview: 'user',
  },
  createdAt: 0,
  updatedAt: 0,
  schemaVersion: 1,
}

const readonlyTools = { allow: ['read_file', 'list_dir', 'search'] }
const readonlyContext: AgentContextPolicy = {
  includeProjectInstructions: true,
  compaction: 'auto',
}
const readonlyMemory: AgentMemoryPolicy = { scopes: ['session'], write: 'never' }

/** 只读代码探索员：查文件、列目录与搜索，不写、不执行、不联网。 */
export const BUILTIN_EXPLORER: AgentDefinition = {
  id: BUILTIN_EXPLORER_ID,
  version: 1,
  source: 'builtin',
  status: 'published',
  name: { 'zh-CN': '代码探索员', 'en-US': 'Explorer' },
  description: {
    'zh-CN': '只读定位代码、依赖与调用链，返回文件与行号。',
    'en-US': 'Read-only code exploration that locates files, dependencies, and call chains.',
  },
  icon: 'sparkles',
  color: 'agent-green',
  instructions:
    '你负责只读探索代码。优先用 search 定位，再用 read_file 阅读相关片段，最后返回文件路径、行号与简洁结论。不要修改文件，也不要执行命令。',
  model: { mode: 'inherit' },
  tools: readonlyTools,
  skills: { allow: [] },
  permissions: 'read-only',
  limits: {},
  context: readonlyContext,
  memory: readonlyMemory,
  createdAt: 0,
  updatedAt: 0,
  schemaVersion: 1,
}

/** 只读代码审查员：输出按严重程度排列的问题清单。 */
export const BUILTIN_REVIEWER: AgentDefinition = {
  id: BUILTIN_REVIEWER_ID,
  version: 1,
  source: 'builtin',
  status: 'published',
  name: { 'zh-CN': '代码审查员', 'en-US': 'Reviewer' },
  description: {
    'zh-CN': '只读审查改动，按严重程度报告问题、位置与建议。',
    'en-US': 'Read-only review that reports issues by severity with locations and suggestions.',
  },
  icon: 'shield',
  color: 'agent-amber',
  instructions:
    '你负责代码审查。只读检查改动及上下文，按严重程度从高到低列出问题；每个问题给出文件、行号、影响与修复建议。没有问题时明确说明。不要修改文件。',
  model: { mode: 'inherit' },
  tools: readonlyTools,
  skills: { allow: [] },
  permissions: 'read-only',
  limits: {},
  context: readonlyContext,
  memory: readonlyMemory,
  outputSchema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { enum: ['high', 'medium', 'low'] },
            file: { type: 'string' },
            line: { type: 'number' },
            message: { type: 'string' },
          },
          required: ['severity', 'message'],
        },
      },
    },
    required: ['issues'],
  },
  createdAt: 0,
  updatedAt: 0,
  schemaVersion: 1,
}

/** 测试补全员：只修改测试文件并执行测试命令。 */
export const BUILTIN_TESTER: AgentDefinition = {
  id: BUILTIN_TESTER_ID,
  version: 1,
  source: 'builtin',
  status: 'published',
  name: { 'zh-CN': '测试补全员', 'en-US': 'Tester' },
  description: {
    'zh-CN': '补全或修复测试文件，并运行测试验证结果。',
    'en-US': 'Adds or fixes tests and runs the test suite to verify the result.',
  },
  icon: 'bug',
  color: 'agent-red',
  instructions:
    '你负责测试。只修改测试目录或测试文件名（如 *.test.ts、*.spec.ts、test/、tests/、e2e/）中的文件；禁止修改业务源码。先阅读现有测试风格，再补充最小且稳定的用例，最后运行相关测试命令。',
  model: { mode: 'inherit' },
  tools: {
    allow: ['read_file', 'list_dir', 'search', 'write_file', 'edit_file', 'run_command'],
  },
  skills: { allow: [] },
  permissions: 'ask',
  pathPolicy: {
    write: [
      '**/*.{test,spec}.*',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/e2e/**',
      '**/spec/**',
    ],
  },
  limits: {},
  context: readonlyContext,
  memory: readonlyMemory,
  createdAt: 0,
  updatedAt: 0,
  schemaVersion: 1,
}

/** 所有内置 Agent，按列表显示顺序。 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  BUILTIN_CODER,
  BUILTIN_EXPLORER,
  BUILTIN_REVIEWER,
  BUILTIN_TESTER,
]

export const builtinAgent = (agentId: string): AgentDefinition | undefined =>
  BUILTIN_AGENTS.find((agent) => agent.id === agentId)

export interface ToolLike {
  readonly name: string
  readonly category: ToolCategory
  /** 工具的来源；`kind` 为 `mcp` 时用 `serverId` 匹配 `mcp:<serverId>` 选择器。 */
  readonly source?: { readonly kind: string; readonly serverId?: string }
}

const selectorMatches = (selector: string, tool: ToolLike): boolean => {
  if (selector === '*') return true
  if ((TOOL_SELECTOR_CATEGORIES as readonly string[]).includes(selector)) {
    return tool.category === selector
  }
  if (selector.startsWith('mcp:')) {
    const serverId = selector.slice('mcp:'.length)
    return tool.source?.kind === 'mcp' && tool.source.serverId === serverId
  }
  return tool.name === selector
}

/**
 * 工具是否可用：`allow` 为空表示一个都不选，`*` 表示全部；`deny` 永远优先。
 * 选择器可以是工具名、类别、`mcp:<serverId>` 或 `*`。
 */
export function toolSelected(selection: AgentToolSelection | undefined, tool: ToolLike): boolean {
  if (!selection) return true
  if (selection.deny?.some((selector) => selectorMatches(selector, tool))) return false
  return selection.allow.some((selector) => selectorMatches(selector, tool))
}

/** Skills 是否可用：`allow` 为空表示一个都不选，`*` 表示全部；`pinned` 与全局固定加载合并。 */
export function skillSelected(
  selection: AgentSkillSelection | undefined,
  skill: { readonly name: string },
): boolean {
  if (!selection) return true
  if (selection.deny?.includes(skill.name)) return false
  return selection.allow.includes('*') || selection.allow.includes(skill.name)
}

/** 按 Agent 选择过滤技能目录，并合并“始终加载”。 */
export function selectSkills(
  selection: AgentSkillSelection | undefined,
  skills: readonly SkillCatalogEntry[],
): SkillCatalogEntry[] {
  return skills
    .filter((skill) => skillSelected(selection, skill))
    .map((skill) => ({
      ...skill,
      pinned: skill.pinned || selection?.pinned?.includes(skill.name) === true,
    }))
}

/** 校验所需的工具、MCP、Skills 与模型清单。 */
export interface AgentValidationContext {
  readonly knownTools: readonly string[]
  readonly mcpServers: readonly string[]
  readonly mcpTools: readonly string[]
  readonly skillNames: readonly string[]
  readonly hasModel: (model: ModelRef) => boolean
  /** 已发布的 Agent id；给出时校验委派目标，省略时保持旧调用兼容。 */
  readonly publishedAgentIds?: readonly string[]
}

const issue = (
  path: string,
  code: string,
  params?: Record<string, string | number | boolean>,
): AgentValidationIssue => ({ path, code, ...(params ? { params } : {}) })

const hasText = (value: string | undefined): boolean => (value ?? '').trim() !== ''

const toolSelectorKnown = (selector: string, context: AgentValidationContext): boolean =>
  selector === '*' ||
  (TOOL_SELECTOR_CATEGORIES as readonly string[]).includes(selector) ||
  context.knownTools.includes(selector) ||
  context.mcpTools.includes(selector) ||
  (selector.startsWith('mcp:') && context.mcpServers.includes(selector.slice(4)))

/**
 * 校验一份 Agent 草稿：错误阻止发布，警告只提示。工具与 Skill 引用不存在时是错误（设计 §3.3），
 * 备用 / 辅助模型或 `deny` 中的未知项只是警告。
 */
export function validateAgentDefinition(
  definition: AgentDraftFields,
  context: AgentValidationContext,
): AgentValidationResult {
  const errors: AgentValidationIssue[] = []
  const warnings: AgentValidationIssue[] = []

  if (!hasText(definition.name['zh-CN']) && !hasText(definition.name['en-US'])) {
    errors.push(issue('name', 'name_required'))
  }
  if (!hasText(definition.description['zh-CN']) && !hasText(definition.description['en-US'])) {
    errors.push(issue('description', 'description_required'))
  }
  if ([...definition.instructions].length > AGENT_INSTRUCTIONS_MAX_CHARS) {
    errors.push(issue('instructions', 'instructions_too_long'))
  }

  definition.tools.allow.forEach((selector, index) => {
    if (!toolSelectorKnown(selector, context)) {
      errors.push(issue(`tools.allow.${index}`, 'unknown_tool', { tool: selector }))
    }
  })
  definition.tools.deny?.forEach((selector, index) => {
    if (!toolSelectorKnown(selector, context)) {
      warnings.push(issue(`tools.deny.${index}`, 'unknown_tool', { tool: selector }))
    }
  })

  definition.skills.allow.forEach((name, index) => {
    if (name !== '*' && !context.skillNames.includes(name)) {
      errors.push(issue(`skills.allow.${index}`, 'unknown_skill', { skill: name }))
    }
  })
  definition.skills.pinned?.forEach((name, index) => {
    if (!context.skillNames.includes(name)) {
      warnings.push(issue(`skills.pinned.${index}`, 'unknown_skill', { skill: name }))
    }
  })

  if (definition.model.mode === 'fixed') {
    if (!definition.model.primary) {
      errors.push(issue('model.primary', 'model_required'))
    } else if (!context.hasModel(definition.model.primary)) {
      errors.push(issue('model.primary', 'unknown_model'))
    }
  }
  definition.model.fallbacks?.forEach((model, index) => {
    if (!context.hasModel(model)) warnings.push(issue(`model.fallbacks.${index}`, 'unknown_model'))
  })
  if (definition.model.auxiliary && !context.hasModel(definition.model.auxiliary)) {
    warnings.push(issue('model.auxiliary', 'unknown_model'))
  }

  if (definition.memory.write !== 'never') {
    warnings.push(issue('memory.write', 'memory_write_reserved'))
  }

  if (definition.delegation?.enabled) {
    if (definition.delegation.allowedAgents.length === 0) {
      errors.push(issue('delegation.allowedAgents', 'delegation_agents_required'))
    }
    definition.delegation.allowedAgents.forEach((agentId, index) => {
      if (context.publishedAgentIds !== undefined && !context.publishedAgentIds.includes(agentId)) {
        errors.push(
          issue(`delegation.allowedAgents.${index}`, 'delegation_agent_not_published', {
            agent: agentId,
          }),
        )
      }
    })
  }

  return { ok: errors.length === 0, errors, warnings }
}
