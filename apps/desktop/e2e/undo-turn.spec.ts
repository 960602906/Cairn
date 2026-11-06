/**
 * 工具调用显示与撤销本轮（M1-16b）：模型（本地 mock 端点）调用 `write_file` 新建文件，审批后执行；
 * 消息流中显示工具名、参数摘要与状态。之后“撤销本轮”先列出将恢复的文件，确认后工作区回到本轮开始时，
 * 新建的文件被删除，项目中原有的文件不变。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'file written'

test('消息流显示工具调用，撤销本轮恢复项目文件', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCall: { name: 'write_file', arguments: { path: 'hello.txt', content: 'hi\n' } },
  })
  try {
    const { window } = await launch()
    await window.evaluate(async (url) => {
      const nexus = (
        globalThis as unknown as {
          nexus: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
        }
      ).nexus
      await nexus.ready()
      await nexus.request('settings.update', {
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
    }, mock.baseUrl)

    const dir = projectDir(userData)
    writeFileSync(path.join(dir, 'keep.txt'), 'original\n')
    const created = path.join(dir, 'hello.txt')

    await createSession(window, dir, '写文件')
    await sendPrompt(window, '写一个文件')
    const card = window.getByRole('region', { name: '调用工具：write_file' })
    await expect(card).toContainText('hello.txt')
    await window.getByRole('button', { name: '允许一次' }).click()
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    await expect(card).toContainText('完成')
    expect(readFileSync(created, 'utf8')).toBe('hi\n')

    await window.getByRole('button', { name: '撤销本轮' }).click()
    const dialog = window.getByRole('alertdialog', { name: '撤销本轮' })
    await expect(dialog.getByRole('list', { name: '将恢复的文件' })).toHaveText('删除 hello.txt')
    expect(existsSync(created)).toBe(true)
    await dialog.getByRole('button', { name: '确认撤销' }).click()
    await expect(window.getByText('已撤销本轮，恢复了 1 个文件。')).toBeVisible()
    expect(existsSync(created)).toBe(false)
    expect(readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('original\n')
  } finally {
    await mock.close()
  }
})
