/**
 * 右侧工作台的后台任务：启动一条持续输出的后台命令，在「后台任务」面板看到运行中与耗时，
 * 展开输出并停止后移到「已完成」；首页保留后台任务概览。截图输出到
 * .cache/cairn-visual-check/background-tasks。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, sendPrompt, sessionPanel } from './session.js'

const ARTIFACTS = path.resolve(
  import.meta.dirname,
  '../../../.cache/cairn-visual-check/background-tasks',
)
mkdirSync(ARTIFACTS, { recursive: true })

async function configureModel(window: Page, baseUrl: string) {
  await window.evaluate(async (url) => {
    const cairn = (
      globalThis as unknown as {
        cairn: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).cairn
    await cairn.ready()
    await cairn.request('settings.update', {
      permissionMode: 'auto',
      onboardingSeen: true,
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

/** 通过设置页切换配色，确保界面真正应用；Esc 回到对话页。 */
async function setTheme(window: Page, label: string, id: string): Promise<void> {
  await window.getByRole('button', { name: '设置', exact: true }).click()
  const nav = window.getByRole('navigation', { name: '设置分类' })
  await nav.getByRole('button', { name: /^通用与外观/ }).click()
  await window
    .getByRole('radiogroup', { name: '主题' })
    .getByRole('radio', { name: new RegExp(`^${label}`) })
    .click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', id)
  await window.keyboard.press('Escape')
  await expect(nav).toHaveCount(0)
}

test('后台任务面板显示运行中的命令、耗时与输出', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '后台命令已启动',
    toolCallsByPrompt: {
      启动后台任务: [
        {
          name: 'start_command',
          arguments: {
            command: 'node -e "setInterval(() => console.log(\'bg-tick\'), 200)"',
          },
        },
      ],
    },
  })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '后台任务')
    await sendPrompt(window, '启动后台任务')
    await expect(window.getByText('后台命令已启动')).toBeVisible()

    await window.getByRole('button', { name: '会话信息' }).click()
    const panel = sessionPanel(window)
    await panel.getByRole('button', { name: '打开其他面板' }).click()
    await window.getByRole('menuitem', { name: '后台' }).click()
    const tab = panel.getByRole('tab', { name: '后台任务' })
    await expect(tab).toHaveAttribute('aria-selected', 'true')

    const task = panel.getByRole('article', { name: /后台任务：/ })
    await expect(task).toBeVisible()
    await expect(task.getByText('运行中')).toBeVisible()
    await expect(task.getByText(/\d+ 秒/)).toBeVisible()
    await window.mouse.move(900, 400)
    await window.screenshot({ path: path.join(ARTIFACTS, 'background-tasks-running-light.png') })

    await task.getByRole('button', { name: '查看输出' }).click()
    await expect(task.locator('pre')).toContainText('bg-tick')
    await window.screenshot({ path: path.join(ARTIFACTS, 'background-tasks-output-light.png') })

    await task.getByRole('button', { name: '停止' }).click()
    const finished = panel.getByRole('region', { name: '已完成' })
    await expect(finished.getByText('已停止')).toBeVisible()
    await window.mouse.move(900, 400)
    await window.screenshot({ path: path.join(ARTIFACTS, 'background-tasks-finished-light.png') })

    // 关掉标签回到首页，后台任务概览仍在。
    await panel.getByRole('button', { name: '关闭后台任务' }).click()
    await expect(panel.getByRole('button', { name: '打开后台任务' })).toBeVisible()
    await window.screenshot({ path: path.join(ARTIFACTS, 'background-tasks-home-light.png') })

    await setTheme(window, '深色', 'dark')
    // 设置页关闭后对话页重新挂载，窄窗口下工作台默认收起；重新打开看深色下的列表。
    await window.getByRole('button', { name: '会话信息' }).click()
    const darkPanel = sessionPanel(window)
    await darkPanel.getByRole('button', { name: '打开其他面板' }).click()
    await window.getByRole('menuitem', { name: '后台' }).click()
    await expect(darkPanel.getByRole('region', { name: '已完成' })).toContainText('已停止')
    await window.mouse.move(900, 400)
    await window.screenshot({ path: path.join(ARTIFACTS, 'background-tasks-finished-dark.png') })
  } finally {
    await mock.close()
  }
})
