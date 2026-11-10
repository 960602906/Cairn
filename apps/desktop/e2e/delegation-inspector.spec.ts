/**
 * 多 Agent 委派界面（M4-05）：父运行并行派出两个只读子运行，对话里显示委派卡片；
 * 检查器显示运行树，打开子运行后可返回父运行。
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

test('并行子运行的委派卡片与运行树', async ({ launch, userData }) => {
  let mock: Awaited<ReturnType<typeof startMockModel>> | undefined
  try {
    const { window } = await launch()
    await window.evaluate(async () => {
      const cairn = (globalThis as unknown as { cairn: { ready(): Promise<unknown> } }).cairn
      await cairn.ready()
    })
    const child = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '只读检查员', 'en-US': 'Read-only reviewer' },
      description: { 'zh-CN': '只读检查', 'en-US': 'Read-only review' },
      instructions: '',
      tools: { allow: ['read'] },
      permissions: 'read-only',
    })
    const lead = await createAgent(window, {
      ...baseDraft,
      name: { 'zh-CN': '委派协调员', 'en-US': 'Delegation lead' },
      description: { 'zh-CN': '并行委派', 'en-US': 'Delegates in parallel' },
      instructions: '',
      tools: { allow: ['*'] },
      permissions: 'ask',
      delegation: {
        enabled: true,
        allowedAgents: [child.agentId],
        maxDepth: 1,
        maxChildrenPerTurn: 2,
        maxParallel: 2,
        childBudgetShare: 0.5,
        defaultWorkspace: 'shared',
        mergeReview: 'user',
      },
    })
    mock = await startMockModel({
      reply: '父运行完成',
      parallelToolCalls: [
        {
          name: 'delegate',
          arguments: {
            agent: child.agentId,
            task: '检查登录流程',
            brief: { goal: '检查登录流程', deliverable: '一句话结论' },
            workspace: 'shared',
          },
        },
        {
          name: 'delegate',
          arguments: {
            agent: child.agentId,
            task: '检查权限规则',
            brief: { goal: '检查权限规则', deliverable: '一句话结论' },
            workspace: 'shared',
          },
        },
      ],
    })
    await configureModel(window, mock.baseUrl)
    const project = projectDir(userData)
    await createSession(window, project, '委派会话')
    await setAgentOnSession(window, '委派会话', { id: lead.agentId, version: lead.version })

    await sendPrompt(window, '并行检查')
    await expect(window.getByRole('article', { name: /委派任务：检查登录流程/ })).toBeVisible({
      timeout: 30_000,
    })
    await expect(window.getByRole('article', { name: /委派任务：检查权限规则/ })).toBeVisible()
    await expect(
      window.getByRole('list', { name: '消息' }).getByText('父运行完成').first(),
    ).toBeVisible({ timeout: 30_000 })
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })

    const panelToggle = window.getByRole('button', { name: '会话信息', exact: true })
    if ((await panelToggle.getAttribute('aria-expanded')) !== 'true') await panelToggle.click()
    await window.getByRole('tab', { name: '检查器' }).click()
    const panel = window.getByRole('tabpanel', { name: '时间线' })
    await expect(panel.getByRole('list', { name: '运行树' })).toBeVisible()
    await expect(panel.getByText('只读检查员').first()).toBeVisible()
    await panel.getByRole('button', { name: '打开子运行' }).first().click()
    const inspector = window.getByRole('complementary', { name: '会话信息' })
    await expect(inspector.getByRole('button', { name: '返回父运行' })).toBeVisible()
    await inspector.getByRole('button', { name: '返回父运行' }).click()
    await expect(panel.getByRole('button', { name: '打开子运行' }).first()).toBeVisible()
  } finally {
    await mock?.close()
  }
})
