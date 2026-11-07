/**
 * Agents 管理与会话中选择（M3-12）：复制内置编程助手 → 改指令 → 保存草稿 → 发布 →
 * 在输入框的 Agent 选择器里选中它 → 模型请求的系统提示词包含新指令。另存浅色 / 深色截图。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, projectDir, runStatus, sendPrompt } from './session.js'

const INSTRUCTIONS = 'You are a custom e2e test agent. Always be concise.'
const REPLY = 'custom agent reply'

const ARTIFACTS_DIR =
  process.platform === 'win32' ? 'C:\\opt\\cursor\\artifacts' : '/opt/cursor/artifacts'

async function request<T>(window: Page, method: string, params: object): Promise<T> {
  const reply = (await window.evaluate(
    async ([m, p]) => {
      const cairn = (
        globalThis as unknown as { cairn: { request(m: string, p: object): Promise<unknown> } }
      ).cairn
      return cairn.request(m as string, p as object)
    },
    [method, params] as const,
  )) as { ok: boolean; result?: unknown; error?: unknown }
  if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result as T
}

async function configureModel(window: Page, baseUrl: string) {
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
  await window.reload()
}

async function setTheme(window: Page, theme: 'light' | 'dark') {
  await window.evaluate((value) => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { setAttribute(name: string, value: string): void } }
      }
    ).document.documentElement
    root.setAttribute('data-theme', value)
  }, theme)
}

test('复制编程助手、改指令、发布并在会话中选用', async ({ launch, userData }) => {
  const mock = await startMockModel({ reply: REPLY })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    mkdirSync(ARTIFACTS_DIR, { recursive: true })

    await window.getByRole('button', { name: 'Agents' }).click()
    await expect(window.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible()
    await setTheme(window, 'light')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'agents-page-light.png') })
    await setTheme(window, 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'agents-page-dark.png') })
    await setTheme(window, 'light')

    await window.getByRole('button', { name: '基于编程助手复制' }).click()
    await expect(window.getByRole('button', { name: '保存草稿' })).toBeVisible()

    await window.getByRole('button', { name: '指令', exact: true }).click()
    const textarea = window.getByLabel('系统指令')
    await expect(textarea).toBeVisible()
    await textarea.fill(INSTRUCTIONS)
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'agents-editor-light.png') })
    await setTheme(window, 'dark')
    await window.screenshot({ path: path.join(ARTIFACTS_DIR, 'agents-editor-dark.png') })
    await setTheme(window, 'light')

    await window.getByRole('button', { name: '保存草稿' }).click()
    await window.getByRole('button', { name: /发布 v\d+/ }).click()
    const publishDialog = window.getByRole('dialog')
    await expect(publishDialog.getByText('发布这个 Agent？')).toBeVisible()
    await publishDialog.getByRole('button', { name: '发布', exact: true }).click()
    await expect(window.getByText('已发布')).toBeVisible()

    const project = projectDir(userData)
    const created = await request<{ sessionId: string }>(window, 'session.create', {
      projectPath: project,
      title: 'Agent 会话',
    })
    await window.reload()
    await window.getByRole('navigation').getByRole('button', { name: 'Agent 会话' }).click()
    await expect(window.getByRole('heading', { level: 2, name: 'Agent 会话' })).toBeVisible()

    await window.getByRole('button', { name: /^Agent：/ }).click()
    const listbox = window.getByRole('listbox', { name: '选择 Agent' })
    await expect(listbox).toBeVisible()
    await listbox.getByRole('option', { name: /编程助手 副本/ }).click()

    await sendPrompt(window, '你好')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    const chats = chatRequests(mock.requests)
    expect(chats.length).toBeGreaterThan(0)
    expect(JSON.stringify(chats.at(-1)?.messages)).toContain(INSTRUCTIONS)
    expect(created.sessionId).toBeTruthy()
  } finally {
    await mock.close()
  }
})
