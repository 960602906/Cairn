/**
 * 活动中心（M4-07）：两个会话各有一个待审批 → 侧栏角标为 2 → 活动页就地允许一个 →
 * 角标变 1 → 从活动页跳转到另一个会话。另存浅色 / 深色截图。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt } from './session.js'

const REPLY = 'activity reply'
const ARTIFACTS_DIR =
  process.platform === 'win32' ? 'C:\\opt\\cursor\\artifacts' : '/opt/cursor/artifacts'

async function configureModel(window: Page, baseUrl: string) {
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
  }, baseUrl)
  await window.reload()
}

async function setTheme(window: Page, theme: 'light' | 'dark') {
  await window.evaluate((value) => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { setAttribute(name: string, value: string): void } }
      }
    ).document.documentElement
    root.setAttribute('data-theme', value)
  }, theme)
}

test('两个会话的审批聚合到活动中心，就地处理并跳转', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCallsByPrompt: {
      审批一: [{ name: 'run_command', arguments: { command: 'echo activity-one' } }],
      审批二: [{ name: 'run_command', arguments: { command: 'echo activity-two' } }],
    },
  })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)

    await createSession(window, projectDir(userData), '活动一')
    await sendPrompt(window, '审批一')
    await expect(window.getByRole('article', { name: '需要审批：run_command' })).toBeVisible()

    await createSession(window, projectDir(userData), '活动二')
    await sendPrompt(window, '审批二')
    await expect(window.getByRole('article', { name: '需要审批：run_command' })).toBeVisible()

    await expect(window.getByRole('button', { name: '活动，2 个待审批' })).toBeVisible()
    await window.getByRole('button', { name: '活动，2 个待审批' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '活动', exact: true })).toBeVisible()
    await expect(window.getByText('待审批 2 · 运行中 0 · 最近完成 0')).toBeVisible()

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await setTheme(window, 'light')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'activity-light.png') })
    await setTheme(window, 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'activity-dark.png') })
    await setTheme(window, 'light')

    const first = window.getByRole('article', { name: '活动一 · run_command 的审批' })
    await expect(first).toBeVisible()
    await first.getByRole('button', { name: '允许一次' }).click()
    await expect(first).toHaveCount(0)
    await expect(window.getByRole('button', { name: '活动，1 个待审批' })).toBeVisible()

    const second = window.getByRole('article', { name: '活动二 · run_command 的审批' })
    await expect(second).toBeVisible()
    await second.getByRole('button', { name: '查看' }).click()
    await expect(
      window.getByRole('heading', { level: 2, name: '活动二', exact: true }),
    ).toBeVisible()
    await expect(window.getByRole('article', { name: '需要审批：run_command' })).toBeVisible()

    await window
      .getByRole('article', { name: '需要审批：run_command' })
      .getByRole('button', { name: '运行一次' })
      .click()
    await expect(window.getByText(REPLY.trim())).toBeVisible()
  } finally {
    await mock.close()
  }
})
