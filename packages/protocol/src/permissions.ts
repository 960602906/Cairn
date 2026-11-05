/**
 * 权限规则（ADR-0007，架构 §10.1，M1-10a）。规则由主进程保存（M1-10c），随 `host.init` 下发给宿主，
 * 由 core 的权限引擎判定。
 */
import { z } from 'zod'
import { Id } from './common.js'

/** 工具类别（与 core 的 `ToolCategory` 一致）。 */
export const ToolCategory = z.enum(['read', 'write', 'execute', 'network', 'delegate'])
export type ToolCategory = z.infer<typeof ToolCategory>

export const PermissionScope = z.enum(['global', 'project', 'session'])
export type PermissionScope = z.infer<typeof PermissionScope>

export const PermissionEffect = z.enum(['allow', 'ask', 'deny'])
export type PermissionEffect = z.infer<typeof PermissionEffect>

/** 规则来源：预设、用户手动配置、审批时选择“始终允许”。 */
export const PermissionRuleSource = z.enum(['preset', 'user', 'approval'])
export type PermissionRuleSource = z.infer<typeof PermissionRuleSource>

const NonEmpty = z.string().min(1)

/**
 * 匹配条件：给出的各项都要满足；一项中有多个值时满足其一即可。没有任何条件时匹配所有调用。
 *
 * - `tool`：工具名；
 * - `category`：工具类别；
 * - `path`：相对工作区的 glob（`*`、`**`、`?`、`{a,b}`），如 `src/**`、`**\/.env*`；
 * - `command`：命令模式，`*` 匹配任意字符，如 `npm test`、`git status*`。
 */
export const PermissionMatch = z
  .object({
    tool: z.union([NonEmpty, z.array(NonEmpty).min(1)]).optional(),
    category: z.array(ToolCategory).min(1).optional(),
    path: z.array(NonEmpty).min(1).optional(),
    command: z.array(NonEmpty).min(1).optional(),
  })
  .strict()
export type PermissionMatch = z.infer<typeof PermissionMatch>

export const PermissionRule = z.object({
  id: Id,
  scope: PermissionScope,
  effect: PermissionEffect,
  match: PermissionMatch,
  source: PermissionRuleSource,
})
export type PermissionRule = z.infer<typeof PermissionRule>

/** 三种权限模式（架构 §10.3）：只是三组预设规则。 */
export const PermissionMode = z.enum(['read-only', 'ask', 'auto'])
export type PermissionMode = z.infer<typeof PermissionMode>
