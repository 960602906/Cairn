/**
 * 流水线（M7-08）：父运行调用 `run_pipeline`，`build` 完成后 `check` 失败，
 * 依赖它的 `docs` 被跳过；对话里的流水线卡片显示阶段进度与失败传播。
 */
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
              supportsParallelToolCalls: true,
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

test('阶段失败后跳过依赖它的阶段，已完成结果保留', async ({ launch, userData }) => {
  let mock: Awaited<ReturnType<typeof startMockModel>> | undefined
  try {
    const { window } = await launch()
    await window.evaluate(async () => {
      const cairn = (globalThis as unknown as { cairn: { ready(): Promise<unknown> } }).cairn
      await cairn.ready()
    })
    const builder = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '构建员', 'en-US': 'Builder' },
      description: { 'zh-CN': '准备构建', 'en-US': 'Prepares builds' },
      instructions: '',
      tools: { allow: ['read'] },
      permissions: 'read-only',
    })
    const checker = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '检查员', 'en-US': 'Checker' },
      description: { 'zh-CN': '跑检查', 'en-US': 'Runs checks' },
      instructions: '',
      tools: { allow: ['read'] },
      permissions: 'read-only',
    })
    const lead = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '流水线协调员', 'en-US': 'Pipeline lead' },
      description: { 'zh-CN': '编排固定阶段', 'en-US': 'Runs fixed stages' },
      instructions: '',
      tools: { allow: ['*'] },
      permissions: 'ask',
      delegation: {
        enabled: true,
        allowedAgents: [builder.agentId, checker.agentId],
        maxDepth: 1,
        maxChildrenPerTurn: 6,
        maxParallel: 2,
        childBudgetShare: 0.5,
        defaultWorkspace: 'shared',
        mergeReview: 'user',
      },
    })
    mock = await startMockModel({
      reply: '流水线结束',
      toolCallsByPrompt: {
        跑一条流水线: [
          {
            name: 'run_pipeline',
            arguments: {
              goal: '发布前检查',
              stages: [
                { stage: 'build', agent: builder.agentId },
                { stage: 'check', agent: checker.agentId, dependsOn: ['build'] },
                { stage: 'docs', agent: builder.agentId, dependsOn: ['check'] },
              ],
            },
          },
        ],
      },
      replyByPrompt: {
        'Stage build': '{"status":"completed","summary":"构建完成"}',
      },
      // `check` 的模型请求失败：阶段失败后 `docs` 不应开始。
      failByPrompt: { 'Stage check': true },
    })
    await configureModel(window, mock.baseUrl)
    const project = projectDir(userData)
    await createSession(window, project, '流水线会话')
    await setAgentOnSession(window, '流水线会话', { id: lead.agentId, version: lead.version })

    await sendPrompt(window, '跑一条流水线')
    const pipeline = window.getByRole('region', { name: '流水线', exact: true })
    await expect(pipeline).toBeVisible({ timeout: 60_000 })
    await expect(pipeline).toContainText('构建完成', { timeout: 60_000 })
    await expect(pipeline).toContainText('失败', { timeout: 60_000 })
    await expect(pipeline).toContainText('跳过：docs', { timeout: 60_000 })
    await expect(pipeline).not.toContainText('docs完成')
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 60_000 })
    // `docs` 从未启动：只有 build 与 check 两个子运行。
    const cards = window.getByRole('region', { name: '流水线', exact: true })
    await expect(cards.getByText('build')).toBeVisible({ timeout: 60_000 })
    await expect(cards.getByText('check')).toBeVisible({ timeout: 60_000 })
    await expect(cards.getByText('docs')).toHaveCount(1, { timeout: 60_000 })
  } finally {
    await mock?.close()
  }
})
