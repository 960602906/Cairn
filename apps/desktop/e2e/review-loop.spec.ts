/**
 * 审查循环（M7-07）：父运行调用 `review_loop`，maker 产出、checker 判定通过后结束；
 * 对话里出现审查循环卡片与轮次结局，运行回到空闲。
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

test('maker 通过 checker 审查后显示审查循环卡片', async ({ launch, userData }) => {
  let mock: Awaited<ReturnType<typeof startMockModel>> | undefined
  try {
    const { window } = await launch()
    await window.evaluate(async () => {
      const cairn = (globalThis as unknown as { cairn: { ready(): Promise<unknown> } }).cairn
      await cairn.ready()
    })
    const maker = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '起草员', 'en-US': 'Maker' },
      description: { 'zh-CN': '写初稿', 'en-US': 'Writes drafts' },
      instructions: '',
      tools: { allow: ['read'] },
      permissions: 'read-only',
    })
    const checker = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '审查员', 'en-US': 'Checker' },
      description: { 'zh-CN': '审查初稿', 'en-US': 'Reviews drafts' },
      instructions: '',
      tools: { allow: ['read'] },
      permissions: 'read-only',
    })
    const lead = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '审查协调员', 'en-US': 'Review lead' },
      description: { 'zh-CN': '编排审查循环', 'en-US': 'Runs review loops' },
      instructions: '',
      tools: { allow: ['*'] },
      permissions: 'ask',
      delegation: {
        enabled: true,
        allowedAgents: [maker.agentId, checker.agentId],
        maxDepth: 1,
        maxChildrenPerTurn: 6,
        maxParallel: 2,
        childBudgetShare: 0.5,
        defaultWorkspace: 'shared',
        mergeReview: 'user',
      },
    })
    mock = await startMockModel({
      reply: '审查完成',
      toolCallsByPrompt: {
        做一次审查: [
          {
            name: 'review_loop',
            arguments: {
              goal: '写一份说明',
              maker: maker.agentId,
              checker: checker.agentId,
            },
          },
        ],
      },
      // checker 的提示词里也带着 goal；最长的键优先，所以 checker 拿到判定，maker 拿到草案。
      replyByPrompt: {
        'Review whether the maker result':
          '{"status":"completed","summary":"通过","output":{"verdict":"pass"}}',
        写一份说明: '{"status":"completed","summary":"草案完成"}',
      },
    })
    await configureModel(window, mock.baseUrl)
    const project = projectDir(userData)
    await createSession(window, project, '审查会话')
    await setAgentOnSession(window, '审查会话', { id: lead.agentId, version: lead.version })

    await sendPrompt(window, '做一次审查')
    const loop = window.getByRole('region', { name: '审查循环' })
    await expect(loop).toBeVisible({ timeout: 30_000 })
    await expect(loop).toContainText('已通过')
    await expect(loop).toContainText('1 轮')
    await expect(loop).toContainText('第 1 轮')
    await expect(loop).toContainText('草案完成')
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })
  } finally {
    await mock?.close()
  }
})
