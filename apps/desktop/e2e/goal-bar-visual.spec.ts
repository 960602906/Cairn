/**
 * 目标条 Cursor 化后的视觉截图：活动 / 暂停两态，写入 .cache 供人工核对。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt } from './session.js'
import { resizeWindow } from './window-size.js'

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../.cache/cairn-visual-check/goal-bar')
mkdirSync(ARTIFACTS, { recursive: true })

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

test('目标条：活动与暂停态截图', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '还在做。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"not_met","reason":"还没做完"}',
    },
  })
  try {
    const app = await launch()
    const { window } = app
    await resizeWindow(app.app, window, { width: 1100, height: 800 })
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
          permissionMode: 'full-access',
        })
      },
      { baseUrl: mock.baseUrl, capabilities },
    )
    await window.reload()

    const sessionId = await createSession(window, projectDir(userData), '目标条截图')
    await sendPrompt(window, '/goal 把测试全部跑通')

    const bar = window.locator('[data-goal]').first()
    await expect(bar).toBeVisible({ timeout: 20_000 })
    await expect(window.getByRole('button', { name: '暂停目标' })).toBeVisible()
    await bar.screenshot({ path: path.join(ARTIFACTS, 'goal-bar-active.png') })
    await window.screenshot({ path: path.join(ARTIFACTS, 'goal-bar-active-composer.png') })

    await window.getByRole('button', { name: '暂停目标' }).click()
    await expect(window.getByRole('button', { name: '继续目标' })).toBeVisible()
    await expect(window.getByRole('button', { name: '继续目标' })).toBeEnabled({ timeout: 30_000 })
    await expect(bar).toContainText('已暂停')
    await expect(window.getByRole('button', { name: '改条件' })).toBeVisible()
    await expect(window.getByRole('button', { name: '删除目标' })).toBeVisible()
    await bar.screenshot({ path: path.join(ARTIFACTS, 'goal-bar-paused.png') })
    await window.screenshot({ path: path.join(ARTIFACTS, 'goal-bar-paused-composer.png') })
    void sessionId
  } finally {
    await mock.close()
  }
})
