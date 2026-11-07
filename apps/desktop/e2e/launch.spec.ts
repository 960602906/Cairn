/**
 * 测试框架本身（M0-16a）：启动构建产物、使用独立数据目录、重启后沿用同一目录。
 * 完成标准的五个场景见 M0-16b / M0-16c。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'

test('启动应用：界面加载，数据写入独立的数据目录', async ({ launch, userData }) => {
  const { window } = await launch()
  await expect(window.getByRole('heading', { level: 1, name: 'Cairn' })).toBeVisible()
  await expect(window.getByText('还没有会话')).toBeVisible()
  await expect(window.locator('html')).toHaveAttribute('lang', 'zh-CN')
  for (const dir of ['data', 'data/blobs', 'checkpoints', 'logs']) {
    expect(existsSync(path.join(userData, dir)), dir).toBe(true)
  }
  expect(existsSync(path.join(userData, 'data/cairn.db'))).toBe(true)
})

test('重启应用：沿用同一数据目录与设置', async ({ launch }) => {
  const first = await launch({ locale: 'en-US' })
  await expect(first.window.getByText('No sessions yet')).toBeVisible()
  // 语言在设置页中切换（M2-09）
  await first.window.getByRole('button', { name: /^Settings/ }).click()
  await first.window
    .getByRole('radiogroup', { name: 'Language' })
    .getByRole('radio', { name: '简体中文' })
    .click()
  await expect(first.window.getByRole('heading', { name: '通用与外观' })).toBeVisible()
  await first.window.keyboard.press('Escape')
  await expect(first.window.getByText('还没有会话')).toBeVisible()
  await first.close()

  const second = await launch({ locale: 'en-US' })
  await expect(second.window.getByText('还没有会话')).toBeVisible()
})
