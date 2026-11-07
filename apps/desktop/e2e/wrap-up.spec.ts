/**
 * M2-12：搜索会话，以及还没有供应商时引导去设置。
 */
import { expect, test } from './app.js'
import { createSession, projectDir } from './session.js'

test('没有供应商时引导打开模型设置', async ({ launch }) => {
  const { window } = await launch()
  await expect(window.getByText('先添加模型供应商')).toBeVisible()
  await expect(window.getByText(/还没有项目/)).toBeVisible()
  await window.getByRole('button', { name: '打开模型设置' }).click()
  await expect(window.getByRole('heading', { level: 2, name: '模型供应商' })).toBeVisible()
})

test('Ctrl+K 按标题搜索并打开会话', async ({ launch, userData }) => {
  const { window } = await launch()
  const dir = projectDir(userData)
  await createSession(window, dir, '修复登录')
  await createSession(window, dir, '写文档')
  await window.keyboard.press('Control+K')
  const dialog = window.getByRole('dialog', { name: '搜索会话' })
  await dialog.getByRole('combobox').fill('登录')
  await dialog.getByRole('option', { name: /修复登录/ }).click()
  await expect(window.getByRole('heading', { level: 2, name: '修复登录' })).toBeVisible()
  await expect(dialog).toBeHidden()
})
