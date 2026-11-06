/**
 * 提供方配置驱动的对话（M1-04a、M1-04b）：经 `settings.update` 配置一个指向本地 mock 端点的提供方并设为
 * 默认模型，新建会话后宿主按配置使用 pi 适配器（不依赖 `CAIRN_RUNTIME` 等开发用环境变量）。
 * 提供方不需要 Key（自定义的本地兼容服务），Linux CI 没有系统加密也能运行。
 */
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply from configured provider'

test('按提供方配置新建会话：回复来自配置的模型端点', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    const settings = await window.evaluate(async (baseUrl) => {
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
    }, mock.baseUrl)
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
