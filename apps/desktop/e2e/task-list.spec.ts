/**
 * 待办列表（ADR-0038）：普通轮次里 Agent 创建列表，进度卡在输入框上方显示。
 * 计划来源的列表与兼容别名由 `plan-mode.spec.ts` 覆盖。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

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

test('普通轮次创建待办列表并显示进度卡', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: '已创建待办列表',
    title: '待办',
    toolCalls: [
      {
        name: 'create_task_list',
        arguments: {
          title: '修测试',
          items: [{ title: '读失败用例' }, { title: '改代码' }],
        },
      },
    ],
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '待办')
    await sendPrompt(window, '先列一个待办再开始')
    await expect(window.getByRole('region', { name: '调用工具：create_task_list' })).toBeVisible({
      timeout: 20_000,
    })
    const card = window.getByRole('region', { name: '任务进度' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('修测试')
    await expect(card).toContainText('0 / 2')
    await expect(card).toContainText('读失败用例')
    // 临时列表没有可打开的计划详情。
    await expect(card.getByRole('button', { name: '修测试' })).toHaveCount(0)
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 20_000 })
  } finally {
    await mock.close()
  }
})
