/**
 * 更新设置与状态界面（M5-07）：用本地静态源走真实的检查、下载与重启确认；
 * 有任务运行时重启被阻止；检查失败后可以重试。浅色/深色截图输出到 .cache/cairn-visual-check/update。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { UpdateStatus } from '@cairn/protocol'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt } from './session.js'
import { freeLoopbackPort, startUpdateSource, useDevUpdateConfig } from './update-source.js'

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

async function openUpdateSettings(window: Page): Promise<void> {
  // 用左栏的“设置”按钮而不是 Ctrl+,：冷启动时 React 的快捷键监听可能还没挂上，
  // 键盘事件会丢失（CI 上已复现）。点击按钮会等待元素出现，天然避开这个竞态。
  await window.getByRole('button', { name: '设置', exact: true }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^更新/ }).click()
  await expect(window.getByRole('heading', { name: '更新', level: 2 })).toBeVisible()
  await expect(window.getByText('v0.1.0')).toBeVisible()
}

/** 通过设置页切换配色，确保界面真正应用（直接改主进程设置不会刷新 store）。 */
async function setTheme(window: Page, label: string, id: string): Promise<void> {
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^通用与外观/ }).click()
  await window
    .getByRole('radiogroup', { name: '主题' })
    .getByRole('radio', { name: new RegExp(`^${label}`) })
    .click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', id)
  await nav.getByRole('button', { name: /^更新/ }).click()
}

test.skip(process.platform !== 'win32', '自动更新只在 Windows 启用')

test('设置页完成检查、下载，并显示重启确认', async ({ launch }) => {
  test.setTimeout(180_000)
  const source = await startUpdateSource()
  const removeDevConfig = useDevUpdateConfig(source.url)
  try {
    const { window } = await launch({
      env: { CAIRN_UPDATE_URL: source.url, CAIRN_UPDATE_ALLOW_DEV: '1' },
      args: ['--ignore-certificate-errors'],
    })
    await openUpdateSettings(window)

    await window.getByRole('button', { name: '检查更新' }).click()
    await expect(window.getByText('新版本 0.1.1 可以下载。')).toBeVisible({ timeout: 30_000 })

    await window.getByRole('button', { name: '下载更新' }).click()
    await expect(window.getByText('0.1.1 已下载并通过校验，可以重启安装。')).toBeVisible({
      timeout: 90_000,
    })
    await expect(window.getByText(/unsigned beta/)).toBeVisible()
    await expect(window.getByRole('button', { name: '重启安装' })).toBeEnabled()

    await setTheme(window, '浅色', 'light')
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-settings-light.png') })

    await window.getByRole('button', { name: '重启安装' }).click()
    const dialog = window.getByRole('dialog')
    await expect(dialog.getByText('安装 0.1.1 并重启？')).toBeVisible()
    await expect(dialog.getByText(/这个版本没有可验证的发布者签名/)).toBeVisible()
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-restart-dialog-light.png') })
    await dialog.getByRole('button', { name: '稍后' }).click()
    await expect(dialog).toHaveCount(0)

    await setTheme(window, '深色', 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS, 'update-settings-dark.png') })
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
    await openUpdateSettings(window)
    await expect(window.getByText('0.1.1 已下载并通过校验，可以重启安装。')).toBeVisible()
    await expect(window.getByText('还有任务在运行；完成或停止后再重启安装。')).toBeVisible()
    const restart = window.getByRole('button', { name: '重启安装' })
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
    await openUpdateSettings(window)
    await window.getByRole('button', { name: '检查更新' }).click()
    await expect(window.getByText('无法连接更新源，请检查网络或代理')).toBeVisible({
      timeout: 90_000,
    })
    await window.getByText('技术细节').click()
    await expect(window.getByText(/update\.(network|check_failed)/)).toBeVisible()

    source = await startUpdateSource({ port })
    await window.getByRole('button', { name: '重试' }).click()
    await expect(window.getByText('新版本 0.1.1 可以下载。')).toBeVisible({ timeout: 60_000 })
  } finally {
    removeDevConfig()
    await source?.close()
  }
})
