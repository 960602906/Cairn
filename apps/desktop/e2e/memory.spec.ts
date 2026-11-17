/**
 * 记忆（M7-05 验收，ADR-0019）：提议 → 确认 → 下一轮请求带上记忆 → 删除后不再出现；
 * 另一个项目的会话看不到这条记忆。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import {
  chatRequests,
  configureProvider,
  createSession,
  openSession,
  projectDir,
  runStatus,
  sendPrompt,
} from './session.js'

const CONTENT = '提交信息用中文'
const REPLY = '知道了'

/**
 * 最后一次对话请求的系统提示词（排除标题、要点、摘要等辅助请求）。
 * 记忆只影响系统提示词；对话历史里的工具参数在删除后仍会保留，不能用来判断。
 */
function lastSystemPrompt(requests: readonly { readonly messages: unknown }[]): string {
  const messages = chatRequests(requests).at(-1)?.messages
  if (!Array.isArray(messages)) return ''
  const system = (messages as readonly { role?: string; content?: unknown }[]).find(
    (message) => message.role === 'system',
  )
  return typeof system?.content === 'string'
    ? system.content
    : JSON.stringify(system?.content ?? '')
}

test('记忆：提议 → 确认 → 注入 → 删除，且不跨项目', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCallsByPrompt: {
      记住这个约定: [{ name: 'remember', arguments: { scope: 'project', content: CONTENT } }],
    },
  })
  try {
    const { window } = await launch()
    await configureProvider(window, mock.baseUrl, 'sk-e2e-memory')
    await createSession(window, projectDir(userData), '记忆验收')

    // 1. 模型调用 remember，界面浮出提议卡片；确认后卡片消失。
    await sendPrompt(window, '记住这个约定')
    await expect(runStatus(window)).toHaveText('空闲')
    const proposal = window.getByRole('article', { name: '把这条记下来？' })
    await expect(proposal).toBeVisible()
    await expect(proposal).toContainText(CONTENT)
    await proposal.getByRole('button', { name: '记住' }).click()
    await expect(proposal).toHaveCount(0)

    // 2. 下一轮的模型请求带上 # Memory 段与这条内容。
    await sendPrompt(window, '现在开始新的一轮')
    await expect(runStatus(window)).toHaveText('空闲')
    await expect.poll(() => lastSystemPrompt(mock.requests)).toContain(CONTENT)
    expect(lastSystemPrompt(mock.requests)).toContain('# Memory')

    // 3. 另一个项目里的会话看不到它。
    const otherProject = path.join(userData, 'project-b')
    mkdirSync(otherProject, { recursive: true })
    await createSession(window, otherProject, '另一个项目')
    await sendPrompt(window, '这个项目里有什么约定')
    await expect(runStatus(window)).toHaveText('空闲')
    expect(lastSystemPrompt(mock.requests)).not.toContain(CONTENT)
    expect(lastSystemPrompt(mock.requests)).not.toContain('# Memory')

    // 4. 在设置页删除；回到原会话，之后的请求不再包含它。
    await openSession(window, '记忆验收')
    await window.getByRole('button', { name: /^设置/ }).click()
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: /^记忆/ })
      .click()
    const entry = window.getByRole('article', { name: CONTENT })
    await expect(entry).toBeVisible()
    await entry.getByRole('button', { name: '删除' }).click()
    await window.getByRole('dialog').getByRole('button', { name: '删除' }).click()
    await expect(window.getByRole('article', { name: CONTENT })).toHaveCount(0)
    await window.getByRole('button', { name: /返回对话/ }).click()

    await sendPrompt(window, '删除之后再来一轮')
    await expect(runStatus(window)).toHaveText('空闲')
    expect(lastSystemPrompt(mock.requests)).not.toContain(CONTENT)
    expect(lastSystemPrompt(mock.requests)).not.toContain('# Memory')
  } finally {
    await mock.close()
  }
})
