/**
 * 提供方配置驱动的对话（M1-04a、M1-04b）：经 `settings.update` 配置一个指向本地 mock 端点的提供方并设为
 * 默认模型，新建会话后宿主按配置使用 pi 适配器（不依赖 `CAIRN_RUNTIME` 等开发用环境变量）。
 * 提供方不需要 Key（自定义的本地兼容服务），Linux CI 没有系统加密也能运行。
 * M2-04：在输入框中切换模型后，下一轮请求使用新模型。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply from configured provider'

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

/** 经 IPC 配置一个指向 mock 端点、有两个模型的提供方，默认使用第一个。 */
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
            models: [
              { id: 'e2e-model', ...capabilities },
              { id: 'e2e-model-2', displayName: 'Second', ...capabilities },
            ],
          },
        ],
        defaultModel: { providerId: 'local', modelId: 'e2e-model' },
      })
    },
    { baseUrl, capabilities },
  )
}

test('按提供方配置新建会话：回复来自配置的模型端点', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    const settings = await configure(window, mock.baseUrl)
    expect(settings).toMatchObject({
      ok: true,
      result: { defaultModel: { providerId: 'local', modelId: 'e2e-model' } },
    })

    await createSession(window, projectDir(userData), '提供方配置')
    await sendPrompt(window, '你好')
    await expectMessages(window, [
      ['你', '你好'],
      ['助手', REPLY],
    ])
    await expect(runStatus(window)).toHaveText('空闲')
    expect(mock.requests.map((r) => [r.model, r.stream])).toEqual([['e2e-model', true]])
  } finally {
    await mock.close()
  }
})

test('在输入框中切换模型：两轮分别使用两个模型（M2-04）', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    await configure(window, mock.baseUrl)
    // 设置是绕过界面改的，重新加载让界面读到新的提供方
    await window.reload()
    await createSession(window, projectDir(userData), '切换模型')

    await sendPrompt(window, '第一轮')
    await expect(runStatus(window)).toHaveText('空闲')
    await window.getByRole('button', { name: '模型：Local · e2e-model', exact: true }).click()
    await window.getByRole('menuitem', { name: /Second/ }).click()
    await expect(
      window.getByRole('button', { name: '模型：Local · Second', exact: true }),
    ).toBeVisible()

    await sendPrompt(window, '第二轮')
    await expectMessages(window, [
      ['你', '第一轮'],
      ['助手', REPLY],
      ['你', '第二轮'],
      ['助手', REPLY],
    ])
    await expect(runStatus(window)).toHaveText('空闲')
    expect(mock.requests.map((r) => r.model)).toEqual(['e2e-model', 'e2e-model-2'])
  } finally {
    await mock.close()
  }
})
