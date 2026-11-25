// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskProgress } from './PlanCard.js'

afterEach(() => {
  cleanup()
})

type List = ComponentProps<typeof TaskProgress>['list']

const list = {
  title: '清单',
  items: [
    { itemId: '1', title: '一', status: 'done' },
    { itemId: '2', title: '二', status: 'in_progress' },
    { itemId: '3', title: '三', status: 'pending' },
    { itemId: '4', title: '四', status: 'skipped' },
  ],
} as unknown as List

describe('待办进度卡的图标', () => {
  it('条目：完成对勾圆、进行中转圈、未开始空心圆、跳过划线圆；标题前是待办图标', () => {
    const { container } = render(<TaskProgress list={list} running />)
    const count = (name: string) => container.querySelectorAll(`svg.lucide-${name}`).length
    expect(count('circle-check')).toBe(1)
    // 进行中的条目与“执行中”标记
    expect(count('loader-circle')).toBe(2)
    expect(count('circle-slash')).toBe(1)
    expect(count('list-todo')).toBe(1)
  })
})
