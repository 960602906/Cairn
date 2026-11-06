/**
 * 权限规则（M1-10c，ADR-0007，架构 §10）：主进程保存规则，启动宿主时汇总适用于会话的规则，经
 * `host.init` 下发；宿主的权限引擎据此判定。
 *
 * 适用于会话的规则依次为：当前权限模式的预设（不保存，由模式生成）、全局规则、会话所属项目的规则、
 * 会话的规则。范围不影响判定结果（deny > ask > allow），顺序只用于展示。
 *
 * 新增规则（审批时选择“始终允许”、用户手动配置）在 M1-11b 使用；运行中的宿主如何得到新规则随 M1-11 决定。
 */
import { presetRules } from '@cairn/core'
import { PermissionRule, RpcError, type PermissionMode } from '@cairn/protocol'
import type { Storage } from '@cairn/storage'

export const PermissionServiceErrorCode = {
  /** 会话不存在。 */
  NotFound: 'storage.not_found',
  InvalidParams: 'rpc.invalid_params',
} as const

export interface PermissionServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'permissionRules'>
  /** 当前的权限模式（设置）。 */
  readonly mode: () => PermissionMode
}

export interface PermissionService {
  /** 适用于会话的全部规则（含预设）。会话不存在时报 `storage.not_found`。 */
  rulesForSession(sessionId: string): PermissionRule[]
  /**
   * 保存一条规则：项目范围的规则归属会话所属的项目，会话范围的规则归属会话。规则无效或来源为预设时报
   * `rpc.invalid_params`，会话不存在时报 `storage.not_found`。
   */
  addRule(sessionId: string, rule: PermissionRule): PermissionRule
}

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const { storage } = options

  const requireSession = (sessionId: string) => {
    const session = storage.sessions.get(sessionId)
    if (!session) throw new RpcError(PermissionServiceErrorCode.NotFound, { sessionId })
    return session
  }

  return {
    rulesForSession(sessionId) {
      const { projectId } = requireSession(sessionId)
      const stored = storage.permissionRules.list({ projectId, sessionId })
      return [...presetRules(options.mode()), ...stored.map((r) => r.rule)]
    },

    addRule(sessionId, input) {
      const parsed = PermissionRule.safeParse(input)
      if (!parsed.success || parsed.data.source === 'preset') {
        throw new RpcError(PermissionServiceErrorCode.InvalidParams, { ruleId: String(input.id) })
      }
      const rule = parsed.data
      const { projectId } = requireSession(sessionId)
      storage.permissionRules.add({
        rule,
        ...(rule.scope === 'project' ? { projectId } : {}),
        ...(rule.scope === 'session' ? { sessionId } : {}),
      })
      return rule
    },
  }
}
