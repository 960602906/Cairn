/**
 * 输入框的 `@` 引用（ADR-0037）：候选来自工作区（遵守 .gitignore），插入后发送，
 * 模型收到文件内容，消息里只显示用户写的文字。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir } from './session.js'

async function configure(window: Page, baseUrl: string) {
  await window.evaluate(async (baseUrl) => {
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

test('@ 引用文件：选择候选、发送后模型收到文件内容', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: '看过了', title: '引用文件' })
  try {
    const project = projectDir(userData)
    mkdirSync(path.join(project, 'src'), { recursive: true })
    mkdirSync(path.join(project, '.git'), { recursive: true })
    writeFileSync(path.join(project, '.gitignore'), 'dist/\n')
    writeFileSync(path.join(project, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b\n')
    mkdirSync(path.join(project, 'dist'), { recursive: true })
    writeFileSync(path.join(project, 'dist', 'sum.mjs'), 'built\n')

    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, project, '引用文件')

    const input = window.getByRole('textbox', { name: '输入消息' })
    await input.click()
    await input.pressSequentially('解释 @sum')
    const list = window.getByRole('listbox', { name: '引用文件' })
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(list.getByRole('option')).toContainText('sum.mjs')
    await expect(list.getByRole('option')).toContainText('src')
    await input.press('Enter')
    await expect(input).toHaveValue('解释 @src/sum.mjs ')
    await expect(list).toBeHidden()
    await input.press('Enter')

    await expect(window.getByText('看过了')).toBeVisible()
    const messages = window.getByRole('list', { name: '消息' })
    await expect(messages).toContainText('解释 @src/sum.mjs')
    await expect(messages).not.toContainText('export const sum')

    // 会话主模型的请求带着文件内容；简报等辅助请求只看用户写的文字。
    const sent = mock.requests
      .map((request) => JSON.stringify(request.messages ?? []))
      .find((body) => body.includes('<file path=\\"src/sum.mjs\\">'))
    expect(sent).toContain('export const sum = (a, b) => a + b')
    expect(sent).not.toContain('built')
  } finally {
    await mock.close()
  }
})
