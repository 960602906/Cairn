/**
 * 上下文压缩（M3-03）：小上下文窗口里连续三轮长对话后，第三次调用模型前总结更早的一轮。
 * 原始消息仍在界面上，分隔线可以展开摘要，会话还能继续。
 */
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'still going'
const SUMMARY = 'goals remain'

test('小窗口连续多轮后压缩，会话仍能继续', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY, summary: SUMMARY })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    const settings = await window.evaluate(
      async ({ baseUrl }) => {
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
                  contextWindow: 4_000,
                  maxOutputTokens: 200,
                  supportsTools: true,
                  supportsParallelToolCalls: false,
                  supportsReasoning: false,
                },
              ],
            },
          ],
          defaultModel: { providerId: 'local', modelId: 'e2e-model' },
        })
      },
      { baseUrl: mock.baseUrl },
    )
    expect(settings).toMatchObject({ ok: true })

    await createSession(window, projectDir(userData), '压缩')
    const long = 'please remember this goal. '.repeat(400)
    await sendPrompt(window, `${long}one`)
    await expect(runStatus(window)).toHaveText('空闲')
    await sendPrompt(window, `${long}two`)
    await expect(runStatus(window)).toHaveText('空闲')
    await sendPrompt(window, `${long}three`)
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })

    const textOf = (messages: unknown) => JSON.stringify(messages)
    const summaryRequest = mock.requests.find((request) =>
      textOf(request.messages).includes('You summarize an earlier part of a coding session'),
    )
    expect(summaryRequest).toBeTruthy()
    const chats = chatRequests(mock.requests)
    expect(textOf(chats.at(-1)?.messages)).toContain('Summary of the earlier conversation')
    expect(textOf(chats.at(-1)?.messages)).toContain(SUMMARY)

    const divider = window.getByRole('button', { name: /较早的对话已压缩/ })
    await expect(divider).toBeVisible()
    await expect(window.getByText(REPLY).last()).toBeVisible()
    await divider.click()
    await expect(window.getByText(SUMMARY)).toBeVisible()
  } finally {
    await mock.close()
  }
})
