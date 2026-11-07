/**
 * Agents 页面的纯数据辅助（M3-12）：草稿表单、分区标记与估算。
 *
 * 表单直接使用 `AgentDraftFields`（协议里的形状），编辑器只做不可变更新；校验复用
 * `@cairn/core` 的 `validateAgentDefinition`，与主进程保存 / 发布时同一套规则。
 */
import type {
  AgentDefinition,
  AgentDraftFields,
  AgentValidationIssue,
  AgentValidationResult,
  LocalizedText,
} from '@cairn/protocol'

export type AgentSection =
  | 'basic'
  | 'instructions'
  | 'model'
  | 'capabilities'
  | 'permissions'
  | 'limits'
  | 'context'
  | 'memory'

export const AGENT_SECTIONS: readonly AgentSection[] = [
  'basic',
  'instructions',
  'model',
  'capabilities',
  'permissions',
  'limits',
  'context',
  'memory',
]

/** 分区对应的字段前缀；`path` 为 `tools.allow.0` 时归到能力。 */
const SECTION_PREFIXES: Readonly<Record<AgentSection, readonly string[]>> = {
  basic: ['name', 'description', 'icon', 'color', 'tags'],
  instructions: ['instructions'],
  model: ['model'],
  capabilities: ['tools', 'skills'],
  permissions: ['permissions'],
  limits: ['limits'],
  context: ['context'],
  memory: ['memory'],
}

export function sectionOf(path: string): AgentSection {
  const head = path.split('.')[0] ?? ''
  for (const section of AGENT_SECTIONS) {
    if (SECTION_PREFIXES[section].includes(head)) return section
  }
  return 'basic'
}

export interface SectionMarks {
  readonly errors: number
  readonly warnings: number
}

/** 把校验结果按分区分组；分区导航上显示数量。 */
export function sectionMarks(
  validation: AgentValidationResult | undefined,
): Readonly<Record<AgentSection, SectionMarks>> {
  const marks = Object.fromEntries(
    AGENT_SECTIONS.map((section) => [section, { errors: 0, warnings: 0 }]),
  ) as Record<AgentSection, SectionMarks>
  if (!validation) return marks
  for (const issue of validation.errors) {
    const section = sectionOf(issue.path)
    marks[section] = { ...marks[section], errors: marks[section].errors + 1 }
  }
  for (const issue of validation.warnings) {
    const section = sectionOf(issue.path)
    marks[section] = { ...marks[section], warnings: marks[section].warnings + 1 }
  }
  return marks
}

/** 字段路径上是否有错误 / 警告，用来给输入框标红。 */
export function issuesAt(
  validation: AgentValidationResult | undefined,
  path: string,
  kind: 'errors' | 'warnings',
): readonly AgentValidationIssue[] {
  return (validation?.[kind] ?? []).filter(
    (issue) => issue.path === path || issue.path.startsWith(`${path}.`),
  )
}

/** 新 Agent 的默认草稿：与内置编程助手一致，权限“询问”。 */
export function defaultDraft(): AgentDraftFields {
  return {
    name: {},
    description: {},
    instructions: '',
    model: { mode: 'inherit' },
    tools: { allow: ['*'] },
    skills: { allow: ['*'] },
    permissions: 'ask',
    limits: {},
    context: { includeProjectInstructions: true, compaction: 'auto' },
    memory: { scopes: ['session'], write: 'never' },
  }
}

/** 已发布定义转回草稿字段（丢掉版本与时间戳）。 */
export function draftFieldsOf(definition: AgentDraftFields | AgentDefinition): AgentDraftFields {
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.icon ? { icon: definition.icon } : {}),
    ...(definition.color ? { color: definition.color } : {}),
    instructions: definition.instructions,
    model: definition.model,
    tools: definition.tools,
    skills: definition.skills,
    permissions: definition.permissions,
    limits: definition.limits,
    context: definition.context,
    memory: definition.memory,
    ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    ...(definition.tags ? { tags: definition.tags } : {}),
  }
}

/** 显示名称：优先当前语言，缺失时回退，两者都空时用 id。 */
export function localized(text: LocalizedText, language: string, fallback = 'Agent'): string {
  const primary = language.startsWith('zh') ? text['zh-CN'] : text['en-US']
  const other = language.startsWith('zh') ? text['en-US'] : text['zh-CN']
  const value = primary?.trim() || other?.trim()
  return value || fallback
}

/** 草稿与已发布版本是否不同（用于列表上的“有未发布修改”）。 */
export function sameFields(a: AgentDraftFields, b: AgentDraftFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 分区是否有未保存修改；编辑器左侧导航据此显示圆点。 */
export function sectionChanged(
  before: AgentDraftFields,
  after: AgentDraftFields,
  section: AgentSection,
): boolean {
  const keys: Readonly<Record<AgentSection, readonly (keyof AgentDraftFields)[]>> = {
    basic: ['name', 'description', 'icon', 'color', 'tags'],
    instructions: ['instructions'],
    model: ['model'],
    capabilities: ['tools', 'skills'],
    permissions: ['permissions'],
    limits: ['limits'],
    context: ['context'],
    memory: ['memory'],
  }
  return keys[section].some(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  )
}
