/**
 * 关于页（M5-01）：`app.info` 与设置页展示同一份版本、通道与构建信息。
 */
import { expect, test } from './app.js'

test('关于页显示版本、通道与构建信息', async ({ launch }) => {
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

  const response = (await window.evaluate(async () => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    return cairn.request('app.info', {})
  })) as {
    ok: boolean
    result: {
      version: string
      channel: string
      appId: string
      packaged: boolean
      databaseSchemaVersion: number
    }
  }
  expect(response.ok).toBe(true)
  expect(response.result).toMatchObject({
    version: '0.1.0',
    channel: 'beta',
    appId: 'com.cairn.desktop',
    packaged: false,
  })
  expect(response.result.databaseSchemaVersion).toBeGreaterThan(0)

  await window.getByRole('button', { name: /^设置/ }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^关于 Cairn/ }).click()
  await expect(window.getByRole('heading', { name: '关于 Cairn', level: 2 })).toBeVisible()
  await expect(window.getByText('0.1.0')).toBeVisible()
  await expect(window.getByText('Beta 测试版')).toBeVisible()
  await expect(window.getByText('开发模式')).toBeVisible()
})
