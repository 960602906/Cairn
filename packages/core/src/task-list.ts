/**
 * 待办列表工具（ADR-0038）：独立于计划模式的数据与视图。
 *
 * - 普通执行轮可以创建 `ad_hoc` 列表、整体修订条目、推进单个条目；不依赖已批准计划。
 * - 计划批准时主进程创建 `source: 'plan'` 的列表，条目 id 与步骤 id 相同；旧的
 *   `update_plan_step` / `revise_plan_steps` 保留为兼容别名，内部改为操作这份列表。
 * - 恢复旧会话时（没有关联列表），别名回退到原来的 `plan.*` 事件，进度不会丢失。
 * - 这些工具的类别都是 `read`，因此能穿过计划模式的只读拦截；真正限制它们的是
 *   `taskListToolVisible`：计划轮绝不暴露列表写工具。
 */
import { z } from 'zod'
import type { ActiveTaskList, ActivePlan, TaskItem, TaskItemUpdateStatus } from '@cairn/protocol'
import {
  PLAN_STEP_MAX,
  TASK_ITEM_ID_PATTERN,
  TASK_ITEM_MAX,
  TASK_ITEM_NOTE_MAX,
  TASK_ITEM_TITLE_MAX,
  TASK_LIST_TITLE_MAX,
  TaskItemUpdateStatus as TaskItemUpdateStatusSchema,
} from '@cairn/protocol'
import { REVISE_PLAN_STEPS_TOOL, UPDATE_PLAN_STEP_TOOL, PlanErrorCode } from './plan.js'
import { ToolError, ToolErrorCode, type ToolDefinition, type ToolRegistry } from './tools.js'
import type { RuntimeToolEffect } from './runtime.js'

export const CREATE_TASK_LIST_TOOL = 'create_task_list'
export const REVISE_TASK_ITEMS_TOOL = 'revise_task_items'
export const UPDATE_TASK_ITEM_TOOL = 'update_task_item'

export const TaskListErrorCode = {
  /** 兼容别名没有可用的计划。 */
  NoActiveList: 'tasklist.no_active_list',
  UnknownList: 'tasklist.unknown_list',
  UnknownItem: 'tasklist.unknown_item',
} as const

const TASK_WRITE_TOOLS: ReadonlySet<string> = new Set([
  CREATE_TASK_LIST_TOOL,
  REVISE_TASK_ITEMS_TOOL,
  UPDATE_TASK_ITEM_TOOL,
])
const PLAN_ALIAS_TOOLS: ReadonlySet<string> = new Set([
  UPDATE_PLAN_STEP_TOOL,
  REVISE_PLAN_STEPS_TOOL,
])

/**
 * 计划轮只暴露 `propose_plan` 与普通只读工具；正常轮列表工具始终可用，
 * 旧计划别名只在有已批准计划时可用（与之前一致）。
 */
export function taskListToolVisible(
  name: string,
  mode: 'normal' | 'plan',
  hasActivePlan: boolean,
): boolean {
  if (mode === 'plan') return !TASK_WRITE_TOOLS.has(name) && !PLAN_ALIAS_TOOLS.has(name)
  if (PLAN_ALIAS_TOOLS.has(name)) return hasActivePlan
  return true
}

/** 列表工具是否属于本模块（供宿主判断是否需要注入列表快照）。 */
export function isTaskListTool(name: string): boolean {
  return (
    name === CREATE_TASK_LIST_TOOL ||
    name === REVISE_TASK_ITEMS_TOOL ||
    name === UPDATE_TASK_ITEM_TOOL ||
    name === UPDATE_PLAN_STEP_TOOL ||
    name === REVISE_PLAN_STEPS_TOOL
  )
}

export interface TaskListToolDeps {
  readonly createId: () => string
  /** 宿主内存里的列表快照（来自上一次 prompt 与本次已发出的工具效果）。 */
  readonly lists: () => readonly ActiveTaskList[]
  readonly createList: (list: ActiveTaskList) => void
  readonly reviseItems: (listId: string, items: readonly TaskItem[]) => void
  readonly updateItem: (
    listId: string,
    itemId: string,
    status: TaskItemUpdateStatus,
    note: string | undefined,
  ) => void
  /** 正在执行的已批准计划；旧别名需要它定位关联列表或回退到 `plan.*`。 */
  readonly activePlan: () => ActivePlan | undefined
  /** 回退到旧 `plan.steps.revised` 时同步宿主内存里的步骤标题。 */
  readonly revisePlan?:
    ((steps: readonly { readonly id: string; readonly title: string }[]) => void) | undefined
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('\n')
}

const ItemSchema = z.object({
  id: z.string().regex(TASK_ITEM_ID_PATTERN).optional(),
  title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
})

const CREATE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: TASK_LIST_TITLE_MAX,
      description: 'A short title for the list, such as the task it tracks.',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: TASK_ITEM_MAX,
      description:
        'Ordered task items. Optionally give each an id; ids are stable across revisions.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description:
              'Optional stable id (letters, digits, "_" or "-", starting with a letter).',
          },
          title: { type: 'string', minLength: 1, description: 'What this item is.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'items'],
  additionalProperties: false,
} as const

const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    listId: { type: 'string', minLength: 1, description: 'Id of the task list to revise.' },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: TASK_ITEM_MAX,
      description:
        'The complete ordered item list after this revision. Keep ids for retained items so their progress survives.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
        },
        required: ['id', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['listId', 'items'],
  additionalProperties: false,
} as const

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    listId: { type: 'string', minLength: 1, description: 'Id of the task list.' },
    itemId: { type: 'string', minLength: 1, description: 'Id of the item to update.' },
    status: {
      type: 'string',
      enum: ['in_progress', 'done', 'skipped'],
      description: 'The item is starting, finished, or skipped.',
    },
    note: {
      type: 'string',
      description: 'Optional note. Use it when this item deviates from the plan.',
    },
  },
  required: ['listId', 'itemId', 'status'],
  additionalProperties: false,
} as const

// 旧别名的参数与 ADR-0028 一致；修订仍以 PLAN_STEP_MAX 为上限。
const PlanAliasUpdateSchema = z.object({
  stepId: z.string().min(1),
  status: TaskItemUpdateStatusSchema,
  note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
})

const PlanAliasReviseSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().regex(TASK_ITEM_ID_PATTERN),
        title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
      }),
    )
    .min(1)
    .max(PLAN_STEP_MAX)
    .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
      message: 'duplicate step id',
    }),
})

function generatedId(index: number, used: Set<string>): string {
  let n = index + 1
  let id = `i${n}`
  while (used.has(id)) {
    n += 1
    id = `i${n}`
  }
  used.add(id)
  return id
}

function listOf(deps: TaskListToolDeps, listId: string): ActiveTaskList {
  const list = deps.lists().find((entry) => entry.listId === listId)
  if (!list) {
    throw new ToolError(
      TaskListErrorCode.UnknownList,
      `Unknown task list "${listId}". Use one of the list ids from the task list section of the system prompt.`,
      { listId },
    )
  }
  return list
}

function planList(deps: TaskListToolDeps, planId: string): ActiveTaskList | undefined {
  return deps.lists().find((list) => list.source === 'plan' && list.planId === planId)
}

function createTaskListTool(deps: TaskListToolDeps): ToolDefinition {
  return {
    name: CREATE_TASK_LIST_TOOL,
    description:
      'Create a task list to track work across a turn or a multi-step task. Use it for your own checklist even when the user did not ask for a plan. Not available in plan mode. After creating it, report progress with update_task_item.',
    inputSchema: CREATE_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(TASK_LIST_TITLE_MAX),
          items: z.array(ItemSchema).min(1).max(TASK_ITEM_MAX),
        })
        .safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid task list:\n${issuesOf(parsed.error)}`,
          { name: CREATE_TASK_LIST_TOOL },
        )
      }
      const used = new Set<string>()
      const items: TaskItem[] = parsed.data.items.map((item, index) => {
        let itemId: string
        if (item.id === undefined) {
          itemId = generatedId(index, used)
        } else {
          itemId = item.id
          if (used.has(itemId)) {
            throw new ToolError(
              ToolErrorCode.InvalidInput,
              `Duplicate item id "${itemId}". Give each item a unique id.`,
              { name: CREATE_TASK_LIST_TOOL },
            )
          }
          used.add(itemId)
        }
        return { itemId, title: item.title }
      })
      const list: ActiveTaskList = {
        listId: deps.createId(),
        title: parsed.data.title,
        source: 'ad_hoc',
        items: items.map((item) => ({ ...item, status: 'pending' as const })),
      }
      deps.createList(list)
      const effect: RuntimeToolEffect = {
        type: 'tasklist.created',
        payload: {
          listId: list.listId,
          title: list.title,
          source: list.source,
          items,
        },
      }
      const lines = items.map((item, index) => `${index + 1}. ${item.itemId}: ${item.title}`)
      return {
        content: [
          {
            type: 'text',
            text: `Created task list "${list.title}" (listId: ${list.listId}).\n${lines.join('\n')}\nUse update_task_item with this listId and an item id to report progress.`,
          },
        ],
        effects: [effect],
      }
    },
  }
}

function reviseTaskItemsTool(deps: TaskListToolDeps): ToolDefinition {
  return {
    name: REVISE_TASK_ITEMS_TOOL,
    description:
      'Replace the ordered items of a task list when the work changes. Send the complete list; keep existing ids for retained items to preserve progress, omit removed items, and use new ids for added items.',
    inputSchema: REVISE_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = z
        .object({
          listId: z.string().min(1),
          items: z
            .array(
              z.object({
                id: z.string().regex(TASK_ITEM_ID_PATTERN),
                title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
              }),
            )
            .min(1)
            .max(TASK_ITEM_MAX)
            .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
              message: 'duplicate item id',
            }),
        })
        .safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid task items:\n${issuesOf(parsed.error)}`,
          { name: REVISE_TASK_ITEMS_TOOL },
        )
      }
      const list = listOf(deps, parsed.data.listId)
      const items: TaskItem[] = parsed.data.items.map((item) => ({
        itemId: item.id,
        title: item.title,
      }))
      deps.reviseItems(list.listId, items)
      const effect: RuntimeToolEffect = {
        type: 'tasklist.items.revised',
        payload: { listId: list.listId, items },
      }
      return {
        content: [
          { type: 'text', text: `Task list "${list.title}" now has ${items.length} item(s).` },
        ],
        effects: [effect],
      }
    },
  }
}

function updateTaskItemTool(deps: TaskListToolDeps): ToolDefinition {
  return {
    name: UPDATE_TASK_ITEM_TOOL,
    description:
      'Update one item of a task list. Use the listId and itemId from the task list section. A note explains a deviation and does not block the work.',
    inputSchema: UPDATE_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = z
        .object({
          listId: z.string().min(1),
          itemId: z.string().regex(TASK_ITEM_ID_PATTERN),
          status: TaskItemUpdateStatusSchema,
          note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
        })
        .safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid task item update:\n${issuesOf(parsed.error)}`,
          { name: UPDATE_TASK_ITEM_TOOL },
        )
      }
      const { listId, itemId, status } = parsed.data
      const list = listOf(deps, listId)
      if (!list.items.some((item) => item.itemId === itemId)) {
        const ids = list.items.map((item) => item.itemId).join(', ')
        throw new ToolError(
          TaskListErrorCode.UnknownItem,
          `Unknown item id "${itemId}". Use one of: ${ids}.`,
          { listId, itemId },
        )
      }
      const trimmed = parsed.data.note?.trim()
      const note = trimmed ? trimmed : undefined
      deps.updateItem(listId, itemId, status, note)
      const effect: RuntimeToolEffect = {
        type: 'tasklist.item.updated',
        payload: { listId, itemId, status, ...(note ? { note } : {}) },
      }
      return {
        content: [{ type: 'text', text: `Item ${itemId} is now ${status}.` }],
        effects: [effect],
      }
    },
  }
}

/** 兼容别名：`update_plan_step`。有关联列表时操作列表，否则回退到旧 `plan.*`。 */
function updatePlanStepTool(deps: TaskListToolDeps): ToolDefinition {
  return {
    name: UPDATE_PLAN_STEP_TOOL,
    description:
      'Update one step of the approved plan. Use the step id. A note explains a deviation and does not block the work.',
    inputSchema: {
      type: 'object',
      properties: {
        stepId: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['in_progress', 'done', 'skipped'] },
        note: { type: 'string' },
      },
      required: ['stepId', 'status'],
      additionalProperties: false,
    },
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = PlanAliasUpdateSchema.safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid step update:\n${issuesOf(parsed.error)}`,
          { name: UPDATE_PLAN_STEP_TOOL },
        )
      }
      const plan = deps.activePlan()
      if (!plan) {
        throw new ToolError(
          PlanErrorCode.NoActivePlan,
          'No approved plan is being executed, so update_plan_step is not available.',
        )
      }
      const { stepId, status } = parsed.data
      const trimmed = parsed.data.note?.trim()
      const note = trimmed ? trimmed : undefined
      const list = planList(deps, plan.planId)
      if (list) {
        if (!list.items.some((item) => item.itemId === stepId)) {
          const ids = list.items.map((item) => item.itemId).join(', ')
          throw new ToolError(
            PlanErrorCode.UnknownStep,
            `Unknown step id "${stepId}". Use one of: ${ids}.`,
            { stepId },
          )
        }
        deps.updateItem(list.listId, stepId, status, note)
        return {
          content: [{ type: 'text', text: `Step ${stepId} is now ${status}.` }],
          effects: [
            {
              type: 'tasklist.item.updated',
              payload: {
                listId: list.listId,
                itemId: stepId,
                status,
                ...(note ? { note } : {}),
              },
            },
          ],
        }
      }
      // 旧会话：没有关联列表，继续写 `plan.step.updated`，进度仍在 plan.steps 上。
      const stepIndex = plan.steps.findIndex((step) => step.id === stepId)
      if (stepIndex < 0) {
        const ids = plan.steps.map((step) => step.id).join(', ')
        throw new ToolError(
          PlanErrorCode.UnknownStep,
          `Unknown step id "${stepId}". Use one of: ${ids}.`,
          { stepId },
        )
      }
      return {
        content: [{ type: 'text', text: `Step ${stepId} is now ${status}.` }],
        effects: [
          {
            type: 'plan.step.updated',
            payload: {
              planId: plan.planId,
              stepId,
              stepIndex,
              status,
              ...(note ? { note } : {}),
            },
          },
        ],
      }
    },
  }
}

/** 兼容别名：`revise_plan_steps`。 */
function revisePlanStepsTool(deps: TaskListToolDeps): ToolDefinition {
  return {
    name: REVISE_PLAN_STEPS_TOOL,
    description:
      'Replace the ordered steps of the approved plan when the user changes the task. Send the complete list; keep existing ids for retained steps to preserve progress.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: PLAN_STEP_MAX,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
            },
            required: ['id', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = PlanAliasReviseSchema.safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid steps:\n${issuesOf(parsed.error)}`,
          { name: REVISE_PLAN_STEPS_TOOL },
        )
      }
      const plan = deps.activePlan()
      if (!plan) {
        throw new ToolError(
          PlanErrorCode.NoActivePlan,
          'No approved plan is being executed, so revise_plan_steps is not available.',
        )
      }
      const steps = parsed.data.steps
      const list = planList(deps, plan.planId)
      if (list) {
        const items: TaskItem[] = steps.map((step) => ({ itemId: step.id, title: step.title }))
        deps.reviseItems(list.listId, items)
        return {
          content: [
            { type: 'text', text: 'Plan steps revised. Continue working on the updated list.' },
          ],
          effects: [
            {
              type: 'tasklist.items.revised',
              payload: { listId: list.listId, items },
            },
          ],
        }
      }
      // 旧会话：继续写 `plan.steps.revised`。
      deps.revisePlan?.(steps)
      return {
        content: [
          { type: 'text', text: 'Plan steps revised. Continue working on the updated list.' },
        ],
        effects: [
          {
            type: 'plan.steps.revised',
            payload: { planId: plan.planId, steps },
          },
        ],
      }
    },
  }
}

/** 注册待办列表工具与计划兼容别名。是否交给模型由 `taskListToolVisible` / `planToolVisible` 决定。 */
export function registerTaskListTools(registry: ToolRegistry, deps: TaskListToolDeps): void {
  registry.register(createTaskListTool(deps))
  registry.register(reviseTaskItemsTool(deps))
  registry.register(updateTaskItemTool(deps))
  registry.register(updatePlanStepTool(deps))
  registry.register(revisePlanStepsTool(deps))
}

/** 供测试使用：列出本模块注册的工具名。 */
export const TASK_LIST_TOOL_NAMES = [
  CREATE_TASK_LIST_TOOL,
  REVISE_TASK_ITEMS_TOOL,
  UPDATE_TASK_ITEM_TOOL,
  UPDATE_PLAN_STEP_TOOL,
  REVISE_PLAN_STEPS_TOOL,
] as const
