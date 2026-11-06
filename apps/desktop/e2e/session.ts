/**
 * 端到端测试的界面操作（M0-16b）。文案按 `launchApp` 默认固定的 `zh-CN` 书写。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from './app.js'

/** 一条消息：作者（"你" / "助手"）与文本。 */
export type ExpectedMessage = readonly [author: '你' | '助手', text: string]

/** 在数据目录中准备一个项目目录，返回其绝对路径。 */
export function projectDir(userData: string): string {
  const dir = path.join(userData, 'project')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const runStatus = (window: Page) => window.getByRole('status')

const messageItems = (window: Page) =>
  window.getByRole('list', { name: '消息' }).getByRole('listitem')

/** 进行中（正在流式输出）的消息。 */
export const liveMessage = (window: Page) =>
  messageItems(window).and(window.locator('[aria-busy="true"]'))

/** 新建会话，等待它成为当前会话。 */
export async function createSession(window: Page, projectPath: string, title: string) {
  await window.getByRole('button', { name: '新建会话' }).click()
  await window.getByLabel('项目目录').fill(projectPath)
  await window.getByLabel('标题（可选）').fill(title)
  await window.getByRole('button', { name: '创建' }).click()
  await expect(window.getByRole('heading', { level: 2, name: title })).toBeVisible()
}

/** 在会话列表中选中会话。 */
export async function openSession(window: Page, title: string) {
  await window.getByRole('navigation').getByRole('button', { name: title }).click()
  await expect(window.getByRole('heading', { level: 2, name: title })).toBeVisible()
}

/** 用 Enter 发送一条输入。 */
export async function sendPrompt(window: Page, text: string) {
  const input = window.getByLabel('输入消息')
  await input.fill(text)
  await input.press('Enter')
}

/** 消息流中各条消息的正文（每条消息的段落）。 */
export async function messageTexts(window: Page): Promise<string[]> {
  return messageItems(window).locator('p').allTextContents()
}

/** 消息流恰好是这些消息，且没有进行中的消息。 */
export async function expectMessages(window: Page, messages: readonly ExpectedMessage[]) {
  const items = messageItems(window)
  await expect(items.locator('strong')).toHaveText(messages.map(([author]) => author))
  await expect(items.locator('p')).toHaveText(messages.map(([, text]) => text))
  await expect(liveMessage(window)).toHaveCount(0)
}

/** 发送一条输入并等待这一轮完成（FakeRuntime 原样回复），之后消息流为 `before` 加上这一问一答。 */
export async function converse(
  window: Page,
  text: string,
  before: readonly ExpectedMessage[] = [],
): Promise<ExpectedMessage[]> {
  await sendPrompt(window, text)
  const after: ExpectedMessage[] = [...before, ['你', text], ['助手', text]]
  await expectMessages(window, after)
  await expect(runStatus(window)).toHaveText('空闲')
  return after
}

/**
 * 在界面中记录进行中消息（`aria-busy`）每次变化后的文本，用于确认回复是流式出现的。
 * 返回读取函数，得到按出现顺序排列、相邻不重复的文本。须在发送之前调用。
 */
export async function recordLiveText(window: Page): Promise<() => Promise<string[]>> {
  await window.evaluate(`(() => {
    const seen = []
    globalThis.__cairnLiveText = seen
    new MutationObserver(() => {
      for (const item of document.querySelectorAll('li[aria-busy="true"]')) {
        const text = item.querySelector('p')?.textContent ?? ''
        if (text !== '' && seen.at(-1) !== text) seen.push(text)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })()`)
  return async () => (await window.evaluate('globalThis.__cairnLiveText')) as string[]
}
