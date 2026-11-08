/**
 * Agent 定义（M3-11，Runtime §3，ADR-0016）。
 *
 * 定义可版本化：草稿与已发布版本分开保存，运行引用 `id@version`。内置 Agent 由代码提供，只读，
 * 版本随应用。这里只管数据形状；校验规则在 `@cairn/core` 的 `validateAgentDefinition`。
 */
import { z } from 'zod'
import { Id, ModelRef, RunLimits } from './common.js'
import { DelegationPolicy } from './delegation.js'
import { PermissionMode, PermissionRule, ToolCategory } from './permissions.js'

/** 名称与描述，至少一种语言。显示时回退到另一种。 */
export const LocalizedText = z
  .object({
    'zh-CN': z.string().max(200).optional(),
    'en-US': z.string().max(200).optional(),
  })
  .strict()
export type LocalizedText = z.infer<typeof LocalizedText>

export const AgentSource = z.enum(['builtin', 'user', 'imported'])
export type AgentSource = z.infer<typeof AgentSource>

export const AgentStatus = z.enum(['draft', 'published'])
export type AgentStatus = z.infer<typeof AgentStatus>

export const AgentModelParams = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict()
export type AgentModelParams = z.infer<typeof AgentModelParams>

/**
 * 模型选择：`fixed` 时忽略会话模型；`inherit` 时跟随会话。`primary` 在 `fixed` 时必填，
 * `inherit` 时可省略（内置 Agent 不绑定具体模型）。
 */
export const AgentModelSelection = z
  .object({
    mode: z.enum(['fixed', 'inherit']),
    primary: ModelRef.optional(),
    fallbacks: z.array(ModelRef).max(5).optional(),
    auxiliary: ModelRef.optional(),
    params: AgentModelParams.optional(),
  })
  .strict()
export type AgentModelSelection = z.infer<typeof AgentModelSelection>

/**
 * 工具选择：`allow` 中的项可以是工具名、类别（`read` / `write` / `execute` / `network` /
 * `delegate`）、`mcp:<serverId>` 或 `*`。`deny` 永远优先。
 */
export const AgentToolSelection = z
  .object({
    allow: z.array(z.string().min(1)).max(200),
    deny: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict()
export type AgentToolSelection = z.infer<typeof AgentToolSelection>

/** Skills 选择：`*` 表示所有已启用的 Skill；`pinned` 始终加载正文。 */
export const AgentSkillSelection = z
  .object({
    allow: z.array(z.string().min(1)).max(200),
    deny: z.array(z.string().min(1)).max(200).optional(),
    pinned: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict()
export type AgentSkillSelection = z.infer<typeof AgentSkillSelection>

/** 记忆（第一版只预留，写入固定为 `never`）。 */
export const AgentMemoryPolicy = z
  .object({
    scopes: z.array(z.enum(['session', 'project', 'global'])),
    write: z.enum(['never', 'propose', 'auto']),
  })
  .strict()
export type AgentMemoryPolicy = z.infer<typeof AgentMemoryPolicy>

/** 上下文策略（M3-11 只保存与展示；压缩开关在 `agent.effectiveConfig` 中给出）。 */
export const AgentContextPolicy = z
  .object({
    includeProjectInstructions: z.boolean(),
    compaction: z.enum(['auto', 'off']),
    reserveOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
export type AgentContextPolicy = z.infer<typeof AgentContextPolicy>

/** 指令长度上限：超过会挤占上下文，保存时报错。 */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 64_000

const draftFields = {
  name: LocalizedText,
  description: LocalizedText,
  icon: z.string().max(64).optional(),
  /** 设计令牌名，不是色值。 */
  color: z.string().max(64).optional(),
  instructions: z.string().max(AGENT_INSTRUCTIONS_MAX_CHARS),
  model: AgentModelSelection,
  tools: AgentToolSelection,
  skills: AgentSkillSelection,
  /** 权限预设：只读 / 询问 / 自动。 */
  permissions: PermissionMode,
  limits: RunLimits,
  context: AgentContextPolicy,
  memory: AgentMemoryPolicy,
  /**
   * 委派策略（M4-02，设计 §10.1）。省略时视为未启用委派；已保存的旧定义没有这个字段，
   * 因此保持可选，读取时由 `resolveDelegationPolicy` 补默认值。
   */
  delegation: DelegationPolicy.optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
} as const

/** 草稿字段（不含版本与时间戳）。 */
export const AgentDraftFields = z.object(draftFields).strict()
export type AgentDraftFields = z.infer<typeof AgentDraftFields>

/** 已保存的草稿。 */
export const AgentDraft = z.object({ id: Id, ...draftFields }).strict()
export type AgentDraft = z.infer<typeof AgentDraft>

/** 保存草稿的输入：新 Agent 可以不给 id。 */
export const AgentDraftInput = z.object({ id: Id.optional(), ...draftFields }).strict()
export type AgentDraftInput = z.infer<typeof AgentDraftInput>

/** 已发布的某个版本。 */
export const AgentDefinition = z
  .object({
    id: Id,
    version: z.number().int().positive(),
    source: AgentSource,
    status: AgentStatus,
    ...draftFields,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
  })
  .strict()
export type AgentDefinition = z.infer<typeof AgentDefinition>

export const AgentSummary = z.object({
  agentId: Id,
  name: LocalizedText,
  description: LocalizedText,
  icon: z.string().optional(),
  color: z.string().optional(),
  source: AgentSource,
  archived: z.boolean(),
  /** 从未发布过的自定义 Agent 是 `draft`。 */
  status: AgentStatus,
  /** 最新的已发布版本；从未发布为 0。 */
  version: z.number().int().nonnegative(),
  hasDraft: z.boolean(),
  /** 列表里显示“固定模型 / 跟随会话”（M3-12）。 */
  modelMode: z.enum(['fixed', 'inherit']),
  /** `fixed` 时的主模型。 */
  model: ModelRef.optional(),
  updatedAt: z.number().int().nonnegative(),
})
export type AgentSummary = z.infer<typeof AgentSummary>

/** 校验问题：`path` 指向定义中的字段，`code` 由界面翻译。 */
export const AgentValidationIssue = z.object({
  path: z.string().min(1),
  code: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})
export type AgentValidationIssue = z.infer<typeof AgentValidationIssue>

export const AgentValidationResult = z.object({
  ok: z.boolean(),
  errors: z.array(AgentValidationIssue),
  warnings: z.array(AgentValidationIssue),
})
export type AgentValidationResult = z.infer<typeof AgentValidationResult>

/** 一份 Agent 的当前状态：草稿优先，已发布版本用于对比与会话选择。 */
export const AgentDetail = z.object({
  agentId: Id,
  source: AgentSource,
  archived: z.boolean(),
  draft: AgentDraft.optional(),
  published: AgentDefinition.optional(),
  validation: AgentValidationResult,
})
export type AgentDetail = z.infer<typeof AgentDetail>

export const AgentVersionSummary = z.object({
  version: z.number().int().positive(),
  publishedAt: z.number().int().nonnegative(),
  name: LocalizedText,
  description: LocalizedText,
  /** `instructions` 的字节数（UTF-8）。 */
  instructionsBytes: z.number().int().nonnegative(),
  usedBySessions: z.number().int().nonnegative(),
})
export type AgentVersionSummary = z.infer<typeof AgentVersionSummary>

export const AgentFieldDiff = z.object({
  path: z.string().min(1),
  from: z.unknown(),
  to: z.unknown(),
})
export type AgentFieldDiff = z.infer<typeof AgentFieldDiff>

export const AgentDiff = z.object({
  fields: z.array(AgentFieldDiff),
  instructions: z.object({ from: z.string(), to: z.string() }),
})
export type AgentDiff = z.infer<typeof AgentDiff>

export const AgentEffectiveTool = z.object({
  name: z.string().min(1),
  description: z.string(),
  category: ToolCategory,
  source: z.object({
    kind: z.enum(['builtin', 'mcp']),
    serverId: Id.optional(),
  }),
})
export type AgentEffectiveTool = z.infer<typeof AgentEffectiveTool>

export const AgentEffectiveSkill = z.object({
  name: z.string().min(1),
  description: z.string(),
  pinned: z.boolean(),
  tokens: z.object({
    index: z.number().int().nonnegative(),
    pinned: z.number().int().nonnegative(),
  }),
})
export type AgentEffectiveSkill = z.infer<typeof AgentEffectiveSkill>

/** 生效配置预览（管理界面 §4.3）。 */
export const AgentEffectiveConfig = z.object({
  agentId: Id,
  source: z.enum(['draft', 'published']),
  version: z.number().int().nonnegative(),
  systemPrompt: z.string(),
  tools: z.array(AgentEffectiveTool),
  skills: z.array(AgentEffectiveSkill),
  permissionRules: z.array(PermissionRule),
  budget: z.object({
    contextWindow: z.number().int().positive(),
    reserveOutputTokens: z.number().int().nonnegative(),
    systemPromptTokens: z.number().int().nonnegative(),
    toolsTokens: z.number().int().nonnegative(),
    skillsTokens: z.number().int().nonnegative(),
    historyTokens: z.number().int().nonnegative(),
  }),
})
export type AgentEffectiveConfig = z.infer<typeof AgentEffectiveConfig>

/** 版本对比的两端：草稿或某个已发布版本。 */
export const AgentDiffEndpoint = z.union([z.literal('draft'), z.number().int().positive()])
export type AgentDiffEndpoint = z.infer<typeof AgentDiffEndpoint>
