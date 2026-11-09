/**
 * 会话要点（M3-04）：一轮结束后抽屉里能看到要点，用户改过的文字会留下来。
 * mock 看到要点请求的系统提示时回「目标：修复登录」，对话请求仍回固定回复。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { expectMessages, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'reply from configured provider'
const BRIEF = '目标：修复登录'

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

test('抽屉显示会话要点，编辑后的文字不会被自动更新盖掉', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY, brief: BRIEF, title: '整理日志' })
  try {
    const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
    await configure(window, mock.baseUrl)

    await window
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '新对话' })
      .click()
    await window.getByLabel('项目目录').fill(projectDir(userData))
    await window.getByLabel('标题（可选）').fill('要点')
    await window.getByRole('button', { name: '创建' }).click()
    await expect(window.getByRole('heading', { level: 2, name: '要点' })).toBeVisible()

    await sendPrompt(window, '目标是修复登录，不要改 API')
    await expectMessages(window, [
      ['你', '目标是修复登录，不要改 API'],
      ['助手', REPLY],
    ])
    await expect(runStatus(window)).toHaveText('空闲')

    const panelToggle = window.getByRole('button', { name: '会话信息', exact: true })
    if ((await panelToggle.getAttribute('aria-expanded')) === 'false') await panelToggle.click()
    const drawer = window.getByRole('complementary', { name: '会话信息' })
    await drawer.getByRole('tab', { name: '会话要点' }).click()
    await expect(drawer).toContainText(BRIEF)

    await drawer.getByRole('button', { name: '编辑' }).click()
    await drawer.getByRole('textbox', { name: '编辑' }).fill('用户改成：不要动 API')
    await drawer.getByRole('button', { name: '保存' }).click()
    await expect(drawer).toContainText('用户改成：不要动 API')

    await sendPrompt(window, '另外测试用 Vitest')
    await expect(runStatus(window)).toHaveText('空闲')
    await expect
      .poll(
        () =>
          mock.requests.filter((request) =>
            JSON.stringify(request.messages).includes('You keep a session brief.'),
          ).length,
      )
      .toBeGreaterThan(1)
    await expect(drawer).toContainText('用户改成：不要动 API')
    await expect(window.getByRole('list', { name: '消息' })).not.toContainText(BRIEF)
  } finally {
    await mock.close()
  }
})
