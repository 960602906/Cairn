/**
 * M4 全流程联合验收（M4-15）：在同一个应用实例里串起 M4 的主要能力。
 *
 * 1. 父 Agent 并行委派内置 explorer / reviewer（只读、共享工作区）。
 * 2. 父 Agent 再委派内置 tester 在隔离工作区写测试文件；审批在活动中心就地完成。
 * 3. 从委派卡片打开改动集，按文件接受后主工作区出现测试文件，再用合并前检查点撤销。
 * 4. 检查器查看运行树、上下文快照与按 Agent 分组的用量。
 * 5. Agent 编辑器试运行草稿。
 * 6. 三个会话同时发送消息，各自完成且互不串会话。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { createSession, openSession, projectDir, runStatus, sendPrompt } from './session.js'

const REPLY = '全流程完成'
const TEST_FILE = 'flow.test.ts'
const ARTIFACTS_DIR =
  process.platform === 'win32' ? 'C:\\opt\\cursor\\artifacts' : '/opt/cursor/artifacts'

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

async function createCoordinator(window: Page): Promise<string> {
  const saved = await request<{ agentId: string }>(window, 'agent.saveDraft', {
    definition: {
      ...baseDraft,
      name: { 'zh-CN': '全流程协调员', 'en-US': 'Full-flow coordinator' },
      description: { 'zh-CN': 'M4 全流程', 'en-US': 'M4 full flow' },
      instructions: '',
      tools: { allow: ['*'] },
      permissions: 'ask',
      delegation: {
        enabled: true,
        allowedAgents: ['builtin.explorer', 'builtin.reviewer', 'builtin.tester'],
        maxDepth: 1,
        maxChildrenPerTurn: 3,
        maxParallel: 3,
        childBudgetShare: 0.5,
        defaultWorkspace: 'auto',
        mergeReview: 'user',
      },
    },
  })
  await request(window, 'agent.publish', { agentId: saved.agentId })
  return saved.agentId
}

test('M4 全流程：并行委派、隔离写入、审批、改动集、检查器、试运行与多会话', async ({
  launch,
  userData,
}) => {
  const mock = await startMockModel({
    reply: REPLY,
    parallelToolCalls: [
      {
        name: 'delegate',
        arguments: {
          agent: 'builtin.explorer',
          task: '定位入口文件',
          brief: { goal: '定位入口文件', deliverable: '文件与行号' },
          workspace: 'shared',
        },
      },
      {
        name: 'delegate',
        arguments: {
          agent: 'builtin.reviewer',
          task: '检查入口风险',
          brief: { goal: '检查入口风险', deliverable: '一句话结论' },
          workspace: 'shared',
        },
      },
    ],
    toolCallsByPrompt: {
      写测试: [
        {
          name: 'delegate',
          arguments: {
            agent: 'builtin.tester',
            task: '写入测试文件',
            brief: { goal: '补一个测试文件', deliverable: '测试文件路径' },
            workspace: 'isolated',
          },
        },
      ],
      补一个测试文件: [
        {
          name: 'write_file',
          arguments: {
            path: TEST_FILE,
            content:
              "import { expect, it } from 'vitest'\n\nit('works', () => {\n  expect(1).toBe(1)\n})\n",
          },
        },
      ],
    },
  })
  try {
    const { window } = await launch()
    await configureModel(window, mock.baseUrl)
    await createCoordinator(window)

    const dir = projectDir(userData)
    const testFile = path.join(dir, TEST_FILE)
    writeFileSync(path.join(dir, 'app.ts'), 'export const answer = 42\n')
    mkdirSync(ARTIFACTS_DIR, { recursive: true })

    await createSession(window, dir, 'M4 全流程')
    await window.getByRole('button', { name: /^Agent：/ }).click()
    const agents = window.getByRole('listbox', { name: '选择 Agent' })
    await agents.getByRole('option', { name: /全流程协调员/ }).click()

    await sendPrompt(window, '并行检查')
    const explorer = window.getByRole('article', { name: /委派任务：定位入口文件/ })
    const reviewer = window.getByRole('article', { name: /委派任务：检查入口风险/ })
    await expect(explorer).toBeVisible({ timeout: 30_000 })
    await expect(reviewer).toBeVisible()
    await expect(explorer.getByText('完成', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(reviewer.getByText('完成', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })

    await sendPrompt(window, '写测试')
    const pendingApprovals = window.getByRole('region', { name: '待审批' })
    await expect(
      pendingApprovals.getByRole('article', { name: '需要审批：delegate' }),
    ).toBeVisible()
    await pendingApprovals.getByRole('button', { name: '允许一次' }).click()

    const tester = window.getByRole('article', { name: /委派任务：写入测试文件/ })
    await expect(tester).toBeVisible({ timeout: 30_000 })
    await expect(tester.getByRole('button', { name: '允许一次' })).toBeVisible({
      timeout: 30_000,
    })

    await window.getByRole('button', { name: /活动，\d+ 个待审批/ }).click()
    await expect(window.getByRole('heading', { level: 2, name: '活动', exact: true })).toBeVisible()
    const pending = window.getByRole('article', { name: /M4 全流程 · write_file 的审批/ })
    await expect(pending).toBeVisible()
    await pending.getByRole('button', { name: '允许一次' }).click()
    await expect(pending).toHaveCount(0)

    await openSession(window, 'M4 全流程')
    await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })
    expect(existsSync(testFile)).toBe(false)

    await tester.getByRole('button', { name: /查看改动/ }).click()
    const review = window
      .getByRole('complementary', { name: '会话信息' })
      .getByRole('region', { name: '改动集审阅' })
    await expect(review).toBeVisible({ timeout: 15_000 })
    await expect(review.getByText('1 个文件')).toBeVisible()
    await review.getByRole('button', { name: new RegExp(`^${TEST_FILE}`) }).click()
    await expect(review.getByRole('figure', { name: `差异：${TEST_FILE}` })).toBeVisible()
    await review.getByRole('button', { name: '接受此文件' }).click()
    await expect(review.getByText('已合并')).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(testFile, 'utf8')).toContain("it('works'")

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
    await review.screenshot({ path: path.join(ARTIFACTS_DIR, 'm4-full-flow-changeset-light.png') })
    await setTheme('dark')
    await review.screenshot({ path: path.join(ARTIFACTS_DIR, 'm4-full-flow-changeset-dark.png') })
    await setTheme('light')

    await review.getByRole('button', { name: /撤销这次合并/ }).click()
    const dialog = window.getByRole('dialog', { name: '撤销这次合并？' })
    await dialog.getByRole('button', { name: '撤销这次合并' }).click()
    await expect(review.getByText('已恢复到合并前的检查点。')).toBeVisible({ timeout: 15_000 })
    expect(existsSync(testFile)).toBe(false)

    const sidePanel = window.getByRole('complementary', { name: '会话信息' })
    await sidePanel.getByRole('tab', { name: '检查器' }).click()
    const timeline = window.getByRole('tabpanel', { name: '时间线' })
    await expect(timeline.getByRole('list', { name: '运行树' })).toBeVisible()
    await expect(timeline.getByText('全流程协调员').first()).toBeVisible()
    await expect(timeline.getByText('代码探索员').first()).toBeVisible()
    await expect(timeline.getByText('代码审查员').first()).toBeVisible()
    await expect(timeline.getByText('测试补全员').first()).toBeVisible()
    await window.getByRole('tab', { name: '上下文' }).click()
    await expect(window.getByText('系统提示词各部分')).toBeVisible()
    await window.getByRole('tab', { name: '用量' }).click()
    await expect(window.getByText('按 Agent 分组')).toBeVisible()

    await window.getByRole('button', { name: '设置' }).click()
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '项目' })
      .click()
    await window.getByRole('button', { name: '返回对话' }).click()

    await window.getByRole('button', { name: 'Agents' }).click()
    await window.getByRole('button', { name: '基于编程助手复制' }).click()
    await window.getByRole('button', { name: '试运行', exact: true }).click()
    const trial = window.getByRole('complementary', { name: '试运行' })
    await expect(trial).toBeVisible()
    await trial.getByLabel('项目').selectOption(dir)
    await trial.getByRole('button', { name: '开始试运行' }).click()
    await trial.getByLabel('试运行输入').fill('验证全流程草稿')
    await trial.getByRole('button', { name: '发送' }).click()
    await expect(trial.getByText(REPLY)).toBeVisible()

    for (const title of ['并行甲', '并行乙', '并行丙']) {
      await createSession(window, dir, title)
      await sendPrompt(window, title)
    }
    for (const title of ['并行甲', '并行乙', '并行丙']) {
      await openSession(window, title)
      await expect(window.getByText(REPLY, { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      })
      await expect(runStatus(window)).toHaveText('空闲', { timeout: 30_000 })
    }
  } finally {
    await mock.close()
  }
})
