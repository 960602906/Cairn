/**
 * “权限与审批”页的数据处理（M2-11）：规则的显示文字与手动添加规则的表单。不依赖 React。
 */
import type {
  PermissionEffect,
  PermissionMode,
  PermissionRule,
  PermissionRuleEntry,
  ToolCategory,
} from '@cairn/protocol'

/** 设置页可选的内置工具，按显示顺序；`target` 是规则匹配的对象。 */
export const RULE_TOOLS = [
  { name: 'read_file', target: 'path' },
  { name: 'list_dir', target: 'path' },
  { name: 'search', target: 'path' },
  { name: 'write_file', target: 'path' },
  { name: 'edit_file', target: 'path' },
  { name: 'run_command', target: 'command' },
] as const

export type RuleToolName = (typeof RULE_TOOLS)[number]['name']
/** 表单中的工具：具体工具，或不限工具（`*`）。 */
export type RuleTool = RuleToolName | '*'

export const RULE_EFFECTS: readonly PermissionEffect[] = ['allow', 'ask', 'deny']

/** 规则匹配的对象：命令（`run_command`）或路径（文件工具与不限工具）。 */
export function targetOf(tool: RuleTool): 'path' | 'command' {
  return RULE_TOOLS.find((t) => t.name === tool)?.target ?? 'path'
}

const list = (value: string | readonly string[] | undefined): readonly string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : value

/** 规则的显示文字的组成部分：工具（或类别）与匹配内容。 */
export interface RuleText {
  /** 工具名；没有限定工具时为空。 */
  readonly tools: readonly string[]
  /** 只按类别匹配时的类别。 */
  readonly categories: readonly ToolCategory[]
  /** 路径与命令模式。 */
  readonly patterns: readonly string[]
}

export function ruleText(rule: PermissionRule): RuleText {
  const { match } = rule
  return {
    tools: list(match.tool),
    categories: match.category ?? [],
    patterns: [...list(match.path), ...list(match.command)],
  }
}

/** 一行规则：保存的规则（可以删除），或当前模式的预设（不能删除）。 */
export interface RuleRow {
  readonly rule: PermissionRule
  readonly projectId?: string
  readonly removable: boolean
}

/**
 * 列表中的规则：先是当前模式的预设，再是保存的全局与项目规则（主进程给出的顺序）。规则同时匹配时取最严格的
 * 结果，顺序只用于展示。
 */
export function ruleRows(
  presets: readonly PermissionRule[],
  entries: readonly PermissionRuleEntry[],
): RuleRow[] {
  return [
    ...presets.map((rule) => ({ rule, removable: false })),
    ...entries.map(({ rule, projectId }) => ({
      rule,
      ...(projectId !== undefined ? { projectId } : {}),
      removable: true,
    })),
  ]
}

/**
 * 当前模式的预设（与 `@cairn/core` 的 `presetRules` 一致：只读拒绝、自动放行写入、执行与联网；询问模式没有
 * 预设）。界面不依赖 core，这里只用于显示。
 */
export function presetRows(mode: PermissionMode): PermissionRule[] {
  const effect = mode === 'read-only' ? 'deny' : mode === 'auto' ? 'allow' : undefined
  if (!effect) return []
  return (['write', 'execute', 'network'] as const).map((category) => ({
    id: `preset.${mode}.${category}`,
    scope: 'global',
    effect,
    match: { category: [category] },
    source: 'preset',
  }))
}

/** 手动添加规则的表单。`scope` 是 `global` 或项目 id。 */
export interface RuleDraft {
  readonly effect: PermissionEffect
  readonly tool: RuleTool
  readonly pattern: string
  readonly scope: string
}

export const GLOBAL_SCOPE = 'global'

export function newRuleDraft(): RuleDraft {
  return { effect: 'allow', tool: 'run_command', pattern: '', scope: GLOBAL_SCOPE }
}

/** 表单的问题：不限工具时必须填写路径，否则规则会匹配所有调用。 */
export function ruleDraftProblem(draft: RuleDraft): 'empty' | undefined {
  return draft.tool === '*' && draft.pattern.trim() === '' ? 'empty' : undefined
}

/** 由表单生成规则与所属项目；表单有问题时返回 undefined。 */
export function ruleFromDraft(
  draft: RuleDraft,
  id: string,
): { rule: PermissionRule; projectId?: string } | undefined {
  if (ruleDraftProblem(draft)) return undefined
  const pattern = draft.pattern.trim()
  const project = draft.scope !== GLOBAL_SCOPE
  return {
    rule: {
      id,
      scope: project ? 'project' : 'global',
      effect: draft.effect,
      match: {
        ...(draft.tool !== '*' ? { tool: draft.tool } : {}),
        ...(pattern ? { [targetOf(draft.tool)]: [pattern] } : {}),
      },
      source: 'user',
    },
    ...(project ? { projectId: draft.scope } : {}),
  }
}
