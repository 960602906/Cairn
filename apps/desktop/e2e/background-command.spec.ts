/**
 * 后台命令（M4-14）：启动持续输出的命令 → 活动中心看到后台任务与实时输出 → 停止。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt } from './session.js'

async function configureModel(window: Page, baseUrl: string) {
  await window.evaluate(async (url) => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    await cairn.request('settings.update', {
      permissionMode: 'auto',
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

test('启动后台命令、查看输出并停止', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: '后台命令已启动',
    toolCallsByPrompt: {
      启动后台任务: [
        {
          name: 'start_command',
          arguments: {
            command: 'node -e "setInterval(() => console.log(\'bg-tick\'), 200)"',
          },
        },
      ],
    },
  })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '后台命令')
    await sendPrompt(window, '启动后台任务')
    await expect(window.getByText('后台命令已启动')).toBeVisible()

    await window.getByRole('button', { name: /活动/ }).click()
    const task = window.getByRole('article', { name: /后台任务：/ })
    await expect(task).toBeVisible()
    await expect(task.getByText('运行中')).toBeVisible()
    await task.getByRole('button', { name: '查看输出' }).click()
    await expect(task.getByText(/bg-tick/)).toBeVisible()
    await task.getByRole('button', { name: '停止' }).click()
    await expect(task.getByText('已停止')).toBeVisible()
  } finally {
    await mock.close()
  }
})
