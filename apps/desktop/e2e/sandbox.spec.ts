/**
 * 命令沙箱（M5-05，ADR-0034）：设置页的档位、网络与能力状态，审批卡片上的实际档位，
 * 以及 Windows 上工作区可写、工作区外不可写的真实命令。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { chatRequests, createSession, projectDir, sendPrompt } from './session.js'

interface SandboxStatus {
  readonly mechanism: string
  readonly capability: { readonly available: boolean }
}

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

test('设置页：沙箱档位、网络、不可用行为与能力状态', async ({ launch, userData }) => {
  const { window } = await launch({ env: { CAIRN_RUNTIME: 'fake' } })
  await window.getByRole('button', { name: /^设置/ }).click()
  await expect(window.getByRole('heading', { name: '通用与外观' })).toBeVisible()
  await expect(window.getByRole('heading', { name: '命令沙箱' })).toBeVisible()

  const capability = window.getByTestId('sandbox-capability')
  await expect(capability).toBeVisible()
  await expect(capability).toHaveAttribute('data-sandbox-available', /^(true|false)$/)
  await expect(capability).toContainText(/网络：/)

  const profile = window.getByRole('radiogroup', { name: '默认档位' })
  await profile.getByRole('radio', { name: '只读' }).click()
  await expect(profile.getByRole('radio', { name: '只读' })).toHaveAttribute('aria-checked', 'true')
  await expect(window.getByText(/工作区不可写/)).toBeVisible()

  const network = window.getByRole('radiogroup', { name: '网络策略' })
  await network.getByRole('radio', { name: '公网' }).click()
  await expect(network.getByRole('radio', { name: '公网' })).toHaveAttribute('aria-checked', 'true')

  const unavailable = window.getByRole('radiogroup', { name: '沙箱不可用时' })
  await unavailable.getByRole('radio', { name: '每次询问' }).click()
  await expect(unavailable.getByRole('radio', { name: '每次询问' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  // 受限令牌机制不隔离网络，界面必须如实说明
  const status = await request<SandboxStatus>(window, 'sandbox.status', {})
  if (status.mechanism === 'restricted-token') {
    await expect(window.getByText(/受限令牌机制不能隔离网络/)).toBeVisible()
  }

  await expect
    .poll(() => {
      const saved = JSON.parse(
        readFileSync(path.join(userData, 'settings.json'), 'utf8'),
      ) as Record<string, unknown>
      return {
        profile: saved['sandboxProfile'],
        network: saved['sandboxNetwork'],
        unavailable: saved['sandboxUnavailable'],
      }
    })
    .toEqual({ profile: 'read-only', network: 'internet', unavailable: 'ask' })
})

test('审批卡片显示这条命令实际的沙箱档位', async ({ launch, userData }) => {
  const mock = await startMockModel({
    reply: 'command finished',
    toolCall: { name: 'run_command', arguments: { command: 'echo sandbox-e2e' } },
  })
  try {
    const { window } = await launch()
    await configureProvider(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '沙箱审批')
    await sendPrompt(window, '运行命令')

    const card = window.getByRole('article', { name: '需要审批：run_command' })
    await expect(card).toBeVisible()
    const panel = card.getByTestId('approval-sandbox')
    await expect(panel).toBeVisible()
    const badge = panel.getByTestId('sandbox-badge')
    const status = await request<SandboxStatus>(window, 'sandbox.status', {})
    await expect(badge).toHaveAttribute(
      'data-sandbox-enforced',
      String(status.capability.available),
    )
    await expect(badge).toHaveText(status.capability.available ? /^沙箱：/ : /^未沙箱化：/)

    await card.getByRole('button', { name: '运行一次' }).click()
    await expect(window.getByText('command finished')).toBeVisible()
  } finally {
    await mock.close()
  }
})

test('沙箱：工作区写入成功，工作区外写入被拒绝', async ({ launch, userData }) => {
  test.skip(process.platform !== 'win32', '命令沙箱目前只在 Windows 上生效')

  const outsideDir = path.join(userData, 'outside')
  mkdirSync(outsideDir, { recursive: true })
  const outside = path.join(outsideDir, 'escape.txt')
  const command = [
    "Set-Content -LiteralPath 'inside.txt' -Value ok -ErrorAction Stop",
    `Set-Content -LiteralPath '${outside.replaceAll("'", "''")}' -Value nope -ErrorAction Stop`,
  ].join('\n')
  const workspace = projectDir(userData)
  const mock = await startMockModel({
    reply: 'sandbox check done',
    toolCall: { name: 'run_command', arguments: { command } },
  })
  try {
    const { window } = await launch()
    const status = await request<SandboxStatus>(window, 'sandbox.status', {})
    test.skip(!status.capability.available, '当前机器的沙箱能力不可用')

    await configureProvider(window, mock.baseUrl)
    await createSession(window, workspace, '沙箱写入')
    await sendPrompt(window, '写入文件')

    const card = window.getByRole('article', { name: '需要审批：run_command' })
    await expect(card).toBeVisible()
    await expect(card.getByTestId('sandbox-badge')).toHaveAttribute('data-sandbox-enforced', 'true')
    await card.getByRole('button', { name: '运行一次' }).click()
    await expect(window.getByText('sandbox check done')).toBeVisible()

    expect(readFileSync(path.join(workspace, 'inside.txt'), 'utf8').trim()).toBe('ok')
    expect(existsSync(outside)).toBe(false)

    const chats = chatRequests(mock.requests)
    expect(chats).toHaveLength(2)
    const messages = (chats[1]?.messages ?? []) as { role: string }[]
    const toolMessages = messages.filter((message) => message.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('Exit code: 1')
  } finally {
    await mock.close()
  }
})
