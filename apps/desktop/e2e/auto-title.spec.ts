/**
 * 自动标题（M3-01）：新会话没有标题时，第一轮结束后用配置的模型生成标题。
 * mock 看到标题请求的系统提示时回「整理日志」，对话请求仍回固定回复。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply from configured provider'

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

async function configure(window: Page, baseUrl: string) {
  return window.evaluate(
    async ({ baseUrl, capabilities }) => {
      const cairn = (
        globalThis as unknown as {
          cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      await cairn.ready()
      return cairn.request('settings.update', {
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
}

test('新会话第一轮结束后自动得到标题', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY, title: '整理日志' })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    await configure(window, mock.baseUrl)

    await window.getByRole('button', { name: '新对话' }).click()
    await window.getByLabel('项目目录').fill(projectDir(userData))
    await window.getByRole('button', { name: '创建' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '未命名会话' })).toBeVisible()

    await sendPrompt(window, '帮我整理今天的日志')
    await expectMessages(window, [
      ['你', '帮我整理今天的日志'],
      ['助手', REPLY],
    ])
    await expect(runStatus(window)).toHaveText('空闲')
    await expect(window.getByRole('heading', { level: 2, name: '整理日志' })).toBeVisible()
    await expect(
      window.getByRole('navigation').getByRole('button', { name: '整理日志' }),
    ).toBeVisible()

    const titled = mock.requests.filter((request) =>
      JSON.stringify(request.messages).includes('You name a conversation.'),
    )
    expect(titled).toHaveLength(1)
    expect(mock.requests.filter((request) => request.model === 'e2e-model').length).toBeGreaterThan(
      1,
    )
  } finally {
    await mock.close()
  }
})
