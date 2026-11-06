/**
 * 审批卡片（M1-11b，架构 §10.4）：模型（本地 mock 端点）请求执行 `run_command`，按“询问”模式需要审批，
 * 界面显示审批卡片；允许后命令执行、结果交回模型，拒绝时附加的说明交回模型。
 * 检查点（M1-12b）：本轮开始与执行命令前在应用数据目录的影子仓库中创建，不触碰项目目录。
 * 恢复（M1-12c）：恢复到本轮开始时的检查点，再恢复到恢复前的检查点（撤销恢复）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'done after the tool'
const COMMAND = 'echo approved-by-e2e'

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
          ],
        },
      ],
      defaultModel: { providerId: 'local', modelId: 'e2e-model' },
    })
  }, baseUrl)
}

/** 经预加载脚本发出界面请求，失败时抛出。 */
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

interface Plan {
  before: string
  files: { path: string; status: string }[]
}

/** 第二次请求中交回模型的工具结果。 */
function toolResult(requests: readonly { messages: unknown }[]): string {
  const messages = (requests[1]?.messages ?? []) as { role: string; content: unknown }[]
  return JSON.stringify(messages.filter((m) => m.role === 'tool'))
}

for (const decision of ['allow', 'deny'] as const) {
  test(`审批卡片：${decision === 'allow' ? '允许一次后执行命令' : '拒绝并附说明'}`, async ({
    launch,
    userData,
  }) => {
    const mock = await startMockModel({
      reply: REPLY,
      toolCall: { name: 'run_command', arguments: { command: COMMAND } },
    })
    try {
      const { window } = await launch()
      await configureProvider(window, mock.baseUrl)
      await createSession(window, projectDir(userData), '审批')
      await sendPrompt(window, '运行命令')

      const card = window.getByRole('article', { name: '需要审批：run_command' })
      await expect(card).toBeVisible()
      await expect(runStatus(window)).toHaveText('等待审批')
      await expect(card.getByText(COMMAND).first()).toBeVisible()
      await expect(card.getByText('原因: 这类操作默认需要审批')).toBeVisible()

      if (decision === 'allow') {
        await card.getByRole('button', { name: '允许一次' }).click()
      } else {
        await card.getByLabel(/拒绝说明/).fill('不要运行命令')
        await card.getByRole('button', { name: '拒绝' }).click()
      }
      await expect(card).toHaveCount(0)
      await expect(window.getByText(REPLY.trim())).toBeVisible()
      await expect(runStatus(window)).toHaveText('空闲')

      expect(mock.requests).toHaveLength(2)
      const result = toolResult(mock.requests)
      if (decision === 'allow') {
        expect(result).toContain('approved-by-e2e')
        // 项目的影子仓库中有这个会话的检查点（每轮开始、命令前），项目目录中没有 .git
        const repos = readdirSync(path.join(userData, 'checkpoints'))
        expect(repos).toHaveLength(1)
        const refs = execFileSync('git', [
          '--git-dir',
          path.join(userData, 'checkpoints', repos[0]!),
          'for-each-ref',
          '--format=%(refname)',
          'refs/cairn/sessions/',
        ])
          .toString()
          .trim()
          .split('\n')
        expect(refs).toHaveLength(1)
        expect(existsSync(path.join(projectDir(userData), '.git'))).toBe(false)

        // 恢复到本轮开始时的检查点：之后新建的文件被删除；恢复本身可以撤销
        const { sessions } = await request<{ sessions: { sessionId: string }[] }>(
          window,
          'session.list',
          {},
        )
        const id = sessions[0]!.sessionId
        const { checkpoints } = await request<{
          checkpoints: { checkpointId: string; reason: string }[]
        }>(window, 'checkpoint.list', { sessionId: id })
        expect(checkpoints.map((c) => c.reason)).toEqual(['turn_start', 'before_command'])
        const extra = path.join(projectDir(userData), 'after-turn.txt')
        writeFileSync(extra, 'later')
        const target = { sessionId: id, checkpointId: checkpoints[0]!.checkpointId }
        const preview = await request<Plan>(window, 'checkpoint.preview', target)
        expect(preview.files).toContainEqual({ path: 'after-turn.txt', status: 'deleted' })
        expect(existsSync(extra)).toBe(true)
        const restored = await request<Plan>(window, 'checkpoint.restore', target)
        expect(existsSync(extra)).toBe(false)
        await request<Plan>(window, 'checkpoint.restore', {
          sessionId: id,
          checkpointId: restored.before,
        })
        expect(existsSync(extra)).toBe(true)
        const after = await request<{ checkpoints: { reason: string }[] }>(
          window,
          'checkpoint.list',
          { sessionId: id },
        )
        expect(after.checkpoints.map((c) => c.reason)).toEqual([
          'turn_start',
          'before_command',
          'before_restore',
          'before_restore',
        ])
      } else {
        expect(result).toContain('The user denied this tool call.')
        expect(result).toContain('不要运行命令')
      }
    } finally {
      await mock.close()
    }
  })
}
