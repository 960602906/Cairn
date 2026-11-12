/**
 * 上下文用量明细（M4-05）：一轮真实对话后点击输入框圆环，验证最近报告用量与分类占比，
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

test('点击输入框圆环查看上下文用量与分类占比', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '检查器')
    await sendPrompt(window, '你好')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    const ring = window.getByRole('button', { name: /上下文已用|查看上下文用量/ })
    await ring.click()

    const popover = window.getByRole('dialog', { name: '上下文用量' })
    await expect(popover).toBeVisible()
    await expect(popover.getByText('最近报告的占用')).toBeVisible()
    await expect(popover.getByText('最近调用前的估算')).toBeVisible()
    await expect(popover.getByRole('list', { name: '上下文 token 明细' })).toBeVisible()
    await expect(popover.getByText('系统提示词')).toBeVisible()
    await expect(popover.getByText('工具定义')).toBeVisible()

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await setTheme(window, 'light')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'inspector-light.png') })
    await setTheme(window, 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'inspector-dark.png') })
    await setTheme(window, 'light')

    // 点外面关闭浮层。
    await window.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  } finally {
    await mock.close()
  }
})
