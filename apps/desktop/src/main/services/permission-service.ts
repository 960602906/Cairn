/**
 * 权限规则（M1-10c，ADR-0007，架构 §10）：主进程保存规则，启动宿主时汇总适用于会话的规则，经
 * `host.init` 下发；宿主的权限引擎据此判定。
 *
 * 适用于会话的规则依次为：当前权限模式的预设（不保存，由模式生成）、全局规则、会话所属项目的规则、
 * 会话的规则。范围不影响判定结果（deny > ask > allow），顺序只用于展示。
 *
 * 新增规则：审批时选择“始终允许”（M1-11b，`addRule`）；设置页手动添加、删除（M2-11，`addUserRule`、
 * `deleteRule`），设置页列出全局与各项目的规则（`listRules`）。调用方在增删之后通知运行中的宿主。
 */
import { presetRules } from '@cairn/core'
import {
  PermissionRule,
  RpcError,
  type PermissionMode,
  type PermissionRuleEntry,
} from '@cairn/protocol'
import { StorageError, type Storage } from '@cairn/storage'

export const PermissionServiceErrorCode = {
  /** 会话不存在。 */
  NotFound: 'storage.not_found',
  InvalidParams: 'rpc.invalid_params',
} as const

export interface PermissionServiceOptions {
  readonly storage: Pick<Storage, 'sessions' | 'projects' | 'permissionRules'>
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
  /** 全局规则，再按项目（打开时间倒序）列出项目规则（M2-11）；不含预设与会话规则。 */
  listRules(): PermissionRuleEntry[]
  /**
   * 手动添加一条规则（M2-11）：来源必须是 `user`，范围为 `global`，或为 `project` 且给出存在的项目。
   * 不满足时报 `rpc.invalid_params`，项目不存在时报 `storage.not_found`。
   */
  addUserRule(rule: PermissionRule, projectId?: string): PermissionRuleEntry
  /** 删除一条保存的规则；不存在时报 `storage.not_found`。 */
  deleteRule(ruleId: string): void
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

    listRules() {
      const entry = (record: {
        rule: PermissionRule
        projectId?: string
        createdAt: number
      }): PermissionRuleEntry => ({
        rule: record.rule,
        ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
        createdAt: record.createdAt,
      })
      const global = storage.permissionRules.list().map(entry)
      const projects = storage.projects.list().flatMap(({ projectId }) =>
        storage.permissionRules
          .list({ projectId })
          .filter((record) => record.projectId === projectId)
          .map(entry),
      )
      return [...global, ...projects]
    },

    addUserRule(input, projectId) {
      const parsed = PermissionRule.safeParse(input)
      const rule = parsed.success ? parsed.data : undefined
      const owned =
        rule?.scope === 'global'
          ? projectId === undefined
          : rule?.scope === 'project' && projectId !== undefined
      if (!rule || rule.source !== 'user' || !owned) {
        throw new RpcError(PermissionServiceErrorCode.InvalidParams, { ruleId: String(input.id) })
      }
      if (projectId !== undefined && !storage.projects.get(projectId)) {
        throw new RpcError(PermissionServiceErrorCode.NotFound, { projectId })
      }
      let record
      try {
        record = storage.permissionRules.add({
          rule,
          ...(projectId !== undefined ? { projectId } : {}),
        })
      } catch (error) {
        // id 重复（`storage.conflict`）等按原错误码交给界面
        if (error instanceof StorageError) throw new RpcError(error.code, error.params)
        throw error
      }
      return {
        rule: record.rule,
        ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
        createdAt: record.createdAt,
      }
    },

    deleteRule(ruleId) {
      if (!storage.permissionRules.get(ruleId)) {
        throw new RpcError(PermissionServiceErrorCode.NotFound, { ruleId })
      }
      storage.permissionRules.delete(ruleId)
    },
  }
}
