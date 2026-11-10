/**
 * 默认项目：首次启动没有任何项目时，应用在数据目录中创建默认项目，侧栏直接可用，
 * 不需要先选择文件夹就能发送第一条消息。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './app.js'
import { converse } from './session.js'

test('首次启动自动创建默认项目并可直接对话', async ({ launch, userData }) => {
  const { window } = await launch()

  await expect(window.getByRole('region', { name: '工作空间' })).toContainText('默认项目')
  await expect(
    window
      .getByRole('group', { name: '当前工作区' })
      .getByRole('button', { name: '工作空间：默认项目' }),
  ).toBeVisible()
  expect(existsSync(path.join(userData, 'default-project'))).toBe(true)

  await converse(window, '默认项目里直接开始')
})
