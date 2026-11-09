/**
 * M3 全流程联合验收（M3-14）：同一个会话里串起自定义 Agent、Skill、MCP 工具、计划模式、
 * 上下文压缩与按块撤销。
 *
 * 1. 安装一个 Skill，接入一个真实的 stdio MCP 服务（仓库内的 fixture）。
 * 2. 复制内置编程助手、改指令并发布，在输入框的 Agent 选择器里选中它。
 * 3. 第一轮：mock 模型调用 write_file → 审批 → 撤销本轮。
 * 4. 第二轮：mock 模型调用 MCP 工具 → 审批 → 结果交回模型。
 * 5. 第三轮：计划模式提出计划 → 批准执行。
 * 6. 之后连续长对话触发压缩，分隔线可见，会话仍能继续。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import {
  chatRequests,
  createSession,
  projectDir,
  runStatus,
  sendPrompt,
  setAgentOnSession,
} from './session.js'

const INSTRUCTIONS = 'You are the M3 full-flow agent. Keep answers short.'
const REPLY = 'm3 flow reply'
const SUMMARY = 'm3 flow summary'
const fixture = fileURLToPath(
  new URL('../../../packages/mcp/src/testing/fixture-server.mjs', import.meta.url),
)

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

test('自定义 Agent、Skill、MCP、计划模式、压缩与撤销在同一会话里走通', async ({
  launch,
  userData,
}) => {
  const mock = await startMockModel({
    reply: REPLY,
    summary: SUMMARY,
    // 按本轮用户输入选择脚本：写文件、调用 MCP 工具、计划模式提出计划各一轮。
    toolCallsByPrompt: {
      写一个文件: [{ name: 'write_file', arguments: { path: 'flow.md', content: 'flow\n' } }],
      '用 MCP 的 echo 工具': [{ name: 'mcp_flowfixture_echo', arguments: { text: 'hi' } }],
      // 提出计划后，批准执行会把步骤标题作为新的用户消息发出，用一条步骤更新让它收尾。
      '给 flow.md 加标题': [
        {
          name: 'propose_plan',
          arguments: {
            goal: '给 flow.md 加标题',
            files: ['flow.md'],
            steps: [{ id: 'title', title: '加标题' }],
            risks: '',
            verification: '读文件',
            markdown: '1. 加标题',
          },
        },
      ],
      '1. 加标题': [{ name: 'update_plan_step', arguments: { stepId: 'title', status: 'done' } }],
    },
  })
  const skillSource = path.join(userData, 'skill-src', 'flow-skill')
  mkdirSync(skillSource, { recursive: true })
  writeFileSync(
    path.join(skillSource, 'SKILL.md'),
    '---\nname: flow-skill\ndescription: Skill used by the M3 full flow test.\n---\nbody\n',
  )

  try {
    const { window } = await launch()
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
                contextWindow: 4_000,
                maxOutputTokens: 200,
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

    // 安装 Skill（先预览，再确认）
    await request(window, 'skill.install', { source: { kind: 'directory', path: skillSource } })
    await request(window, 'skill.install', {
      source: { kind: 'directory', path: skillSource },
      confirm: true,
    })

    // 接入真实的 stdio MCP 服务
    const server = await request<{ serverId: string; status: string; tools: { name: string }[] }>(
      window,
      'mcp.add',
      {
        name: 'FlowFixture',
        kind: 'stdio',
        command: process.execPath,
        args: [fixture],
      },
    )
    expect(server.status).toBe('connected')
    expect(server.tools.map((tool) => tool.name)).toContain('mcp_flowfixture_echo')

    // 复制编程助手 → 改指令 → 发布
    const duplicated = await request<{ agentId: string }>(window, 'agent.duplicate', {
      agentId: 'builtin.coder',
      name: { 'zh-CN': 'M3 全流程助手', 'en-US': 'M3 Flow Agent' },
    })
    const current = await request<{ draft: Record<string, unknown> }>(window, 'agent.get', {
      agentId: duplicated.agentId,
    })
    await request(window, 'agent.saveDraft', {
      definition: { ...current.draft, id: duplicated.agentId, instructions: INSTRUCTIONS },
    })
    const published = await request<{ published?: { version: number } }>(window, 'agent.publish', {
      agentId: duplicated.agentId,
    })

    const project = projectDir(userData)
    await createSession(window, project, 'M3 全流程')

    // Agent 选择器已移除；直接给会话指定刚发布的 Agent
    await window.reload()
    await window
      .getByRole('navigation', { name: '会话' })
      .getByRole('button', { name: 'M3 全流程' })
      .click()
    await setAgentOnSession(window, 'M3 全流程', {
      id: duplicated.agentId,
      version: published.published?.version ?? 1,
    })

    // 第一轮：写文件 → 审批 → 撤销本轮
    await sendPrompt(window, '写一个文件')
    const writeCard = window.getByRole('region', { name: '调用工具：write_file' })
    await expect(writeCard).toContainText('flow.md')
    await window.getByRole('button', { name: '允许一次' }).click()
    await expect(window.getByText(REPLY).first()).toBeVisible({ timeout: 20_000 })
    await expect(runStatus(window)).toHaveText('空闲')

    await window.getByRole('button', { name: '撤销本轮' }).click()
    const undo = window.getByRole('dialog', { name: '撤销第 1 轮的改动？' })
    await expect(undo.getByRole('list', { name: '受影响的文件' })).toHaveText('flow.md删除')
    await undo.getByRole('button', { name: '撤销 1 个文件' }).click()
    await expect(window.getByText(/^已撤销到第 1 轮开始之前/)).toBeVisible()

    // 第二轮：MCP 工具 → 审批
    await sendPrompt(window, '用 MCP 的 echo 工具')
    const mcpCard = window.getByRole('article', { name: '需要审批：mcp_flowfixture_echo' })
    await expect(mcpCard).toBeVisible()
    await expect(runStatus(window)).toHaveText('等待审批')
    await mcpCard.getByRole('button', { name: '允许一次' }).click()
    await expect(window.getByText(REPLY).last()).toBeVisible({ timeout: 20_000 })
    await expect(runStatus(window)).toHaveText('空闲')

    // 第三轮：计划模式 → 提出计划 → 批准
    const planToggle = window.getByRole('button', { name: '计划模式' })
    await planToggle.click()
    await expect(planToggle).toHaveAttribute('aria-pressed', 'true')
    await sendPrompt(window, '给 flow.md 加标题')
    const approve = window.getByRole('button', { name: '批准执行' })
    await expect(approve).toBeEnabled({ timeout: 20_000 })
    await approve.click()
    // 步骤进度显示在右侧栏的完整计划里（与 plan-mode.spec.ts 一致）。
    const planSummary = window.getByRole('button', { name: '查看完整计划：给 flow.md 加标题' })
    await expect(planSummary).toBeVisible({ timeout: 20_000 })
    await planSummary.click()
    await expect(window.getByText('已完成')).toBeVisible({ timeout: 20_000 })
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 20_000 })
    await planToggle.click()

    // 之后连续长对话触发压缩，分隔线可见
    const long = 'please remember this goal. '.repeat(300)
    const replies = window.getByText(REPLY, { exact: true })
    const before = await replies.count()
    await sendPrompt(window, `${long}four`)
    await expect(replies).toHaveCount(before + 1, { timeout: 30_000 })
    await expect(runStatus(window)).toHaveText('空闲')

    const divider = window.getByRole('button', { name: /较早的对话已压缩/ })
    await expect(divider).toBeVisible({ timeout: 20_000 })
    await divider.click()
    await expect(window.getByText(SUMMARY)).toBeVisible()

    // 模型请求里带上了自定义 Agent 的指令与 MCP 工具结果
    const chats = chatRequests(mock.requests)
    const all = JSON.stringify(chats)
    expect(all).toContain(INSTRUCTIONS)
    expect(all).toContain('echo:hi')

    await request(window, 'mcp.remove', { serverId: server.serverId })
  } finally {
    await mock.close()
  }
})
