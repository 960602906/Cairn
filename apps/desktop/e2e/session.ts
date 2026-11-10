/**
 * 端到端测试的界面操作（M0-16b）。文案按 `launchApp` 默认固定的 `zh-CN` 书写。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from './app.js'

/** 一条消息：作者（"你" / "助手"）与文本。 */
export type ExpectedMessage = readonly [author: '你' | '助手', text: string]

/**
 * 标题、会话要点、压缩摘要的请求不是对话。断言模型请求时先去掉它们。
 */
const AUXILIARY_PROMPTS = [
  'You name a conversation.',
  'You keep a session brief.',
  'You summarize an earlier part of a coding session',
] as const

export function chatRequests<T extends { readonly messages: unknown }>(
  requests: readonly T[],
): T[] {
  return requests.filter((request) => {
    const text = JSON.stringify(request.messages)
    return AUXILIARY_PROMPTS.every((phrase) => !text.includes(phrase))
  })
}

/** 在数据目录中准备一个项目目录，返回其绝对路径。 */
export function projectDir(userData: string): string {
  const dir = path.join(userData, 'project')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const runStatus = (window: Page) => window.getByRole('status')

/**
 * 展开最近一次工具步骤（时间线默认折叠，成功时只显示一行摘要），返回该步骤区域。
 * 展开后 `run_command` 的终端卡片才在 DOM 里。
 */
export async function expandToolStep(window: Page, name: string) {
  const step = window.getByRole('region', { name: `调用工具：${name}` }).last()
  const collapsed = step.locator('button[aria-expanded="false"]')
  if ((await collapsed.count()) > 0) await collapsed.first().click()
  return step
}

interface RpcReply<T> {
  readonly ok: boolean
  readonly result?: T
  readonly error?: unknown
}

/** 调用一个主进程 RPC 并返回结果；失败时抛出带方法名的错误。 */
export async function rpc<T>(window: Page, method: string, params: object): Promise<T> {
  const reply = (await window.evaluate(
    async ([name, payload]) => {
      const cairn = (
        globalThis as unknown as {
          cairn: {
            ready(): Promise<unknown>
            request(method: string, params: object): Promise<unknown>
          }
        }
      ).cairn
      await cairn.ready()
      return cairn.request(name as string, payload as object)
    },
    [method, params] as const,
  )) as RpcReply<T>
  if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result as T
}

/** 配置一个 OpenAI 兼容供应商与凭据，供模拟模型服务使用。 */
export async function configureProvider(
  window: Page,
  baseUrl: string,
  secret: string,
  id = 'acceptance',
): Promise<void> {
  await window.evaluate(
    async ({ url, key, providerId }) => {
      const cairn = (
        globalThis as unknown as {
          cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
      await cairn.ready()
      const stored = await cairn.request('credentials.set', {
        ref: `${providerId}-key`,
        secret: key,
      })
      if (!(stored as { ok: boolean }).ok) throw new Error('credentials.set failed')
      const updated = await cairn.request('settings.update', {
        providers: [
          {
            id: providerId,
            kind: 'openai',
            displayName: providerId,
            baseUrl: url,
            credentialRef: `${providerId}-key`,
            models: [
              {
                id: 'acceptance-model',
                contextWindow: 32_000,
                maxOutputTokens: 1_000,
                supportsTools: true,
                supportsParallelToolCalls: false,
                supportsReasoning: false,
              },
            ],
          },
        ],
        defaultModel: { providerId, modelId: 'acceptance-model' },
      })
      if (!(updated as { ok: boolean }).ok) throw new Error('settings.update failed')
    },
    { url: baseUrl, key: secret, providerId: id },
  )
}

const messageItems = (window: Page) =>
  // 只取直接子项：工具时间线等嵌套列表不算消息
  window.getByRole('list', { name: '消息' }).locator(':scope > li')

/** 进行中（正在流式输出）的消息。 */
export const liveMessage = (window: Page) =>
  messageItems(window).and(window.locator('[aria-busy="true"]'))

/**
 * 新建会话，等待它成为当前会话。
 *
 * 新对话首页的标题来自第一条输入，不能预先指定标题，所以这里用同一个 `session.create`
 * 请求创建项目与会话，刷新界面后在侧栏打开。需要验证新对话首页本身的用例见
 * `git-bar.spec.ts` 与 `project-setup.spec.ts`。
 */
export async function createSession(
  window: Page,
  projectPath: string,
  title: string,
): Promise<string> {
  const created = await rpc<{ sessionId: string }>(window, 'session.create', {
    projectPath,
    ...(title === '' ? {} : { title }),
  })
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await openSession(window, title === '' ? '未命名会话' : title)
  return created.sessionId
}

/** 在会话列表中选中会话。 */
export async function openSession(window: Page, title: string) {
  await window
    .getByRole('navigation', { name: '会话' })
    .getByRole('button', { name: title })
    .click()
  await expect(window.getByRole('heading', { level: 2, name: title })).toBeVisible()
}

/**
 * 给已有会话指定 Agent（`session.setAgent`）。Agent 选择器已从界面移除，
 * 委派、改动集等仍需要自定义 Agent 的用例直接用 RPC 指定。
 */
export async function setAgentOnSession(
  window: Page,
  title: string,
  agent: { readonly id: string; readonly version: number },
): Promise<string> {
  const result = await window.evaluate(
    async ([sessionTitle, ref]) => {
      const cairn = (
        globalThis as unknown as {
          cairn: {
            request(
              method: string,
              params: object,
            ): Promise<{ ok: boolean; result?: unknown; error?: unknown }>
          }
        }
      ).cairn
      const listed = await cairn.request('session.list', {})
      if (!listed.ok) return { error: listed.error }
      const sessions = (listed.result as { sessions: { sessionId: string; title: string }[] })
        .sessions
      const session = sessions.find((item) => item.title === sessionTitle)
      if (!session) return { error: 'session not found' }
      const applied = await cairn.request('session.setAgent', {
        sessionId: session.sessionId,
        agent: ref,
      })
      return applied.ok ? { sessionId: session.sessionId } : { error: applied.error }
    },
    [title, agent] as const,
  )
  if ('error' in result) throw new Error(`session.setAgent: ${JSON.stringify(result.error)}`)
  return result.sessionId
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
