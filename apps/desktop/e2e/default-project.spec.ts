/**
 * 默认项目：首次启动没有任何项目时，应用在数据目录中创建默认项目，侧栏直接可用，
 * 不需要先选择文件夹就能发送第一条消息。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { expectMessages, runStatus, sendPrompt } from './session.js'

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
}

test('首次启动自动创建默认项目并可直接对话', async ({ launch, userData }) => {
  const reply = 'reply from default project'
  const mock = await startMockModel({ reply })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })

    await expect(window.getByRole('region', { name: '工作空间' })).toContainText('默认项目')
    await expect(
      window
        .getByRole('group', { name: '当前工作区' })
        .getByRole('button', { name: '工作空间：默认项目' }),
    ).toBeVisible()
    expect(existsSync(path.join(userData, 'default-project'))).toBe(true)

    await configure(window, mock.baseUrl)
    await window.reload()
    await sendPrompt(window, '默认项目里直接开始')
    await expectMessages(window, [
      ['你', '默认项目里直接开始'],
      ['助手', reply],
    ])
    await expect(runStatus(window)).toHaveText('空闲')
  } finally {
    await mock.close()
  }
})
