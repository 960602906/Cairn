import type { ActivePlan, ActiveTaskList } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  CREATE_TASK_LIST_TOOL,
  PlanErrorCode,
  REVISE_PLAN_STEPS_TOOL,
  REVISE_TASK_ITEMS_TOOL,
  TaskListErrorCode,
  UPDATE_PLAN_STEP_TOOL,
  UPDATE_TASK_ITEM_TOOL,
  createToolRegistry,
  isTaskListTool,
  registerTaskListTools,
  TASK_LIST_TOOL_NAMES,
  taskListToolVisible,
  type ToolContext,
} from './index.js'

const ctx = {} as ToolContext

interface HarnessOptions {
  readonly lists?: readonly ActiveTaskList[]
  readonly plan?: ActivePlan
}

/** 注册列表工具，并在内存里模拟宿主的镜像回写。 */
function harness({ lists: initial = [], plan: initialPlan }: HarnessOptions = {}) {
  let lists = initial.map((list) => ({ ...list, items: list.items.map((item) => ({ ...item })) }))
  let plan = initialPlan
  let nextId = 0
  const registry = createToolRegistry()
  registerTaskListTools(registry, {
    createId: () => `id${++nextId}`,
    lists: () => lists,
    createList: (list) => {
      lists = [...lists, list]
    },
    reviseItems: (listId, items) => {
      lists = lists.map((list) => {
        if (list.listId !== listId) return list
        const prior = new Map(list.items.map((item) => [item.itemId, item]))
        return {
          ...list,
          items: items.map((item) => {
            const previous = prior.get(item.itemId)
            return {
              itemId: item.itemId,
              title: item.title,
              status: previous?.status ?? 'pending',
              ...(previous?.note ? { note: previous.note } : {}),
            }
          }),
        }
      })
    },
    updateItem: (listId, itemId, status, note) => {
      lists = lists.map((list) =>
        list.listId === listId
          ? {
              ...list,
              items: list.items.map((item) =>
                item.itemId === itemId
                  ? {
                      ...item,
                      status,
                      ...(note ? { note } : item.note ? { note: item.note } : {}),
                    }
                  : item,
              ),
            }
          : list,
      )
    },
    activePlan: () => plan,
    revisePlan: (steps) => {
      if (plan) plan = { ...plan, steps: steps.map((step) => ({ ...step })) }
    },
  })
  return {
    registry,
    lists: () => lists,
    setPlan: (value: ActivePlan | undefined) => {
      plan = value
    },
    run: (name: string, input: unknown) => registry.get(name)!.execute(input, ctx),
  }
}

const plan: ActivePlan = {
  planId: 'pl1',
  goal: '做点事',
  steps: [{ id: 'a', title: '第一步' }],
}

const planList: ActiveTaskList = {
  listId: 'plan-pl1',
  title: '做点事',
  source: 'plan',
  planId: 'pl1',
  items: [{ itemId: 'a', title: '第一步', status: 'pending' }],
}

describe('task list tools', () => {
  it('tells the model to report progress as it works instead of at the end', () => {
    const h = harness()
    for (const name of [UPDATE_TASK_ITEM_TOOL, UPDATE_PLAN_STEP_TOOL]) {
      const description = h.registry.get(name)!.description
      expect(description).toContain('in_progress right before you start')
      expect(description).toContain('done or skipped right after you finish it')
      expect(description).toContain('never batched at the end')
    }
  })

  it('creates an ad-hoc list with generated ids and pending items', async () => {
    const h = harness()
    const output = await h.run(CREATE_TASK_LIST_TOOL, {
      title: '修测试',
      items: [{ title: '读用例' }, { title: '改代码' }],
    })
    expect(output.effects).toEqual([
      {
        type: 'tasklist.created',
        payload: {
          listId: 'id1',
          title: '修测试',
          source: 'ad_hoc',
          items: [
            { itemId: 'i1', title: '读用例' },
            { itemId: 'i2', title: '改代码' },
          ],
        },
      },
    ])
    expect(h.lists()[0]).toMatchObject({
      listId: 'id1',
      items: [
        { itemId: 'i1', status: 'pending' },
        { itemId: 'i2', status: 'pending' },
      ],
    })
  })

  it('skips occupied generated ids without duplicating a later item', async () => {
    const h = harness()
    const output = await h.run(CREATE_TASK_LIST_TOOL, {
      title: '冲突',
      items: [{ id: 'i2', title: '预留' }, { title: '自动编号' }],
    })
    expect(output.effects?.[0]).toMatchObject({
      payload: { items: [{ itemId: 'i2' }, { itemId: 'i3' }] },
    })
    expect(h.lists()[0]?.items.map((item) => item.itemId)).toEqual(['i2', 'i3'])
  })

  it('keeps given ids and rejects duplicates', async () => {
    const h = harness()
    const output = await h.run(CREATE_TASK_LIST_TOOL, {
      title: '修测试',
      items: [{ id: 'read', title: '读用例' }],
    })
    expect(output.effects?.[0]).toMatchObject({
      payload: { items: [{ itemId: 'read', title: '读用例' }] },
    })
    await expect(
      h.run(CREATE_TASK_LIST_TOOL, {
        title: '修测试',
        items: [
          { id: 'read', title: '甲' },
          { id: 'read', title: '乙' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
  })

  it('updates an item and rejects unknown lists or items', async () => {
    const h = harness({ lists: [planList] })
    const output = await h.run(UPDATE_TASK_ITEM_TOOL, {
      listId: 'plan-pl1',
      itemId: 'a',
      status: 'done',
      note: ' 完成 ',
    })
    expect(output.effects).toEqual([
      {
        type: 'tasklist.item.updated',
        payload: { listId: 'plan-pl1', itemId: 'a', status: 'done', note: '完成' },
      },
    ])
    expect(h.lists()[0]?.items[0]).toMatchObject({ status: 'done', note: '完成' })
    await expect(
      h.run(UPDATE_TASK_ITEM_TOOL, { listId: 'nope', itemId: 'a', status: 'done' }),
    ).rejects.toMatchObject({ code: TaskListErrorCode.UnknownList })
    await expect(
      h.run(UPDATE_TASK_ITEM_TOOL, { listId: 'plan-pl1', itemId: 'nope', status: 'done' }),
    ).rejects.toMatchObject({ code: TaskListErrorCode.UnknownItem })
  })

  it('updates an item without a note', async () => {
    const h = harness({ lists: [planList] })
    const output = await h.run(UPDATE_TASK_ITEM_TOOL, {
      listId: 'plan-pl1',
      itemId: 'a',
      status: 'in_progress',
    })
    expect(output.effects).toEqual([
      {
        type: 'tasklist.item.updated',
        payload: { listId: 'plan-pl1', itemId: 'a', status: 'in_progress' },
      },
    ])
    expect(h.lists()[0]?.items[0]).toMatchObject({ status: 'in_progress' })
  })

  it('rejects malformed list input with readable issues', async () => {
    const h = harness()
    await expect(h.run(CREATE_TASK_LIST_TOOL, null)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(h.run(CREATE_TASK_LIST_TOOL, { title: '空', items: [] })).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(
      h.run(REVISE_TASK_ITEMS_TOOL, { listId: 'nope', items: [] }),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
    await expect(
      h.run(UPDATE_TASK_ITEM_TOOL, { listId: 'tl1', itemId: 'a', status: 'unknown' }),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
  })

  it('revises items while keeping progress of retained ids', async () => {
    const h = harness({
      lists: [
        {
          ...planList,
          items: [
            { itemId: 'a', title: '第一步', status: 'done', note: '好了' },
            { itemId: 'b', title: '第二步', status: 'in_progress' },
          ],
        },
      ],
    })
    const output = await h.run(REVISE_TASK_ITEMS_TOOL, {
      listId: 'plan-pl1',
      items: [
        { id: 'b', title: '第二步（改名）' },
        { id: 'c', title: '新增' },
      ],
    })
    expect(output.effects).toEqual([
      {
        type: 'tasklist.items.revised',
        payload: {
          listId: 'plan-pl1',
          items: [
            { itemId: 'b', title: '第二步（改名）' },
            { itemId: 'c', title: '新增' },
          ],
        },
      },
    ])
    expect(h.lists()[0]?.items).toEqual([
      { itemId: 'b', title: '第二步（改名）', status: 'in_progress' },
      { itemId: 'c', title: '新增', status: 'pending' },
    ])
  })
})

describe('plan compatibility aliases', () => {
  it('writes list events when the plan has a linked list', async () => {
    const h = harness({ lists: [planList], plan })
    const update = await h.run(UPDATE_PLAN_STEP_TOOL, { stepId: 'a', status: 'done' })
    expect(update.effects).toEqual([
      {
        type: 'tasklist.item.updated',
        payload: { listId: 'plan-pl1', itemId: 'a', status: 'done' },
      },
    ])
    const revise = await h.run(REVISE_PLAN_STEPS_TOOL, {
      steps: [
        { id: 'a', title: '第一步' },
        { id: 'b', title: '新增' },
      ],
    })
    expect(revise.effects).toEqual([
      {
        type: 'tasklist.items.revised',
        payload: {
          listId: 'plan-pl1',
          items: [
            { itemId: 'a', title: '第一步' },
            { itemId: 'b', title: '新增' },
          ],
        },
      },
    ])
    expect(h.lists()[0]?.items.map((item) => item.itemId)).toEqual(['a', 'b'])
  })

  it('rejects unknown steps and invalid updates on the alias', async () => {
    const h = harness({ lists: [planList], plan })
    await expect(h.run(UPDATE_PLAN_STEP_TOOL, { stepId: 'a' })).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(
      h.run(UPDATE_PLAN_STEP_TOOL, { stepId: 'nope', status: 'done' }),
    ).rejects.toMatchObject({ code: PlanErrorCode.UnknownStep })
    const output = await h.run(UPDATE_PLAN_STEP_TOOL, {
      stepId: 'a',
      status: 'in_progress',
      note: ' 偏离 ',
    })
    expect(output.effects?.[0]).toMatchObject({
      type: 'tasklist.item.updated',
      payload: { listId: 'plan-pl1', itemId: 'a', status: 'in_progress', note: '偏离' },
    })
  })

  it('falls back to plan events for sessions without a list', async () => {
    const h = harness({ plan })
    const update = await h.run(UPDATE_PLAN_STEP_TOOL, { stepId: 'a', status: 'done' })
    expect(update.effects).toEqual([
      {
        type: 'plan.step.updated',
        payload: { planId: 'pl1', stepId: 'a', stepIndex: 0, status: 'done' },
      },
    ])
    const revise = await h.run(REVISE_PLAN_STEPS_TOOL, { steps: [{ id: 'a', title: '改写' }] })
    expect(revise.effects).toEqual([
      {
        type: 'plan.steps.revised',
        payload: { planId: 'pl1', steps: [{ id: 'a', title: '改写' }] },
      },
    ])
    h.setPlan(undefined)
    await expect(
      h.run(UPDATE_PLAN_STEP_TOOL, { stepId: 'a', status: 'done' }),
    ).rejects.toMatchObject({ code: PlanErrorCode.NoActivePlan })
  })
})

describe('task list visibility', () => {
  it('hides list writes in plan mode and hides aliases without a plan', () => {
    expect(taskListToolVisible(CREATE_TASK_LIST_TOOL, 'plan', false)).toBe(false)
    expect(taskListToolVisible(UPDATE_TASK_ITEM_TOOL, 'plan', true)).toBe(false)
    expect(taskListToolVisible(CREATE_TASK_LIST_TOOL, 'normal', false)).toBe(true)
    expect(taskListToolVisible(UPDATE_PLAN_STEP_TOOL, 'normal', false)).toBe(false)
    expect(taskListToolVisible(UPDATE_PLAN_STEP_TOOL, 'normal', true)).toBe(true)
    expect(taskListToolVisible('read_file', 'normal', false)).toBe(true)
    expect(taskListToolVisible('read_file', 'plan', false)).toBe(true)
  })

  it('recognises its own tools', () => {
    for (const name of TASK_LIST_TOOL_NAMES) expect(isTaskListTool(name)).toBe(true)
    expect(isTaskListTool('read_file')).toBe(false)
  })
})
