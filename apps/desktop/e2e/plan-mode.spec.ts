/**
 * 计划模式（M3-05）：mock 模型提出计划，批准后按步骤更新进度，偏离说明出现在卡片上。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt, sessionPanel } from './session.js'

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

async function configure(window: Page, baseUrl: string) {
  await window.evaluate(
    async ({ baseUrl, capabilities }) => {
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
            baseUrl,
            models: [{ id: 'e2e-model', ...capabilities }],
          },
        ],
        defaultModel: { providerId: 'local', modelId: 'e2e-model' },
      })
    },
    { baseUrl, capabilities },
  )
  await window.reload()
}

test('提出计划、批准后更新步骤进度', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: '计划已执行',
    title: '整理计划',
    toolCalls: [
      {
        name: 'propose_plan',
        arguments: {
          goal: '给 sum 加注释',
          files: ['sum.mjs'],
          steps: [{ id: 'note', title: '加上注释' }],
          risks: '',
          verification: '读文件',
          markdown: '1. 加上注释',
        },
      },
      { name: 'update_plan_step', arguments: { stepId: 'note', status: 'in_progress' } },
      {
        name: 'update_plan_step',
        arguments: { stepId: 'note', status: 'done', note: '只加了一行注释' },
      },
    ],
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '计划')
    const toggle = window.getByRole('button', { name: '计划模式' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await sendPrompt(window, '给求和函数加注释')
    const approve = window.getByRole('button', { name: '批准执行' })
    await expect(approve).toBeEnabled({ timeout: 20_000 })
    const summary = window.getByRole('button', { name: '查看完整计划：给 sum 加注释' })
    await expect(summary).toBeVisible()
    await summary.click()
    const details = sessionPanel(window).getByRole('article', { name: '计划' })
    await expect(details).toContainText('给 sum 加注释')
    await window.keyboard.press('Escape')
    await expect(sessionPanel(window)).toBeHidden()
    await approve.click()
    await expect(window.getByText('已完成')).toBeVisible({ timeout: 20_000 })
    await expect(window.getByText('说明：只加了一行注释')).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 20_000 })
  } finally {
    await mock.close()
  }
})
