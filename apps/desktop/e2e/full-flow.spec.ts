/**
 * M1 端到端验收的 CI 版本（M1-15a，m1.md §1）：在示例项目 `fixtures/sample-project` 的副本上，
 * 模型（本地 mock 端点，按脚本依次调用工具）读文件、改文件、运行测试；改文件与运行命令前弹出审批，
 * 允许后执行，测试通过。最后撤销本轮，项目与示例项目逐字节相同。
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
    const nexus = (
      globalThis as unknown as {
        nexus: { ready(): Promise<unknown>; request(m: string, p: object): Promise<unknown> }
      }
    ).nexus
    await nexus.ready()
    await nexus.request('settings.update', {
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
    await createSession(window, project, '修复 sum')
    await sendPrompt(window, '修复 sum 的 bug 并运行测试')

    // 读文件不需要审批；改文件与运行命令各审批一次
    const edit = window.getByRole('article', { name: '需要审批：edit_file' })
    await expect(edit).toBeVisible()
    await edit.getByRole('button', { name: '允许一次' }).click()
    const command = window.getByRole('article', { name: '需要审批：run_command' })
    await expect(command).toBeVisible()
    await expect(command.getByText('node --test').first()).toBeVisible()
    await command.getByRole('button', { name: '允许一次' }).click()

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

    await window.getByRole('button', { name: '撤销本轮' }).click()
    const dialog = window.getByRole('alertdialog', { name: '撤销本轮' })
    await expect(dialog.getByRole('list', { name: '将恢复的文件' })).toHaveText('还原 sum.mjs')
    await dialog.getByRole('button', { name: '确认撤销' }).click()
    await expect(window.getByText('已撤销本轮，恢复了 1 个文件。')).toBeVisible()
    expect(snapshot(project)).toEqual(initial)
  } finally {
    await mock.close()
  }
})
