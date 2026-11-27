/**
 * 内置团队模板（M7-09 打磨）：设置 → 团队模板里随应用提供三个内置模板。
 * 打开后只读：没有保存、发布与归档入口，但可以直接试运行，或「复制为副本」
 * 得到可编辑、可发布的用户模板。
 */
import { expect, test } from './app.js'

test('内置模板只读，可试运行并复制为可编辑的副本', async ({ launch }) => {
  const { window } = await launch()

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^团队模板/ }).click()
  await expect(window.getByRole('heading', { name: '团队模板', level: 2 })).toBeVisible()

  const list = window.getByRole('list', { name: '团队模板' })
  const rows = list.getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: '内置' })).toHaveCount(3)

  // 打开内置模板：只读提示 + 试运行 / 复制为副本，没有保存、发布与归档。
  await list.getByRole('button', { name: /代码审查小组/ }).click()
  await expect(window.getByRole('heading', { name: '代码审查小组', level: 2 })).toBeVisible()
  await expect(window.getByText(/内置模板只读/)).toBeVisible()
  await expect(window.getByText('内置', { exact: true })).toBeVisible()
  // 表单整块只读：浏览器里也不能输入。
  await expect(window.getByLabel('中文名称')).toBeDisabled()
  await expect(window.getByLabel('主控 Agent')).toBeDisabled()
  await expect(window.getByRole('button', { name: '试运行' })).toBeEnabled()
  await expect(window.getByRole('button', { name: '复制为副本' })).toBeVisible()
  await expect(window.getByRole('button', { name: '保存草稿' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: /^发布/ })).toHaveCount(0)
  await expect(window.getByRole('button', { name: '更多操作' })).toHaveCount(0)

  // 试运行面板用的是代码里的版本，不需要先存草稿。
  await window.getByRole('button', { name: '试运行' }).click()
  await expect(window.getByRole('dialog')).toBeVisible()
  await expect(window.getByRole('button', { name: '开始试运行' })).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(window.getByRole('dialog')).toBeHidden()

  // 复制为副本：切到新的用户模板，恢复保存与发布入口。
  await window.getByRole('button', { name: '复制为副本' }).click()
  await expect(window.getByRole('heading', { name: '代码审查小组 副本', level: 2 })).toBeVisible()
  await expect(window.getByText(/内置模板只读/)).toHaveCount(0)
  await expect(window.getByText('内置', { exact: true })).toHaveCount(0)
  await expect(window.getByLabel('中文名称')).toBeEnabled()
  await expect(window.getByLabel('主控 Agent')).toBeEnabled()
  await expect(window.getByRole('button', { name: '保存草稿' })).toBeVisible()
  await expect(window.getByRole('button', { name: /^发布 v1/ })).toBeVisible()

  // 回到列表：三个内置模板 + 一个副本；副本没有「内置」标记。
  await window.getByRole('button', { name: '返回团队列表' }).click()
  await expect(rows).toHaveCount(4)
  await expect(rows.filter({ hasText: '内置' })).toHaveCount(3)
  const copy = rows.filter({ hasText: '代码审查小组 副本' })
  await expect(copy).toHaveCount(1)
  await expect(copy).toContainText('草稿')
})
