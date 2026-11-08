/**
 * Agent 试运行（M4-12）：复制编程助手 → 改指令 → 试运行草稿 → 发送消息 →
 * 修改指令后提示配置已变化 → 重新开始 → 新指令进入模型请求。另存浅色 / 深色截图。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, projectDir } from './session.js'

const FIRST_INSTRUCTIONS = 'You are the first trial draft.'
const SECOND_INSTRUCTIONS = 'You are the second trial draft.'
const REPLY = 'trial draft reply'

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

test('试运行草稿、配置变化后重新开始', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    const project = projectDir(userData)

    await window.getByRole('button', { name: '新对话' }).click()
    await window.getByLabel('项目目录').fill(project)
    await window.getByLabel('标题（可选）').fill('试运行项目')
    await window.getByRole('button', { name: '创建' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '试运行项目' })).toBeVisible()

    await window.getByRole('button', { name: '设置' }).click()
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '项目' })
      .click()
    await expect(window.getByRole('heading', { name: '项目' })).toBeVisible()
    await window.getByRole('button', { name: '返回对话' }).click()

    await window.getByRole('button', { name: 'Agents' }).click()
    await window.getByRole('button', { name: '基于编程助手复制' }).click()
    await window.getByRole('button', { name: '指令', exact: true }).click()
    const instructions = window.getByLabel('系统指令')
    await instructions.fill(FIRST_INSTRUCTIONS)

    await window.getByRole('button', { name: '试运行', exact: true }).click()
    const panel = window.getByRole('complementary', { name: '试运行' })
    await expect(panel).toBeVisible()
    await panel.getByLabel('项目').selectOption(project)
    await panel.getByRole('button', { name: '开始试运行' }).click()
    await expect(panel.getByLabel('试运行输入')).toBeVisible()

    await panel.getByLabel('试运行输入').fill('验证第一版')
    await panel.getByRole('button', { name: '发送' }).click()
    await expect(panel.getByText(REPLY)).toBeVisible()

    await setTheme(window, 'light')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'trial-light.png') })
    await setTheme(window, 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'trial-dark.png') })
    await setTheme(window, 'light')

    await instructions.fill(SECOND_INSTRUCTIONS)
    await expect(panel.getByText(/配置已变化/)).toBeVisible()
    await panel.getByRole('button', { name: '重新开始' }).click()
    await expect(panel.getByLabel('试运行输入')).toBeVisible()

    await panel.getByLabel('试运行输入').fill('验证第二版')
    await panel.getByRole('button', { name: '发送' }).click()
    await expect(panel.getByText(REPLY)).toBeVisible()
    await expect
      .poll(() => JSON.stringify(chatRequests(mock.requests).at(-1)?.messages))
      .toContain(SECOND_INSTRUCTIONS)
  } finally {
    await mock.close()
  }
})
