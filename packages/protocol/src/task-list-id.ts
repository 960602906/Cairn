/**
 * 计划关联任务列表的确定性 id（从 `task-list.ts` 拆出）：会话投影与界面都会算它，
 * 但不需要列表 schema，因此单独放在没有 zod 的模块里。
 */

/** 计划关联列表的确定性 id（计划批准时使用）。 */
export function taskListIdForPlan(planId: string): string {
  return `plan-${planId}`
}
