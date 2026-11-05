/** 两个存储实现共用的权限规则检查（M1-10c）。 */
import { StorageError, StorageErrorCode, type AddPermissionRuleInput } from './types.js'

/** 范围与归属必须一致，预设规则不保存。 */
export function checkPermissionRuleOwner(input: AddPermissionRuleInput): void {
  const { rule, projectId, sessionId } = input
  const consistent =
    rule.scope === 'global'
      ? projectId === undefined && sessionId === undefined
      : rule.scope === 'project'
        ? projectId !== undefined && sessionId === undefined
        : sessionId !== undefined && projectId === undefined
  if (!consistent || rule.source === 'preset') {
    throw new StorageError(StorageErrorCode.InvalidRecord, {
      ruleId: rule.id,
      scope: rule.scope,
      source: rule.source,
    })
  }
}

export const SCOPE_ORDER = { global: 0, project: 1, session: 2 } as const
