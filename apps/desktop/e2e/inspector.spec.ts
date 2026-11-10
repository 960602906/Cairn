/**
 * 运行检查器（M4-05）：一轮真实对话后打开检查器，验证运行树、上下文、用量与设置，
 * 并保存浅色 / 深色截图。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'inspector reply'
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
              supportsParallelToolCalls: true,
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

test('查看运行树、上下文、用量与设置', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '检查器')
    await sendPrompt(window, '你好')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    const panelToggle = window.getByRole('button', { name: '会话信息', exact: true })
    if ((await panelToggle.getAttribute('aria-expanded')) !== 'true') await panelToggle.click()
    await window.getByRole('tab', { name: '检查器' }).click()
    const panel = window.getByRole('tabpanel', { name: '时间线' })
    await expect(panel.getByRole('list', { name: '运行树' })).toBeVisible()
    await expect(panel.getByText('编程助手')).toBeVisible()
    await expect(panel.getByRole('button', { name: '定位到第 1 轮' })).toBeVisible()
    await panel.getByRole('button', { name: '定位到第 1 轮' }).click()
    const turnId = await window.locator('[data-turn]').first().getAttribute('data-turn')
    expect(turnId).not.toBeNull()
    await expect(window.locator(`[data-turn="${turnId}"]`)).toBeFocused()

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await setTheme(window, 'light')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'inspector-light.png') })
    await setTheme(window, 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'inspector-dark.png') })
    await setTheme(window, 'light')

    await window.getByRole('tab', { name: '上下文' }).click()
    await expect(window.getByText('系统提示词各部分')).toBeVisible()
    await expect(window.getByRole('list', { name: '上下文 token 明细' })).toBeVisible()

    await window.getByRole('tab', { name: '用量' }).click()
    await expect(window.getByText('按 Agent 分组')).toBeVisible()
    await expect(window.getByText('本会话')).toBeVisible()

    await window.getByRole('tab', { name: '设置' }).click()
    await expect(window.getByText('生效的权限规则')).toBeVisible()
    await expect(window.getByText('每轮最多步骤')).toBeVisible()
  } finally {
    await mock.close()
  }
})
