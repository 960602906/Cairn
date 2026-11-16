/**
 * 会话内的 Agent 选择器（M6-08）：输入框左下角显示当前 Agent；只列已发布且未归档的 Agent，
 * 可搜索，最近使用过的排在前面；切换后对话里出现“已切换到 …”的分隔提示。
 * 运行中不可切换由组件测试覆盖（fake 运行时的轮次结束得太快，e2e 观察不到）。
 * 另存浅色 / 深色截图。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './app.js'
import { converse, createSession, projectDir } from './session.js'

const ARTIFACTS = path.resolve(
  import.meta.dirname,
  '../../../.cache/cairn-visual-check/agent-picker',
)
mkdirSync(ARTIFACTS, { recursive: true })

async function setTheme(window: Page, theme: 'light' | 'dark') {
  await window.evaluate((value) => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { setAttribute(name: string, value: string): void } }
      }
    ).document.documentElement
    root.setAttribute('data-theme', value)
  }, theme)
}

test('在输入框里切换 Agent', async ({ launch, userData }) => {
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  await createSession(window, projectDir(userData), '切换 Agent')
  const before = await converse(window, '你好')

  const trigger = window.getByRole('button', { name: 'Agent：编程助手' })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const list = window.getByRole('listbox', { name: '选择 Agent' })
  // 四个内置 Agent 都已发布；草稿与归档的不会出现（这里也没有）。
  await expect(list.getByRole('option')).toHaveCount(4)
  await expect(list.getByRole('option', { name: /编程助手/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  const search = window.getByRole('combobox', { name: '搜索 Agent' })
  await expect(search).toBeFocused()
  await search.fill('审查')
  await expect(list.getByRole('option')).toHaveCount(1)

  await setTheme(window, 'light')
  await window.screenshot({ path: path.join(ARTIFACTS, 'agent-picker-light.png') })
  await setTheme(window, 'dark')
  await window.screenshot({ path: path.join(ARTIFACTS, 'agent-picker-dark.png') })
  await setTheme(window, 'light')

  await list.getByRole('option', { name: /代码审查员/ }).click()
  await expect(window.getByRole('button', { name: 'Agent：代码审查员' })).toBeVisible()

  // 新运行从下一轮开始：分隔提示出现在那一轮的第一条消息之前。
  await converse(window, '第二轮', before)
  await expect(window.getByText('已切换到 代码审查员 v1')).toBeVisible()

  // 最近使用的排在前面
  await window.getByRole('button', { name: 'Agent：代码审查员' }).click()
  await expect(list.getByRole('option').first()).toContainText('代码审查员')
  await window.keyboard.press('Escape')
  await expect(list).toBeHidden()
})
