/**
 * 权限引擎（M1-10a；ADR-0007；架构 §10.2、§10.3）：纯函数，实现工具流水线的 `PermissionGate`。
 *
 * 判定顺序：
 * 1. 强制拦截（`PermissionGuard`，M1-10b）：危险命令、敏感文件等，至少为 ask，部分直接 deny；
 * 2. 收集所有匹配的规则，按 deny > ask > allow 取最严格的结果（范围不影响结果：低范围的 allow 不能覆盖
 *    高范围的 deny）；
 * 3. 没有规则匹配时按工具类别的默认值：read、delegate 放行，write、execute、network 询问；第三方工具
 *    （ADR-0017）一律询问。
 *
 * 最终结果取强制拦截与第 2、3 步中最严格的一个，因此强制拦截不能被 allow 规则覆盖。
 */
import type { PermissionEffect, PermissionMode, PermissionRule } from '@nexus/protocol'
import { matchCommand, parseCommand, type ParsedCommand } from './command-match.js'
import { matchGlob } from './glob.js'
import type { PermissionDecision, PermissionGate, PermissionRequest } from './tool-pipeline.js'
import type { ToolCategory, ToolDefinition, ToolTargets } from './tools.js'

export const PermissionReasonCode = {
  /** 被权限规则拒绝。 */
  DeniedByRule: 'permission.denied_by_rule',
  /** 权限规则要求审批。 */
  RuleRequiresApproval: 'permission.rule_requires_approval',
  /** 没有规则匹配，按工具类别默认需要审批。 */
  CategoryDefault: 'permission.category_default',
  /** 第三方工具默认需要审批（ADR-0017）。 */
  ThirdPartyTool: 'permission.third_party_tool',
} as const

/** 强制拦截的结果。 */
export interface GuardResult {
  readonly effect: 'ask' | 'deny'
  readonly reasonCode: string
  /** deny 时交给模型的说明（英文）。 */
  readonly reason?: string
  /**
   * 询问可由用户明确的放行规则取消（如 `git push`）：来源为用户或审批、写明了命令模式（不是单独的 `*`）、
   * 且命令的每一段都匹配的 `allow` 规则。预设（“自动”模式）不算明确放行。
   */
  readonly overridable?: boolean
}

/** 强制拦截（M1-10b）：不受规则影响；不拦截时返回 undefined。 */
export type PermissionGuard = (request: PermissionRequest) => GuardResult | undefined

export interface PermissionEngineOptions {
  /** 当前生效的规则；每次判定时读取（审批时新增的规则立即生效）。 */
  readonly rules: () => readonly PermissionRule[]
  readonly guards?: readonly PermissionGuard[]
  /** 路径与命令是否不区分大小写（Windows）。默认 false。 */
  readonly caseInsensitive?: boolean
}

const SEVERITY: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 }
const stricter = (a: PermissionEffect, b: PermissionEffect) => (SEVERITY[b] > SEVERITY[a] ? b : a)

/** 工具类别的默认值（架构 §10.2）。 */
export const CATEGORY_DEFAULTS: Readonly<Record<ToolCategory, PermissionEffect>> = {
  read: 'allow',
  write: 'ask',
  execute: 'ask',
  network: 'ask',
  // 委派本身不产生副作用，子 agent 的工具调用各自判定
  delegate: 'allow',
}

interface Subject {
  readonly definition: ToolDefinition
  readonly targets: ToolTargets
  readonly command: ParsedCommand | undefined
}

/** 规则是否匹配。`allow` 要求所有路径、命令的每一段都匹配；`ask` / `deny` 任一匹配即可。 */
export function ruleMatches(
  rule: PermissionRule,
  subject: Subject,
  caseInsensitive = false,
): boolean {
  const { match } = rule
  const strict = rule.effect === 'allow'
  if (match.tool !== undefined) {
    const tools = typeof match.tool === 'string' ? [match.tool] : match.tool
    if (!tools.includes(subject.definition.name)) return false
  }
  if (match.category && !match.category.includes(subject.definition.category)) return false
  if (match.path) {
    const paths = subject.targets.paths ?? []
    if (paths.length === 0) return false
    const matches = (p: string) => match.path!.some((g) => matchGlob(g, p, { caseInsensitive }))
    if (strict ? !paths.every(matches) : !paths.some(matches)) return false
  }
  if (match.command) {
    if (!subject.command) return false
    if (!matchCommand(subject.command, match.command, strict ? 'every' : 'any', caseInsensitive)) {
      return false
    }
  }
  return true
}

const DENY_REASON = 'This tool call is not allowed by the permission rules set by the user.'

/** 判定一次调用（纯函数）。 */
export function decidePermission(
  request: PermissionRequest,
  rules: readonly PermissionRule[],
  options: { guards?: readonly PermissionGuard[]; caseInsensitive?: boolean } = {},
): PermissionDecision {
  const command =
    request.targets.command === undefined ? undefined : parseCommand(request.targets.command)
  const subject: Subject = { definition: request.definition, targets: request.targets, command }

  // 1. 强制拦截
  let guard: GuardResult | undefined
  let overridable = true
  for (const check of options.guards ?? []) {
    const result = check(request)
    if (!result) continue
    if (!result.overridable) overridable = false
    if (!guard || SEVERITY[result.effect] > SEVERITY[guard.effect]) guard = result
  }

  // 2. 规则
  const matched = rules.filter((rule) => ruleMatches(rule, subject, options.caseInsensitive))
  let ruleEffect: PermissionEffect | undefined
  for (const rule of matched) ruleEffect = stricter(ruleEffect ?? 'allow', rule.effect)

  // 3. 类别默认值
  const thirdParty = request.definition.trust === 'third-party'
  const effect = ruleEffect ?? (thirdParty ? 'ask' : CATEGORY_DEFAULTS[request.definition.category])

  // 可取消的询问：用户明确放行了这条命令（没有更严格的规则匹配）
  const explicitlyAllowed =
    guard?.effect === 'ask' &&
    overridable &&
    ruleEffect === 'allow' &&
    matched.some(
      (r) =>
        r.source !== 'preset' &&
        r.match.command !== undefined &&
        r.match.command.every((p) => p.trim() !== '*'),
    )
  if (explicitlyAllowed) return { decision: 'allow' }

  const final = guard ? stricter(effect, guard.effect) : effect
  if (final === 'allow') return { decision: 'allow' }

  // 理由：强制拦截优先（它决定了结果，或与规则同样严格）
  if (guard && guard.effect === final) {
    return {
      decision: final,
      reasonCode: guard.reasonCode,
      matchedRuleIds: [],
      ...(final === 'deny' ? { reason: guard.reason ?? DENY_REASON } : {}),
    }
  }
  const matchedRuleIds = matched.filter((r) => r.effect === final).map((r) => r.id)
  if (final === 'deny') {
    return {
      decision: 'deny',
      reasonCode: PermissionReasonCode.DeniedByRule,
      matchedRuleIds,
      reason: DENY_REASON,
    }
  }
  const reasonCode =
    ruleEffect === 'ask'
      ? PermissionReasonCode.RuleRequiresApproval
      : thirdParty
        ? PermissionReasonCode.ThirdPartyTool
        : PermissionReasonCode.CategoryDefault
  return { decision: 'ask', reasonCode, matchedRuleIds }
}

export function createPermissionEngine(options: PermissionEngineOptions): PermissionGate {
  return {
    decide: (request) =>
      Promise.resolve(
        decidePermission(request, options.rules(), {
          ...(options.guards ? { guards: options.guards } : {}),
          ...(options.caseInsensitive !== undefined
            ? { caseInsensitive: options.caseInsensitive }
            : {}),
        }),
      ),
  }
}

/**
 * 三种模式的预设规则（架构 §10.3）：范围为 global，来源为 preset。
 *
 * “询问”模式没有预设规则，即按类别默认值（write、execute、network 询问）：如果写成 `ask` 规则，按
 * deny > ask > allow 它会压过审批时生成的 `allow` 规则，“始终允许”就不起作用了（M1-10c 修正）。
 */
export function presetRules(mode: PermissionMode): PermissionRule[] {
  const rule = (category: ToolCategory, effect: PermissionEffect): PermissionRule => ({
    id: `preset.${mode}.${category}`,
    scope: 'global',
    effect,
    match: { category: [category] },
    source: 'preset',
  })
  const changing: ToolCategory[] = ['write', 'execute', 'network']
  switch (mode) {
    case 'read-only':
      return changing.map((c) => rule(c, 'deny'))
    case 'ask':
      return []
    case 'auto':
      return changing.map((c) => rule(c, 'allow'))
  }
}

/** 切换模式：替换预设规则，保留其他规则。 */
export function applyPreset(
  rules: readonly PermissionRule[],
  mode: PermissionMode,
): PermissionRule[] {
  return [...presetRules(mode), ...rules.filter((r) => r.source !== 'preset')]
}

/**
 * 审批时选择“本会话 / 本项目始终允许”生成的规则：同一工具、同样的路径；命令按段记录（之后每段都在其中
 * 才放行）。无法可靠拆分的命令只记录整条命令，`allow` 不会匹配，下次仍需审批。
 */
export function approvalRule(options: {
  readonly id: string
  readonly scope: 'session' | 'project'
  /** 只用到工具名（主进程按审批请求中的工具名生成）。 */
  readonly definition: Pick<ToolDefinition, 'name'>
  readonly targets: ToolTargets
}): PermissionRule {
  const { targets } = options
  const command = targets.command === undefined ? undefined : parseCommand(targets.command)
  const commandPatterns = command
    ? (command.reliable ? command.segments : [command.normalized]).map(escapeCommandPattern)
    : undefined
  return {
    id: options.id,
    scope: options.scope,
    effect: 'allow',
    match: {
      tool: options.definition.name,
      ...(targets.paths && targets.paths.length > 0 ? { path: targets.paths.map(escapeGlob) } : {}),
      ...(commandPatterns && commandPatterns.length > 0 ? { command: commandPatterns } : {}),
    },
    source: 'approval',
  }
}

/** 审批生成的规则按字面记录：命令中的 `*` 写作 `\\*`，路径中的 glob 特殊字符写作字符类（如 `[*]`）。 */
const escapeCommandPattern = (segment: string) => segment.replace(/\*/g, '\\*')
const escapeGlob = (path: string) => path.replace(/[*?{}[\]]/g, (c) => `[${c}]`)
