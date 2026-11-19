/**
 * 消息编辑重发与重新生成的真实模型实测（ADR-0046）。只在本地跑：CI 没有模型凭据。
 *
 * 需要 `DEEPSEEK_API_KEY`（见 `docs/dev/local-testing.md`）与 `CAIRN_REAL_MODEL=1`：
 *
 * ```powershell
 * $env:CAIRN_REAL_MODEL = '1'
 * pnpm e2e rewind-real-model.spec.ts
 * ```
 *
 * 断言三件事：被回退的轮次在界面与重建的宿主历史里都消失（不是只隐藏），编辑后的文本确实
 * 重发给了模型，重新生成复用这一轮的用户输入且不回退更早的对话。
 */
import type { Page } from '@playwright/test'
import { expect, test } from './app.js'
import { contentText, ofType, readEvents } from './database.js'
import { hostTrace, readHostHistories } from './host.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const KEY = process.env['DEEPSEEK_API_KEY']

test.skip(
  KEY === undefined || process.env['CAIRN_REAL_MODEL'] !== '1',
  '真实模型实测需要 DEEPSEEK_API_KEY 与 CAIRN_REAL_MODEL=1（见 docs/dev/local-testing.md）',
)

const FIRST = '请只回复这个数字：1。不要使用任何工具。'
const SECOND = '请只回复这个数字：2。不要使用任何工具。'
const THIRD = '请只回复这个数字：3。不要使用任何工具。'
const EDITED = '请只回复这个数字：4。不要使用任何工具。'

const items = (window: Page) => window.getByRole('list', { name: '消息' }).locator(':scope > li')

const modelEnv = {
  CAIRN_RUNTIME: 'pi',
  CAIRN_MODEL_KIND: 'openai',
  CAIRN_MODEL_BASE_URL: 'https://api.deepseek.com',
  CAIRN_MODEL_ID: 'deepseek-flash',
  CAIRN_MODEL_API_KEY: KEY ?? '',
}

/** 发一条输入，等这一轮完成，返回消息条数。 */
async function sendAndWait(window: Page, text: string) {
  await sendPrompt(window, text)
  await expect(runStatus(window)).toHaveText('空闲', { timeout: 180_000 })
}

test('真实模型：编辑重发会重建历史，重新生成复用这一轮输入', async ({ launch, userData }) => {
  test.setTimeout(300_000)
  const trace = hostTrace(userData)
  const { window, close } = await launch({ env: { ...modelEnv, ...trace.env } })
  const traceCount = () => {
    try {
      return readHostHistories(trace.file).length
    } catch {
      return 0
    }
  }

  await createSession(window, projectDir(userData), '回退实测')

  // 第一轮
  await sendAndWait(window, FIRST)
  await expect(items(window)).toHaveCount(2)
  await expect(items(window).nth(1).locator('p').first()).toContainText('1', {
    timeout: 180_000,
  })

  // 第二、三轮：编辑第二轮时，第三轮应该被一起丢弃
  await sendAndWait(window, SECOND)
  await expect(items(window)).toHaveCount(4)
  await expect(items(window).nth(3).locator('p').first()).toContainText('2', {
    timeout: 180_000,
  })
  await sendAndWait(window, THIRD)
  await expect(items(window)).toHaveCount(6)
  await expect(items(window).nth(5).locator('p').first()).toContainText('3', {
    timeout: 180_000,
  })

  // 编辑第二轮：确认后回退，界面只剩第一轮和编辑后的这一轮
  const beforeEdit = traceCount()
  await items(window).nth(2).getByRole('button', { name: '编辑消息' }).click()
  const editor = items(window).nth(2).getByRole('textbox', { name: '编辑消息' })
  await editor.fill(EDITED)
  await items(window).nth(2).getByRole('button', { name: '保存并重发' }).click()
  await expect(window.getByRole('dialog')).toContainText('这条消息之后的 1 轮对话会被丢弃')
  await window.getByRole('button', { name: '回退并重新开始' }).click()

  await expect(items(window)).toHaveCount(4, { timeout: 60_000 })
  await expect(items(window).nth(2)).toContainText(EDITED)
  await expect(window.getByRole('list', { name: '消息' })).not.toContainText(THIRD)
  await expect(items(window).nth(3).locator('p').first()).toContainText('4', {
    timeout: 180_000,
  })
  await expect(runStatus(window)).toHaveText('空闲', { timeout: 180_000 })
  // 回退后宿主重启，重建的历史里不能有被丢弃的后续轮次
  await expect.poll(traceCount, { timeout: 60_000 }).toBe(beforeEdit + 1)
  const afterEdit = readHostHistories(trace.file).at(-1)!
  expect(afterEdit.map(([role]) => role)).toEqual(['user', 'assistant'])
  expect(afterEdit[0]![1]).toBe(FIRST)
  expect(afterEdit[1]![1]).toContain('1')

  // 重新生成：这一轮是最后一轮，不再确认；宿主再次重启，历史仍是第一轮
  const beforeRegenerate = traceCount()
  const regenerated = items(window).nth(3)
  await regenerated.getByRole('button', { name: '重新生成' }).click()
  await expect.poll(traceCount, { timeout: 60_000 }).toBe(beforeRegenerate + 1)
  await expect(runStatus(window)).toHaveText('空闲', { timeout: 180_000 })
  await expect(items(window)).toHaveCount(4)
  await expect(items(window).nth(3).locator('p').first()).toContainText('4', {
    timeout: 180_000,
  })
  const afterRegenerate = readHostHistories(trace.file).at(-1)!
  expect(afterRegenerate.map(([role]) => role)).toEqual(['user', 'assistant'])
  expect(afterRegenerate[0]![1]).toBe(FIRST)

  await close()

  // 事件日志：两次回退都落库，原始事件保留
  const events = readEvents(userData)
  const rewinds = ofType(events, 'conversation.rewound')
  expect(rewinds.map((event) => event.payload['reason'])).toEqual(['edit', 'regenerate'])
  const users = ofType(events, 'message.user')
  expect(users).toHaveLength(5)
  expect(contentText(users[3]!.payload['content'])).toBe(EDITED)
  // 重新生成复用这一轮的用户输入（也就是编辑后的文本）
  expect(contentText(users[4]!.payload['content'])).toBe(EDITED)
  const replies = ofType(events, 'message.assistant.completed')
  expect(replies).toHaveLength(5)
  // FakeRuntime 会原样回显输入；回复很短且不含提问，才说明走的是真实模型
  const replyTexts = replies.map((event) => contentText(event.payload['content']).trim())
  for (const text of replyTexts) {
    expect(text).not.toContain('请只回复')
    expect(text.length).toBeLessThan(12)
  }
  expect(replyTexts[4]).toContain('4')
})
