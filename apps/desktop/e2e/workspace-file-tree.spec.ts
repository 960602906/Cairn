/**
 * 工作空间菜单与文件树（目录功能同步）：置顶、配置、归档、在文件树浏览、
 * 新建/重命名/删除文件，以及移除工作空间。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'
import { createSession, projectDir } from './session.js'

test('工作空间菜单与文件树的新增、重命名、删除和移除', async ({ launch, userData }) => {
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  const dir = projectDir(userData)
  writeFileSync(path.join(dir, 'notes.txt'), 'notes\n')

  await createSession(window, dir, '目录功能')
  await window.reload()
  await window.waitForLoadState('domcontentloaded')

  const workspaces = window.getByRole('region', { name: '工作空间' })
  await expect(workspaces).toContainText('project')
  const row = workspaces.locator('li').filter({ hasText: 'project' })

  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await window.getByRole('menuitem', { name: '置顶工作空间' }).click()
  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await expect(window.getByRole('menuitem', { name: '取消置顶' })).toBeVisible()
  await window.getByRole('menuitem', { name: '取消置顶' }).click()

  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await window.getByRole('menuitem', { name: '归档' }).click()
  await expect(row).toContainText('已归档')
  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await window.getByRole('menuitem', { name: '取消归档' }).click()

  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await window.getByRole('menuitem', { name: '配置' }).click()
  await expect(window.getByRole('heading', { name: '项目' })).toBeVisible()
  await window.getByRole('button', { name: /返回/ }).click()

  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await window.getByRole('menuitem', { name: '在文件树浏览' }).click()
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'project' })).toBeVisible()
  await expect(dialog.getByText('notes.txt')).toBeVisible()

  await dialog.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await window.getByLabel('名称').last().fill('folder')
  await window.getByRole('button', { name: '确定' }).last().click()
  await expect(dialog.getByText('folder')).toBeVisible()

  await dialog.getByRole('button', { name: '刷新文件树' }).click()
  await expect(dialog.getByText('notes.txt')).toBeVisible()
  await dialog.getByRole('button', { name: '显示隐藏文件' }).click()
  await expect(dialog.getByRole('button', { name: '隐藏隐藏文件' })).toBeVisible()
  await dialog.getByRole('button', { name: '隐藏隐藏文件' }).click()

  await dialog.getByRole('button', { name: '新建文件', exact: true }).click()
  await window.getByLabel('名称').last().fill('created.txt')
  await window.getByRole('button', { name: '确定' }).last().click()
  await expect(dialog.getByText('created.txt')).toBeVisible()

  const created = dialog.getByText('created.txt').locator('..')
  await created.getByRole('button', { name: '文件操作' }).click()
  await window.getByRole('menuitem', { name: '重命名' }).click()
  await window.getByLabel('名称').last().fill('renamed.txt')
  await window.getByRole('button', { name: '确定' }).last().click()
  await expect(dialog.getByText('renamed.txt')).toBeVisible()

  const renamed = dialog.getByText('renamed.txt').locator('..')
  await renamed.getByRole('button', { name: '文件操作' }).click()
  await window.getByRole('menuitem', { name: '删除' }).click()
  await window.getByRole('button', { name: '删除' }).last().click()
  await expect(dialog.getByText('renamed.txt')).toHaveCount(0)

  await dialog.getByRole('button', { name: '关闭文件树' }).click()
  await row.hover()
  await row.getByRole('button', { name: '工作空间操作' }).click()
  await window.getByRole('menuitem', { name: '移除工作空间' }).click()
  await window.getByRole('dialog').getByRole('button', { name: '移除' }).click()
  await expect(workspaces).not.toContainText('project')
})
