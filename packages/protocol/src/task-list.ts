/**
 * 待办列表（ADR-0038）：独立于计划模式的可持久化任务列表。
 *
 * 计划模式是**一轮运行方式**（只读调查、提出方案、等用户批准），待办列表是**数据与视图**：
 * 一组有稳定 id、顺序和状态的任务项，普通执行轮也能创建、修订和推进。计划步骤只是列表的一个
 * 来源：批准时以批准后的步骤创建执行列表（`itemId` 与步骤 `id` 相同），此后进度以列表事件为准。
 *
 * 容量与 `PLAN_STEP_MAX` 分开：列表是通用工作跟踪，不应继承单份方案的 20 步上限。
 */
import { z } from 'zod'
import { Id } from './common.js'
import { PlanStepStatus } from './plan.js'

/** 列表来源：普通轮次临时创建、由已批准计划创建、由委派创建。 */
export const TaskListSource = z.enum(['ad_hoc', 'plan', 'delegation'])
export type TaskListSource = z.infer<typeof TaskListSource>

/** 任务项 id：与计划步骤 id 同一规则，便于计划来源的列表保持 `itemId = stepId`。 */
export const TASK_ITEM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

export const TASK_LIST_TITLE_MAX = 200
export const TASK_ITEM_TITLE_MAX = 200
export const TASK_ITEM_NOTE_MAX = 2_000
/** 单份列表的任务项上限，独立于 `PLAN_STEP_MAX`。 */
export const TASK_ITEM_MAX = 100

/** 条目状态沿用计划步骤的四种。工具只能报后三种；`pending` 是还没开始。 */
export const TaskItemStatus = PlanStepStatus
export type TaskItemStatus = z.infer<typeof TaskItemStatus>

/** 工具与列表修订只能报这三种状态。 */
export const TaskItemUpdateStatus = z.enum(['in_progress', 'done', 'skipped'])
export type TaskItemUpdateStatus = z.infer<typeof TaskItemUpdateStatus>

/** 事件里的结构项：只有稳定 id 与标题，状态与说明由后续事件推进。 */
export const TaskItem = z.object({
  itemId: z.string().regex(TASK_ITEM_ID_PATTERN),
  title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
})
export type TaskItem = z.infer<typeof TaskItem>

/** 有序任务项列表；id 必须唯一。用于创建与整体修订事件。 */
export const TaskItems = z
  .array(TaskItem)
  .min(1)
  .max(TASK_ITEM_MAX)
  .superRefine((items, ctx) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.itemId)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate item id ${item.itemId}`,
          path: [index, 'itemId'],
        })
      }
      seen.add(item.itemId)
    })
  })

/** 批准/执行期间交给宿主的列表快照（含当前状态与说明）。 */
export const ActiveTaskItem = z.object({
  itemId: z.string().regex(TASK_ITEM_ID_PATTERN),
  title: z.string().min(1).max(TASK_ITEM_TITLE_MAX),
  status: TaskItemStatus,
  note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
})
export type ActiveTaskItem = z.infer<typeof ActiveTaskItem>

export const ActiveTaskList = z.object({
  listId: Id,
  title: z.string().min(1).max(TASK_LIST_TITLE_MAX),
  source: TaskListSource,
  /** 计划来源的列表指向对应计划。 */
  planId: Id.optional(),
  items: z.array(ActiveTaskItem).min(1).max(TASK_ITEM_MAX),
})
export type ActiveTaskList = z.infer<typeof ActiveTaskList>

/** 计划关联列表的确定性 id：旧会话没有 `tasklist.created`，投影据此合成同一份列表供进度卡显示。 */
export { taskListIdForPlan } from './task-list-id.js'
