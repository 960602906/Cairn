/**
 * M1 端到端验收的 CI 版本（M1-15a，m1.md §1）：在示例项目 `fixtures/sample-project` 的副本上，
 * 模型（本地 mock 端点，按脚本依次调用工具）读文件、改文件、运行测试；改文件与运行命令前弹出审批，
 * 允许后执行，测试通过。审阅 diff 后切换到第二个模型再对话一轮，然后撤销本轮，项目与示例项目逐字节相同。
 * 另一条用例只撤销被改过的那一个文件（M2-12）。两个模型的切换也在 provider.spec.ts。
 */
import { cpSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { APP_DIR, expect, test } from './app.js'
import { createSession, runStatus, sendPrompt } from './session.js'

const SAMPLE = path.resolve(APP_DIR, '../../fixtures/sample-project')
const REPLY = 'sum fixed and tests pass'

/** 目录中所有文件的相对路径与内容，按路径排序。 */
function snapshot(dir: string): [string, string][] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return [path.relative(dir, file), readFileSync(file).toString('base64')] as [string, string]
    })
    .sort(([a], [b]) => a.localeCompare(b))
}

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
            {
              id: 'e2e-model-2',
              displayName: 'Second',
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

/** 最后一次请求中交回模型的工具结果。 */
function lastToolResult(requests: readonly { messages: unknown }[]): string {
  const messages = (requests.at(-1)?.messages ?? []) as { role: string; content: unknown }[]
  return JSON.stringify(messages.filter((m) => m.role === 'tool').at(-1)?.content)
}

test('修复示例项目的 bug 并运行测试，之后撤销本轮', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCalls: [
      { name: 'read_file', arguments: { path: 'sum.mjs' } },
      {
        name: 'edit_file',
        arguments: { path: 'sum.mjs', oldText: 'let i = 1', newText: 'let i = 0' },
      },
      { name: 'run_command', arguments: { command: 'node --test' } },
    ],
  })
  try {
    const project = path.join(userData, 'sample-project')
    cpSync(SAMPLE, project, { recursive: true })
    const initial = snapshot(project)
    expect(initial.map(([file]) => file)).toEqual(['README.md', 'sum.mjs', 'sum.test.mjs'])

    const { window } = await launch()
    await configureProvider(window, mock.baseUrl)
    // 设置是绕过界面写入的，重新加载后输入框才能列出两个模型
    await window.reload()
    await createSession(window, project, '修复 sum')
    await sendPrompt(window, '修复 sum 的 bug 并运行测试')

    // 读文件不需要审批；改文件与运行命令各审批一次
    const edit = window.getByRole('article', { name: '需要审批：edit_file' })
    await expect(edit).toBeVisible()
    await edit.getByRole('button', { name: '允许一次' }).click()
    const command = window.getByRole('article', { name: '需要审批：run_command' })
    await expect(command).toBeVisible()
    await expect(command.getByText('node --test').first()).toBeVisible()
    // 数字键 1 选择“运行一次”（M2-05）
    await window.keyboard.press('1')

    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    expect(mock.requests).toHaveLength(4)
    for (const name of ['read_file', 'edit_file', 'run_command']) {
      await expect(window.getByRole('region', { name: `调用工具：${name}` })).toContainText('完成')
    }
    expect(readFileSync(path.join(project, 'sum.mjs'), 'utf8')).toContain('let i = 0')
    // 测试通过：node:test 的汇总中没有失败
    const result = lastToolResult(mock.requests)
    expect(result).toContain('Exit code: 0')
    expect(result).toMatch(/pass 2/)
    expect(result).toMatch(/fail 0/)

    // 审阅这一轮的 diff
    const turn = window.getByRole('region', { name: '本轮变更' })
    await turn.getByRole('button', { name: /sum\.mjs/ }).click()
    const diff = window.getByRole('figure', { name: '差异：sum.mjs' })
    await expect(diff).toContainText('let i = 0')
    await expect(diff).toContainText('let i = 1')

    // 下一轮换第二个模型
    await window.getByRole('button', { name: '模型：Local · e2e-model', exact: true }).click()
    await window.getByRole('menuitem', { name: /Second/ }).click()
    await sendPrompt(window, '再看一眼')
    await expect(window.getByText('再看一眼')).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    expect(mock.requests.map((request) => request.model)).toEqual([
      'e2e-model',
      'e2e-model',
      'e2e-model',
      'e2e-model',
      'e2e-model-2',
    ])

    await window.getByRole('button', { name: '撤销本轮' }).first().click()
    const dialog = window.getByRole('dialog', { name: '撤销第 1 轮及之后的改动？' })
    await expect(dialog.getByRole('list', { name: '受影响的文件' })).toHaveText('sum.mjs恢复原内容')
    await dialog.getByRole('button', { name: '撤销 1 个文件' }).click()
    await expect(window.getByText(/^已撤销到第 1 轮开始之前 · /)).toBeVisible()
    expect(snapshot(project)).toEqual(initial)
  } finally {
    await mock.close()
  }
})

test('审阅 diff 后撤销单个文件，其他对话保留', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCalls: [
      { name: 'read_file', arguments: { path: 'sum.mjs' } },
      {
        name: 'edit_file',
        arguments: { path: 'sum.mjs', oldText: 'let i = 1', newText: 'let i = 0' },
      },
      { name: 'run_command', arguments: { command: 'node --test' } },
    ],
  })
  try {
    const project = path.join(userData, 'sample-project')
    cpSync(SAMPLE, project, { recursive: true })
    const { window } = await launch()
    await configureProvider(window, mock.baseUrl)
    await createSession(window, project, '撤销单个文件')
    await sendPrompt(window, '修复 sum 的 bug 并运行测试')
    await window
      .getByRole('article', { name: '需要审批：edit_file' })
      .getByRole('button', { name: '允许一次' })
      .click()
    const command = window.getByRole('article', { name: '需要审批：run_command' })
    await expect(command).toBeVisible()
    await window.keyboard.press('1')
    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    expect(readFileSync(path.join(project, 'sum.mjs'), 'utf8')).toContain('let i = 0')

    const turn = window.getByRole('region', { name: '本轮变更' })
    await turn.getByRole('button', { name: /sum\.mjs/ }).click()
    const diff = window.getByRole('figure', { name: '差异：sum.mjs' })
    await expect(diff).toContainText('let i = 0')
    await diff.getByRole('button', { name: '撤销此文件' }).click()
    const dialog = window.getByRole('dialog', { name: '撤销对这个文件的改动？' })
    await dialog.getByRole('button', { name: '撤销此文件' }).click()
    await expect(turn).toHaveCount(0)
    const restored = readFileSync(path.join(project, 'sum.mjs'), 'utf8')
    expect(restored).toContain('let i = 1')
    expect(restored).not.toContain('let i = 0')
    await expect(window.getByText(REPLY)).toBeVisible()
  } finally {
    await mock.close()
  }
})
