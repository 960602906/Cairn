/**
 * 内置 Agent（M3-12 打磨）：设置 → Agents 里随应用提供四个内置 Agent。
 * 打开后表单只读、版本历史不能恢复；可以拆成「复制为新 Agent」，副本能编辑、发布、
 * 归档，并在「已归档」里找到、取消归档后继续编辑。
 */
import { expect, test } from './app.js'

test('内置 Agent 只读，复制后可编辑、发布、归档与恢复', async ({ launch }) => {
  const { window } = await launch()

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^Agents/ }).click()
  await expect(window.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible()

  const list = window.getByRole('list', { name: 'Agents' })
  const rows = list.getByRole('listitem')
  await expect(rows).toHaveCount(4)
  await expect(rows.filter({ hasText: '内置' })).toHaveCount(4)

  // 打开内置编程助手：整块只读，但保留试运行与复制。
  await list.getByRole('button', { name: /编程助手/ }).click()
  await expect(window.getByRole('heading', { name: '编程助手', level: 2 })).toBeVisible()
  await expect(window.getByText(/内置 Agent 只读/)).toBeVisible()
  await expect(window.getByText('内置', { exact: true })).toBeVisible()
  await expect(window.getByLabel('中文名称')).toBeDisabled()
  await expect(window.getByRole('button', { name: '试运行' })).toBeEnabled()
  await expect(window.getByRole('button', { name: '复制为新 Agent' })).toBeVisible()
  await expect(window.getByRole('button', { name: '保存草稿' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: /^发布/ })).toHaveCount(0)
  await expect(window.getByRole('button', { name: '更多操作' })).toHaveCount(0)

  // 版本历史可以查看与对比，但不能把旧版本恢复为草稿。
  await window.getByRole('button', { name: '版本历史' }).click()
  await expect(window.getByRole('button', { name: '对比' })).toHaveCount(2)
  await expect(window.getByRole('button', { name: '恢复为草稿' })).toHaveCount(0)

  // 复制为新 Agent：切到可编辑的副本。
  await window.getByRole('button', { name: '复制为新 Agent' }).click()
  await expect(window.getByRole('heading', { name: '编程助手 副本', level: 2 })).toBeVisible()
  await expect(window.getByText(/内置 Agent 只读/)).toHaveCount(0)
  await expect(window.getByText('内置', { exact: true })).toHaveCount(0)
  await expect(window.getByLabel('中文名称')).toBeEnabled()
  await expect(window.getByRole('button', { name: '保存草稿' })).toBeVisible()
  await expect(window.getByRole('button', { name: /^发布 v1/ })).toBeVisible()

  // 发布副本，让版本历史里有可恢复的版本。
  await window.getByRole('button', { name: '发布 v1' }).click()
  const publishDialog = window.getByRole('dialog')
  await expect(publishDialog.getByRole('heading', { name: '发布这个 Agent？' })).toBeVisible()
  await publishDialog.getByRole('button', { name: '发布', exact: true }).click()
  await expect(window.getByText('已发布', { exact: true })).toBeVisible()

  // 归档副本：确认后回到列表。
  await window.getByRole('button', { name: '更多操作' }).click()
  await window.getByRole('menuitem', { name: '归档' }).click()
  const archiveDialog = window.getByRole('dialog')
  await expect(archiveDialog.getByRole('heading', { name: '归档这个 Agent？' })).toBeVisible()
  await archiveDialog.getByRole('button', { name: '归档', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible()

  // 在「已归档」里找到并打开副本：标出已归档状态，表单只读。
  const filters = window.getByRole('radiogroup', { name: '筛选' })
  await filters.getByRole('radio', { name: '已归档' }).click()
  await expect(rows).toHaveCount(1)
  const archivedRow = rows.filter({ hasText: '编程助手 副本' })
  await expect(archivedRow).toHaveCount(1)
  await archivedRow.getByRole('button').click()
  await expect(window.getByRole('heading', { name: '编程助手 副本', level: 2 })).toBeVisible()
  await expect(window.getByText('已归档', { exact: true })).toBeVisible()
  await expect(window.getByText(/已归档的 Agent 只读/)).toBeVisible()
  await expect(window.getByLabel('中文名称')).toBeDisabled()
  await expect(window.getByRole('button', { name: '取消归档' })).toBeVisible()
  await expect(window.getByRole('button', { name: '保存草稿' })).toHaveCount(0)

  // 已发布的副本在版本历史里也不能恢复。
  await window.getByRole('button', { name: '版本历史' }).click()
  await expect(window.getByRole('button', { name: '对比' })).toHaveCount(2)
  await expect(window.getByRole('button', { name: '恢复为草稿' })).toHaveCount(0)

  // 取消归档：恢复可编辑与保存入口，回到已发布状态。
  await window.getByRole('button', { name: '取消归档' }).click()
  await expect(window.getByText(/已归档的 Agent 只读/)).toHaveCount(0)
  await window.getByRole('button', { name: /^基本信息/ }).click()
  await expect(window.getByLabel('中文名称')).toBeEnabled()
  await expect(window.getByRole('button', { name: '保存草稿' })).toBeVisible()
  await expect(window.getByText('已发布', { exact: true })).toBeVisible()
})
