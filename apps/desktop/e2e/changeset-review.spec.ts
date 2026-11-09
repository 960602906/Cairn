/**
 * 改动集审阅（M4-10）：父 Agent 在隔离工作区委派子运行写文件，完成后从委派卡片打开改动集，
 * 按文件接受后主工作区发生变化，再用合并前的检查点撤销这次合并。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, projectDir, runStatus, sendPrompt, setAgentOnSession } from './session.js'

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

const baseDraft = {
  model: { mode: 'inherit' as const },
  skills: { allow: ['*'] },
  limits: {},
  context: { includeProjectInstructions: true, compaction: 'auto' as const },
  memory: { scopes: ['session', 'project'] as const, write: 'never' as const },
}

async function createAgent(
  window: Page,
  draft: Record<string, unknown>,
): Promise<{ agentId: string; version: number }> {
  const saved = await request<{ agentId: string; published?: { version: number } }>(
    window,
    'agent.saveDraft',
    { definition: draft },
  )
  const published = await request<{ published?: { version: number } }>(window, 'agent.publish', {
    agentId: saved.agentId,
  })
  return { agentId: saved.agentId, version: published.published?.version ?? 1 }
}

test('在隔离工作区写入后按文件接受，并撤销合并检查点', async ({ launch, userData }) => {
  let mock: Awaited<ReturnType<typeof startMockModel>> | undefined
  try {
    const { window } = await launch()
    await window.evaluate(async () => {
      const cairn = (globalThis as unknown as { cairn: { ready(): Promise<unknown> } }).cairn
      await cairn.ready()
    })
    const child = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '隔离写手', 'en-US': 'Isolated writer' },
      description: { 'zh-CN': '在隔离工作区写文件', 'en-US': 'Writes in an isolated workspace' },
      instructions: '',
      tools: { allow: ['*'] },
      permissions: 'auto',
    })
    const lead = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '改动集协调员', 'en-US': 'Change set lead' },
      description: { 'zh-CN': '委派写文件', 'en-US': 'Delegates writes' },
      instructions: '',
      tools: { allow: ['*'] },
      permissions: 'ask',
      delegation: {
        enabled: true,
        allowedAgents: [child.agentId],
        maxDepth: 1,
        maxChildrenPerTurn: 1,
        maxParallel: 1,
        childBudgetShare: 0.5,
        defaultWorkspace: 'isolated',
        mergeReview: 'user',
      },
    })
    mock = await startMockModel({
      reply: '完成',
      toolCallsByPrompt: {
        委派写文件: [
          {
            name: 'delegate',
            arguments: {
              agent: child.agentId,
              task: '写入隔离工作区里的 notes.txt',
              brief: { goal: '写入 notes.txt', deliverable: '一句话结论' },
              workspace: 'isolated',
            },
          },
        ],
        '写入 notes.txt': [
          {
            name: 'write_file',
            arguments: { path: 'notes.txt', content: 'child\n' },
          },
        ],
      },
    })
    await window.evaluate(async (url) => {
      const cairn = (
        globalThis as unknown as {
          cairn: { request(m: string, p: object): Promise<unknown> }
        }
      ).cairn
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
    }, mock.baseUrl)
    await window.reload()

    const dir = projectDir(userData)
    const file = path.join(dir, 'notes.txt')
    writeFileSync(file, 'base\n')

    await createSession(window, dir, '改动集审阅')
    await setAgentOnSession(window, '改动集审阅', { id: lead.agentId, version: lead.version })

    await sendPrompt(window, '委派写文件')
    const approval = window.getByRole('region', { name: '待审批' })
    await approval.getByRole('button', { name: '允许一次' }).click()
    const card = window.getByRole('article', { name: /委派任务：写入隔离工作区/ })
    await expect(card).toBeVisible({ timeout: 30_000 })
    const writeApproval = card.getByRole('button', { name: '允许一次' })
    await expect(writeApproval).toBeVisible({ timeout: 30_000 })
    await writeApproval.click()
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })
    // 合并前主工作区仍是基线内容
    expect(readFileSync(file, 'utf8')).toBe('base\n')

    await card.getByRole('button', { name: /查看改动/ }).click()
    const review = window
      .getByRole('complementary', { name: '会话信息' })
      .getByRole('region', { name: '改动集审阅' })
    await expect(review).toBeVisible({ timeout: 15_000 })
    await expect(review.getByText('1 个文件')).toBeVisible()
    await review.getByRole('button', { name: /^notes\.txt/ }).click()
    await expect(review.getByRole('figure', { name: '差异：notes.txt' })).toBeVisible()
    await review.getByRole('button', { name: '接受此文件' }).click()
    await expect(review.getByText('已合并')).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(file, 'utf8')).toBe('child\n')

    // 浅色 / 深色截图（与现有 diff 端到端测试一致）
    const artifacts = '/opt/cursor/artifacts'
    mkdirSync(artifacts, { recursive: true })
    const setTheme = (theme: 'light' | 'dark') =>
      window.evaluate((value) => {
        const root = (
          globalThis as unknown as {
            document: { documentElement: { setAttribute(name: string, value: string): void } }
          }
        ).document.documentElement
        root.setAttribute('data-theme', value)
      }, theme)
    await setTheme('light')
    await review.screenshot({ path: path.join(artifacts, 'changeset-review-light.png') })
    await setTheme('dark')
    await review.screenshot({ path: path.join(artifacts, 'changeset-review-dark.png') })

    await review.getByRole('button', { name: /撤销这次合并/ }).click()
    const dialog = window.getByRole('dialog', { name: '撤销这次合并？' })
    await dialog.getByRole('button', { name: '撤销这次合并' }).click()
    await expect(review.getByText('已恢复到合并前的检查点。')).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(file, 'utf8')).toBe('base\n')
  } finally {
    await mock?.close()
  }
})
