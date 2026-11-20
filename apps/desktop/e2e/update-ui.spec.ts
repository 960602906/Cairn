/**
 * 左栏头部的更新入口（M5-07）：用本地静态源走真实的检查、下载与重启确认。
 * 发现新版本时头部出现下载按钮，下载时显示进度环，完成后变成「更新」并可确认重启；
 * 有任务运行时不能重启；检查失败后可以重试。截图输出到 .cache/cairn-visual-check/update。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { UpdateStatus } from '@cairn/protocol'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt } from './session.js'
import { freeLoopbackPort, startUpdateSource, useDevUpdateConfig } from './update-source.js'
import { APP_VERSION } from './version.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../.cache/cairn-visual-check/update')
mkdirSync(ARTIFACTS, { recursive: true })

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

/** 通过设置页切换配色，确保界面真正应用（直接改主进程设置不会刷新 store）；Esc 回到对话页。 */
async function setTheme(window: Page, label: string, id: string): Promise<void> {
  // 用左栏的“设置”按钮而不是 Ctrl+,：冷启动时 React 的快捷键监听可能还没挂上。
  await window.getByRole('button', { name: '设置', exact: true }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^通用与外观/ }).click()
  await window
    .getByRole('radiogroup', { name: '主题' })
    .getByRole('radio', { name: new RegExp(`^${label}`) })
    .click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', id)
  await window.keyboard.press('Escape')
  await expect(nav).toHaveCount(0)
}

test.skip(process.platform !== 'win32', '自动更新只在 Windows 启用')

test('头部下载、进度与重启确认', async ({ launch }) => {
  test.setTimeout(180_000)
  const source = await startUpdateSource({ throttleMs: 250 })
  const removeDevConfig = useDevUpdateConfig(source.url)
  try {
    const { window } = await launch({
      env: { CAIRN_UPDATE_URL: source.url, CAIRN_UPDATE_ALLOW_DEV: '1' },
      args: ['--ignore-certificate-errors'],
    })
    await expect(window.getByRole('button', { name: '设置', exact: true })).toBeVisible()

    await request<UpdateStatus>(window, 'update.check', { force: true })
    const download = window.getByRole('button', { name: `下载更新 ${source.version}` })
    await expect(download).toBeVisible()
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-download-light.png') })
    await window.screenshot({
      clip: { x: 0, y: 0, width: 252, height: 48 },
      path: path.join(ARTIFACTS, 'update-download-zoom.png'),
    })
    await download.click()
    await window.mouse.move(900, 400)

    const ring = window.getByRole('progressbar')
    await expect(ring).toBeVisible()
    // 等进度环走出可见的一段再截图。
    await expect
      .poll(async () => Number(await ring.getAttribute('aria-valuenow')))
      .toBeGreaterThan(25)
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-progress-light.png') })
    await window.screenshot({
      clip: { x: 0, y: 0, width: 252, height: 48 },
      path: path.join(ARTIFACTS, 'update-progress-zoom.png'),
    })

    const update = window.getByRole('button', { name: `安装 ${source.version} 并重启` })
    await expect(update).toBeEnabled({ timeout: 90_000 })
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-header-light.png') })
    await window.screenshot({
      clip: { x: 0, y: 0, width: 252, height: 48 },
      path: path.join(ARTIFACTS, 'update-header-ready-zoom.png'),
    })

    await update.click()
    const dialog = window.getByRole('dialog')
    await expect(dialog.getByText(`安装 ${source.version} 并重启？`)).toBeVisible()
    await expect(dialog.getByText(/这个版本没有可验证的发布者签名/)).toBeVisible()
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-restart-dialog-light.png') })
    await dialog.getByRole('button', { name: '稍后' }).click()
    await expect(dialog).toHaveCount(0)

    await setTheme(window, '深色', 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-header-dark.png') })
  } finally {
    removeDevConfig()
    await source.close()
  }
})

test('有任务运行时重启被阻止', async ({ launch, userData }) => {
  test.setTimeout(180_000)
  const source = await startUpdateSource()
  const removeDevConfig = useDevUpdateConfig(source.url)
  const mock = await startMockModel({
    reply: 'done',
    toolCall: { name: 'run_command', arguments: { command: 'echo update-busy' } },
  })
  try {
    const { window } = await launch({
      env: { CAIRN_UPDATE_URL: source.url, CAIRN_UPDATE_ALLOW_DEV: '1' },
      args: ['--ignore-certificate-errors'],
    })
    await window.evaluate(async (url) => {
      const cairn = (
        globalThis as unknown as {
          cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      await cairn.ready()
      await cairn.request('settings.update', {
        providers: [
          {
            id: 'local',
            kind: 'openai',
            displayName: 'Local',
            baseUrl: url,
            models: [
              {
                id: 'e2e-model',
                contextWindow: 32_000,
                maxOutputTokens: 1_000,
                supportsTools: true,
                supportsParallelToolCalls: false,
                supportsReasoning: false,
              },
            ],
          },
        ],
        defaultModel: { providerId: 'local', modelId: 'e2e-model' },
      })
    }, mock.baseUrl)
    await createSession(window, projectDir(userData), '更新')
    await sendPrompt(window, '运行命令')
    await expect(window.getByRole('article', { name: '需要审批：run_command' })).toBeVisible()

    await request<UpdateStatus>(window, 'update.check', { force: true })
    await request<UpdateStatus>(window, 'update.download', {})
    const restart = window.getByRole('button', { name: '有任务在运行，完成后再重启安装' })
    await expect(restart).toBeDisabled()
    await expect(window.getByRole('dialog')).toHaveCount(0)

    await expect(request<UpdateStatus>(window, 'update.install', {})).resolves.toMatchObject({
      phase: 'downloaded',
      blockedReason: 'update.busy',
      error: { code: 'update.busy' },
    })
  } finally {
    removeDevConfig()
    await mock.close()
    await source.close()
  }
})

test('安装重启后展示本次版本的更新内容', async ({ launch }) => {
  test.setTimeout(120_000)
  const { window } = await launch()
  await window.evaluate(async (version) => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    // 模拟更新服务在安装前写入的目标版本；同时跳过首次运行欢迎页。
    await cairn.request('settings.update', {
      onboardingSeen: true,
      updateInstalledVersion: version,
    })
  }, APP_VERSION)

  await window.reload()
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByText(`已更新到 ${APP_VERSION}`)).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: '知道了' }).click()
  await expect(dialog).toHaveCount(0)

  // 标记已被消费；再次启动不再弹窗。
  await window.reload()
  await expect(window.getByRole('dialog')).toHaveCount(0)
})

test('检查失败后可以在同一个更新源重试', async ({ launch }) => {
  test.setTimeout(180_000)
  const port = await freeLoopbackPort()
  const url = `https://127.0.0.1:${port}/`
  const removeDevConfig = useDevUpdateConfig(url)
  let source: Awaited<ReturnType<typeof startUpdateSource>> | undefined
  try {
    const { window } = await launch({
      env: { CAIRN_UPDATE_URL: url, CAIRN_UPDATE_ALLOW_DEV: '1' },
      args: ['--ignore-certificate-errors'],
    })
    await expect(window.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await request<UpdateStatus>(window, 'update.check', { force: true })
    const retry = window.getByRole('button', { name: '重试更新' })
    await expect(retry).toBeVisible({ timeout: 90_000 })

    source = await startUpdateSource({ port })
    await retry.click()
    await expect(window.getByRole('button', { name: `安装 ${source.version} 并重启` })).toBeEnabled(
      {
        timeout: 90_000,
      },
    )
  } finally {
    removeDevConfig()
    await source?.close()
  }
})
