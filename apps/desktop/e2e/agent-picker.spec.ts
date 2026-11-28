/**
 * 会话内与新对话页的 Agent 选择器（M6-08、管理界面 §7）：输入框左下角显示当前 Agent；
 * 只列已发布且未归档的 Agent，内置在前、自定义在后，可搜索；切换后对话里出现“已切换到 …”的
 * 分隔提示；运行中禁用并提示“运行结束后可切换”。另存浅色 / 深色截图。
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

async function shot(window: Page, name: string) {
  await setTheme(window, 'light')
  await window.screenshot({ path: path.join(ARTIFACTS, `${name}-light.png`) })
  await setTheme(window, 'dark')
  await window.screenshot({ path: path.join(ARTIFACTS, `${name}-dark.png`) })
  await setTheme(window, 'light')
}

test('在新对话页与会话里选择 Agent', async ({ launch, userData }) => {
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

  // 新对话页：还没有会话，选择器显示默认 Agent。
  const newSessionTrigger = window.getByRole('button', { name: '切换 Agent：编程助手' })
  await expect(newSessionTrigger).toBeVisible()
  await shot(window, 'new-session')

  await createSession(window, projectDir(userData), '切换 Agent')
  const before = await converse(window, '你好')

  const trigger = window.getByRole('button', { name: '切换 Agent：编程助手' })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const list = window.getByRole('listbox', { name: '选择 Agent' })
  // 三个内置团队模板与四个内置 Agent 都已发布；草稿与归档的不会出现（这里也没有）。
  await expect(list.getByRole('option')).toHaveCount(7)
  await expect(list.locator('[role="option"][data-kind="team"]')).toHaveCount(3)
  await expect(list.getByRole('option', { name: /代码审查小组/ })).toBeVisible()
  // 团队模板的副标题里也会出现主控名，这里只看单个 Agent 行。
  await expect(
    list.locator('[role="option"][data-kind="agent"]').filter({ hasText: '编程助手' }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(window.getByRole('button', { name: '管理 Agents' })).toBeVisible()
  await shot(window, 'menu-open')

  const search = window.getByRole('combobox', { name: '搜索 Agent' })
  await expect(search).toBeFocused()
  await search.fill('审查')
  await expect(list.getByRole('option')).toHaveCount(2)
  await search.fill('')

  // 团队模板副标题也可能带上审查员名字；只点单个 Agent 行。
  await list.locator('[role="option"][data-kind="agent"]').filter({ hasText: '代码审查员' }).click()
  await expect(window.getByRole('button', { name: '切换 Agent：代码审查员' })).toBeVisible()

  // 新运行从下一轮开始：分隔提示出现在那一轮的第一条消息之前。
  await converse(window, '第二轮', before)
  await expect(window.getByText('已切换到 代码审查员 v1')).toBeVisible()
  await shot(window, 'switched')

  // 运行中禁用：fake 运行时逐字回显，输入足够长就能停在运行中截图。
  const input = window.getByLabel('输入消息')
  await input.fill('慢慢回答 '.repeat(200))
  await window.getByRole('button', { name: '发送' }).click()
  await expect(window.getByRole('button', { name: '停止' })).toBeVisible()
  const runningTrigger = window.getByRole('button', { name: '切换 Agent：代码审查员' })
  await expect(runningTrigger).toBeDisabled()
  await expect(runningTrigger).toHaveAttribute('title', '运行结束后可切换')
  await shot(window, 'running-disabled')
  await window.getByRole('button', { name: '停止' }).click()
  await expect(runningTrigger).toBeEnabled()

  // 最近使用的排在前面（同一组内；团队模板单独成组，不计入）。
  await runningTrigger.click()
  await expect(list.locator('[role="option"][data-kind="agent"]').first()).toContainText(
    '代码审查员',
  )
  await window.keyboard.press('Escape')
  await expect(list).toBeHidden()
})
