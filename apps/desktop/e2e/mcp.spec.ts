/**
 * MCP（M3-09）：添加一个真实的 stdio MCP 服务，mock 模型调用它的工具，审批后把结果交回模型。
 */
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, createSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = 'done after the MCP tool'
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

test('添加 MCP 服务后，mock 模型调用其工具并得到审批后的结果', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: REPLY,
    toolCall: { name: 'mcp_fixture_echo', arguments: { text: 'hi' } },
  })
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

    const added = await request<{
      serverId: string
      status: string
      tools: { name: string; originalName: string }[]
    }>(window, 'mcp.add', {
      name: 'Fixture',
      kind: 'stdio',
      command: process.execPath,
      args: [fixture],
    })
    // 添加不等连接结果（立即返回“连接中”），这里等它连上
    await expect
      .poll(
        async () =>
          (
            await request<{ status: string; tools: { name: string }[] }>(window, 'mcp.get', {
              serverId: added.serverId,
            })
          ).tools.map((tool) => tool.name),
        { timeout: 20_000 },
      )
      .toContain('mcp_fixture_echo')

    await createSession(window, projectDir(userData), 'MCP')
    await sendPrompt(window, '用 MCP 的 echo 工具')

    const card = window.getByRole('article', { name: '需要审批：mcp_fixture_echo' })
    await expect(card).toBeVisible()
    await expect(runStatus(window)).toHaveText('等待审批')
    await expect(card.getByText('原因: 第三方工具需要审批')).toBeVisible()
    await card.getByRole('button', { name: '允许一次' }).click()
    await expect(window.getByText(REPLY.trim())).toBeVisible()
    await expect(runStatus(window)).toHaveText('空闲')

    const chats = chatRequests(mock.requests)
    expect(chats).toHaveLength(2)
    const messages = (chats[1]?.messages ?? []) as { role: string; content: unknown }[]
    expect(JSON.stringify(messages.filter((message) => message.role === 'tool'))).toContain(
      'echo:hi',
    )

    await request(window, 'mcp.remove', { serverId: added.serverId })
  } finally {
    await mock.close()
  }
})
