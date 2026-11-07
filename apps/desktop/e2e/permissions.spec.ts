/**
 * 设置页“权限与审批”（M2-11）：为项目手动添加一条允许规则后，模型（本地 mock 端点）请求执行的命令不再需要
 * 审批；规则显示在列表中，可以删除。切换权限模式与输入框下方的切换是同一个设置。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'ran without approval'
const COMMAND = 'echo allowed-by-rule'

async function configureProvider(window: Page, baseUrl: string) {
  await window.evaluate(async (url) => {
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
}

test('权限与审批：项目规则放行命令，规则可以删除', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCall: { name: 'run_command', arguments: { command: COMMAND } },
  })
  try {
    const { window } = await launch()
    await configureProvider(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '规则')

    await window.getByRole('button', { name: /^设置/ }).click()
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '权限与审批' })
      .click()
    const modes = window.getByRole('radiogroup', { name: '权限模式' })
    await expect(modes.getByRole('radio', { name: /^询问/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(window.getByText(/还没有规则/)).toBeVisible()

    await window.getByRole('button', { name: '添加规则' }).click()
    const form = window.getByRole('region', { name: '添加规则' })
    await form.getByLabel('命令').fill(COMMAND)
    await form.getByLabel('范围').selectOption({ label: '项目：project' })
    await form.getByRole('button', { name: '添加', exact: true }).click()
    const rules = window.getByRole('list', { name: '权限规则' })
    await expect(rules.getByRole('listitem')).toHaveText([
      `允许run_command: ${COMMAND}手动添加 · project`,
    ])

    await window.keyboard.press('Escape')
    await sendPrompt(window, '运行命令')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    await expect(window.getByRole('article', { name: /^需要审批/ })).toHaveCount(0)
    expect(mock.requests).toHaveLength(2)
    expect(JSON.stringify(mock.requests[1]?.messages)).toContain('allowed-by-rule')

    // 再次打开时规则仍在；删除后列表为空
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '权限与审批' })
      .click()
    await expect(rules.getByRole('listitem')).toHaveCount(1)
    await window.getByRole('button', { name: `删除规则：run_command: ${COMMAND}` }).click()
    await expect(window.getByText(/还没有规则/)).toBeVisible()
  } finally {
    await mock.close()
  }
})
