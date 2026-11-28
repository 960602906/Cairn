/**
 * macOS / Linux 的只检查更新（ADR-0036 修订）：发现新版本时只给出下载页入口，
 * 不在本机下载或安装。Windows 的原地更新由 update.spec.ts 与 update-ui.spec.ts 覆盖。
 */
import type { Page } from '@playwright/test'
import type { UpdateStatus } from '@cairn/protocol'
import { expect, test } from './app.js'
import { startUpdateSource, useDevUpdateConfig } from './update-source.js'

async function request<T>(window: Page, method: string, params: object): Promise<T> {
  const reply = (await window.evaluate(
    async ([m, p]) => {
      const cairn = (
        globalThis as unknown as { cairn: { request(m: string, p: object): Promise<unknown> } }
      ).cairn
      return cairn.request(m as string, p as object)
    },
    [method, params] as const,
  )) as { ok: boolean; result?: unknown; error?: unknown }
  if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result as T
}

test.skip(process.platform !== 'darwin', 'Windows 使用原地下载与安装；Linux 走同一检查路径')

test('只检查新版本并给出下载页入口', async ({ launch }) => {
  test.setTimeout(120_000)
  const source = await startUpdateSource()
  const removeDevConfig = useDevUpdateConfig(source.url)
  try {
    const { window } = await launch({
      env: { CAIRN_UPDATE_URL: source.url, CAIRN_UPDATE_ALLOW_DEV: '1' },
      args: ['--ignore-certificate-errors'],
    })
    await expect(window.getByRole('button', { name: '设置', exact: true })).toBeVisible()

    const status = await request<UpdateStatus>(window, 'update.check', { force: true })
    expect(status).toMatchObject({
      phase: 'available',
      availableVersion: source.version,
      installable: false,
      releaseUrl: source.url,
    })

    const link = window.getByRole('link', { name: `有新版本 ${source.version}，打开下载页面` })
    await expect(link).toBeVisible()
    expect(await link.getAttribute('href')).toBe(source.url)
    expect(await link.getAttribute('target')).toBe('_blank')
  } finally {
    removeDevConfig()
    await source.close()
  }
})
