/**
 * 内置专业 Agent 与委派设置（M4-11）：复制编程助手 → 检查默认委派目标 → 发布 →
 * 在会话中委派给 builtin.explorer → 子运行完成。另存浅色 / 深色截图。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const ARTIFACTS_DIR =
  process.platform === 'win32' ? 'C:\\opt\\cursor\\artifacts' : '/opt/cursor/artifacts'

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

test('复制编程助手、启用委派并运行代码探索子 Agent', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: '委派完成',
    toolCallsByPrompt: {
      探索登录: [
        {
          name: 'delegate',
          arguments: {
            agent: 'builtin.explorer',
            task: '定位登录流程',
            brief: { goal: '定位登录流程', deliverable: '文件与行号' },
            workspace: 'shared',
          },
        },
      ],
    },
  })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    mkdirSync(ARTIFACTS_DIR, { recursive: true })

    await window.getByRole('button', { name: 'Agents' }).click()
    await expect(window.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible()
    await expect(window.getByText('代码探索员')).toBeVisible()
    await expect(window.getByText('代码审查员')).toBeVisible()
    await expect(window.getByText('测试补全员')).toBeVisible()

    await window.getByRole('button', { name: '基于编程助手复制' }).click()
    await expect(window.getByRole('button', { name: '保存草稿' })).toBeVisible()
    await window.getByRole('button', { name: '委派', exact: true }).click()

    const enabled = window.getByRole('switch', { name: '允许委派' })
    await expect(enabled).toHaveAttribute('aria-checked', 'true')
    await expect(window.getByRole('checkbox', { name: /代码探索员/ })).toBeChecked()
    await expect(window.getByRole('checkbox', { name: /代码审查员/ })).toBeChecked()
    await expect(window.getByRole('checkbox', { name: /测试补全员/ })).toBeChecked()
    await setTheme(window, 'light')
    await window.screenshot({
      path: path.join(ARTIFACTS_DIR, 'builtin-agent-delegation-light.png'),
    })
    await setTheme(window, 'dark')
    await window.screenshot({
      path: path.join(ARTIFACTS_DIR, 'builtin-agent-delegation-dark.png'),
    })
    await setTheme(window, 'light')

    await window.getByRole('button', { name: /发布 v\d+/ }).click()
    const publishDialog = window.getByRole('dialog')
    await expect(publishDialog.getByText('发布这个 Agent？')).toBeVisible()
    await publishDialog.getByRole('button', { name: '发布', exact: true }).click()
    await expect(window.getByText('已发布', { exact: true })).toBeVisible()

    const project = projectDir(userData)
    await createSession(window, project, '内置 Agent 委派')
    await window.getByRole('button', { name: /^Agent：/ }).click()
    const agents = window.getByRole('listbox', { name: '选择 Agent' })
    await agents.getByRole('option', { name: /编程助手 副本/ }).click()

    await sendPrompt(window, '探索登录流程')
    const card = window.getByRole('article', { name: '委派任务：定位登录流程' })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText('完成', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(window.getByText('委派完成', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })

    await setTheme(window, 'light')
    await window.screenshot({
      path: path.join(ARTIFACTS_DIR, 'builtin-agent-delegation-run-light.png'),
    })
    await setTheme(window, 'dark')
    await window.screenshot({
      path: path.join(ARTIFACTS_DIR, 'builtin-agent-delegation-run-dark.png'),
    })
  } finally {
    await mock.close()
  }
})
