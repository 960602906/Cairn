import { describe, expect, it } from 'vitest'
import { ActiveTaskList, TASK_ITEM_MAX, TaskItems, taskListIdForPlan } from './index.js'

describe('待办列表 schema（ADR-0038）', () => {
  it('计划关联列表的 id 是确定性的', () => {
    expect(taskListIdForPlan('pl1')).toBe('plan-pl1')
    expect(taskListIdForPlan('pl1')).toBe(taskListIdForPlan('pl1'))
  })

  it('条目 id 沿用计划步骤规则并拒绝重复', () => {
    expect(TaskItems.safeParse([{ itemId: 'read', title: '读' }]).success).toBe(true)
    expect(TaskItems.safeParse([{ itemId: '1bad', title: '读' }]).success).toBe(false)
    expect(
      TaskItems.safeParse([
        { itemId: 'read', title: '甲' },
        { itemId: 'read', title: '乙' },
      ]).success,
    ).toBe(false)
    expect(
      TaskItems.safeParse(
        Array.from({ length: TASK_ITEM_MAX + 1 }, (_, i) => ({ itemId: `i${i}`, title: 'x' })),
      ).success,
    ).toBe(false)
  })

  it('ActiveTaskList 需要状态，并保留可选的 planId', () => {
    const list = {
      listId: 'plan-pl1',
      title: '做点事',
      source: 'plan',
      planId: 'pl1',
      items: [{ itemId: 'a', title: '第一步', status: 'in_progress' }],
    }
    expect(ActiveTaskList.safeParse(list).success).toBe(true)
    expect(ActiveTaskList.safeParse({ ...list, source: 'other' }).success).toBe(false)
    expect(
      ActiveTaskList.safeParse({ ...list, items: [{ itemId: 'a', title: '第一步' }] }).success,
    ).toBe(false)
  })
})
