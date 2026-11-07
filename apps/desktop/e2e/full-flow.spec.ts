/**
 * M1 端到端验收的 CI 版本（M1-15a，m1.md §1）：在示例项目 `fixtures/sample-project` 的副本上，
 * 模型（本地 mock 端点，按脚本依次调用工具）读文件、改文件、新建文件、运行测试；改文件与运行命令前弹出
 * 审批，允许后执行，测试通过。
 * M2-12 全流程：在“本轮变更”中审阅 diff，单独撤销新建的文件；在输入框中切换到第二个模型继续对话；最后
 * 撤销第 1 轮及之后的改动，项目与示例项目逐字节相同。
 */
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { APP_DIR, expect, test } from './app.js'
import { chatRequests, createSession, runStatus, sendPrompt } from './session.js'

const SAMPLE = path.resolve(APP_DIR, '../../fixtures/sample-project')
const REPLY = 'sum fixed and tests pass'
const MODEL = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

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
  await window.evaluate(
    async ([url, model]) => {
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
              { id: 'e2e-model', ...model },
              { id: 'e2e-model-2', displayName: 'Second', ...model },
            ],
          },
        ],
        defaultModel: { providerId: 'local', modelId: 'e2e-model' },
      })
    },
    [baseUrl, MODEL] as const,
  )
  // 设置是绕过界面改的，重新加载让界面读到新的提供方（输入框的模型菜单）
  await window.reload()
}

/** 最后一次请求中交回模型的工具结果。 */
function lastToolResult(requests: readonly { messages: unknown }[]): string {
  const messages = (requests.at(-1)?.messages ?? []) as { role: string; content: unknown }[]
  return JSON.stringify(messages.filter((m) => m.role === 'tool').at(-1)?.content)
}

test('修复示例项目的 bug 并运行测试：审阅 diff、撤销单个文件、切换模型、撤销本轮', async ({
  launch,
  userData,
}) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCalls: [
      { name: 'read_file', arguments: { path: 'sum.mjs' } },
      {
        name: 'edit_file',
        arguments: { path: 'sum.mjs', oldText: 'let i = 1', newText: 'let i = 0' },
      },
      { name: 'write_file', arguments: { path: 'NOTES.md', content: 'fixed the loop\n' } },
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
    await createSession(window, project, '修复 sum')
    await sendPrompt(window, '修复 sum 的 bug 并运行测试')

    // 读文件不需要审批；改文件、新建文件与运行命令各审批一次
    const edit = window.getByRole('article', { name: '需要审批：edit_file' })
    await expect(edit).toBeVisible()
    await edit.getByRole('button', { name: '允许一次' }).click()
    const write = window.getByRole('article', { name: '需要审批：write_file' })
    await expect(write).toBeVisible()
    await write.getByRole('button', { name: '允许一次' }).click()
    const command = window.getByRole('article', { name: '需要审批：run_command' })
    await expect(command).toBeVisible()
    await expect(command.getByText('node --test').first()).toBeVisible()
    // 数字键 1 选择“运行一次”（M2-05）
    await window.keyboard.press('1')

    await expect(window.getByText(REPLY)).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')
    const firstTurn = chatRequests(mock.requests)
    expect(firstTurn).toHaveLength(5)
    for (const name of ['read_file', 'edit_file', 'write_file', 'run_command']) {
      await expect(window.getByRole('region', { name: `调用工具：${name}` })).toContainText('完成')
    }
    expect(readFileSync(path.join(project, 'sum.mjs'), 'utf8')).toContain('let i = 0')
    // 测试通过：node:test 的汇总中没有失败
    const result = lastToolResult(firstTurn)
    expect(result).toContain('Exit code: 0')
    expect(result).toMatch(/pass 2/)
    expect(result).toMatch(/fail 0/)

    // 审阅 diff（M2-07）：本轮变更中点开 sum.mjs
    const changes = window.getByRole('region', { name: '本轮变更' })
    await expect(changes).toContainText('2 个文件')
    await changes.getByRole('button', { name: /^sum\.mjs/ }).click()
    const diff = window.getByRole('figure', { name: '差异：sum.mjs' })
    await expect(diff.locator('[data-type="add"]')).toContainText('let i = 0')
    await expect(diff.locator('[data-type="del"]')).toContainText('let i = 1')

    // 单独撤销新建的文件：只删除 NOTES.md，sum.mjs 的修改保留
    await changes.getByRole('button', { name: /^NOTES\.md/ }).click()
    await window
      .getByRole('figure', { name: '差异：NOTES.md' })
      .getByRole('button', { name: '撤销此文件' })
      .click()
    const revert = window.getByRole('dialog', { name: '撤销对这个文件的改动？' })
    await revert.getByRole('button', { name: '撤销此文件' }).click()
    await expect(changes.getByRole('button', { name: /^NOTES\.md/ })).toHaveCount(0)
    expect(existsSync(path.join(project, 'NOTES.md'))).toBe(false)
    expect(readFileSync(path.join(project, 'sum.mjs'), 'utf8')).toContain('let i = 0')

    // 切换模型（M2-04）：第二轮使用第二个模型
    await window.getByRole('button', { name: '模型：Local · e2e-model', exact: true }).click()
    await window.getByRole('menuitem', { name: /Second/ }).click()
    await sendPrompt(window, '再确认一下')
    await expect(window.getByText(REPLY)).toHaveCount(2)
    await expect(runStatus(window)).toHaveText('空闲')
    expect(chatRequests(mock.requests).map((r) => r.model)).toEqual([
      ...Array.from({ length: 5 }, () => 'e2e-model'),
      'e2e-model-2',
    ])

    // 撤销第 1 轮及之后的改动（M2-08）：项目回到示例项目
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
