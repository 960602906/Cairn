/**
 * 目标模式（ADR-0047）：mock 模型跑通「/goal 创建 → 独立判定 → 达成 / 不可能 / 暂停恢复」的界面链路。
 *
 * 判定调用和主模型共用同一个 OpenAI 兼容端点，用 `replyByPrompt` 按证据包首行
 * `# Goal evaluation` 匹配判定输出；主模型用 `toolCalls`（顺序脚本）或 `reply` 兜底。
 * 达成需要一条非历史判定证据，这里让主模型先 `write_file` 出 `app.txt`，判定再引用 `file:app.txt`。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { ofType, readEvents } from './database.js'
import { createSession, openSession, projectDir, rpc, sendPrompt } from './session.js'

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
}

/** 配置本地供应商并放开写工具审批，避免 `write_file` 打断目标循环。 */
async function configure(window: Page, baseUrl: string) {
  await window.evaluate(
    async ({ baseUrl, capabilities }) => {
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
            baseUrl,
            models: [{ id: 'e2e-model', ...capabilities }],
          },
        ],
        defaultModel: { providerId: 'local', modelId: 'e2e-model' },
        permissionMode: 'full-access',
      })
    },
    { baseUrl, capabilities },
  )
  await window.reload()
}

// write_file 产生 `file.changed`（相对路径 app.txt），判定证据引用 `file:app.txt`。
const writeFile = [{ name: 'write_file', arguments: { path: 'app.txt', content: 'done\n' } }]

const pauseButton = (window: Page) => window.getByRole('button', { name: '暂停目标' })
const resumeButton = (window: Page) => window.getByRole('button', { name: '继续目标' })
const endedCard = (window: Page) => window.getByRole('region', { name: '目标结果' })

test('目标模式：达成后显示结果卡', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '写好了。',
    // 顺序工具脚本按 chatIndex 推进，只命中主模型的第一轮；判定请求走 `replyByPrompt`，
    // 不会被工具脚本抢走（`toolCallsByPrompt` 会按条件匹配到判定请求本身）。
    toolCalls: writeFile,
    replyByPrompt: {
      '# Goal evaluation':
        '{"verdict":"met","reason":"文件已写好","evidence":[{"kind":"file","ref":"file:app.txt"}]}',
    },
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '目标')
    await sendPrompt(window, '/goal 写一个文件')

    const card = endedCard(window)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('目标已达成')
    await expect(card).toContainText('写一个文件')

    // 结果卡的「查看目标」必须真正打开面板，并带出判定记录。
    // 会话标题也是「目标」，不能用同名 region 断言面板；用判定区与证据说明定位。
    await card.getByRole('button', { name: '查看目标' }).click()
    await expect(window.getByRole('region', { name: '判定记录' })).toBeVisible()
    await expect(window.getByText(/判定只依据应用内的对话/)).toBeVisible()
  } finally {
    await mock.close()
  }
})

test('目标模式：判定不可能后结束', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '做不到。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"impossible","reason":"条件互相矛盾"}',
    },
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '目标')
    await sendPrompt(window, '/goal 让 1 等于 2')

    const card = endedCard(window)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('条件无法满足')
  } finally {
    await mock.close()
  }
})

test('目标模式：暂停后恢复', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  // 暂停在首轮判定前发生，判定根本不会跑；恢复后只需目标重新 active，不依赖判定结果。
  const mock = await startMockModel({
    reply: '还在做。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"not_met","reason":"还没做完"}',
    },
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '目标')
    await sendPrompt(window, '/goal 完成重构')

    // 暂停不中止当前轮：点暂停后，当前轮跑完不再判定、不再续轮。
    await expect(pauseButton(window)).toBeVisible({ timeout: 20_000 })
    await pauseButton(window).click()
    const resume = resumeButton(window)
    await expect(resume).toBeVisible()
    // 等当前轮结束、会话空闲，「继续目标」从禁用变为可用。
    await expect(resume).toBeEnabled({ timeout: 30_000 })

    await resume.click()
    await expect(pauseButton(window)).toBeVisible({ timeout: 30_000 })
  } finally {
    await mock.close()
  }
})

test('目标模式：重启后目标暂停', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '还在做。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"not_met","reason":"还没做完"}',
    },
  })
  const first = await launch()
  try {
    await configure(first.window, mock.baseUrl)
    await createSession(first.window, projectDir(userData), '目标')
    await sendPrompt(first.window, '/goal 完成重构')
    await expect(pauseButton(first.window)).toBeVisible({ timeout: 20_000 })
  } finally {
    await first.close()
    await mock.close()
  }

  const second = await launch()
  try {
    await openSession(second.window, '目标')
    // 目标仍 active 时退出：重启扫描把它暂停为 restart，显示「继续目标」而不是自动续跑。
    await expect(resumeButton(second.window)).toBeVisible({ timeout: 20_000 })
  } finally {
    await second.close()
  }

  const events = readEvents(userData)
  expect(ofType(events, 'goal.paused').some((event) => event.payload['reason'] === 'restart')).toBe(
    true,
  )
})

test('目标模式：预算耗尽后结束', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '还在做。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"not_met","reason":"还没做完"}',
    },
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    const sessionId = await createSession(window, projectDir(userData), '目标')
    // v1 界面只用默认预算，这里直接用 IPC 设 maxTurns=1 触发预算耗尽。
    await rpc(window, 'goal.set', { sessionId, condition: '测试全部通过', maxTurns: 1 })

    const card = endedCard(window)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('预算耗尽')
  } finally {
    await mock.close()
  }
})

test('目标模式：回退后暂停', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '还在做。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"not_met","reason":"还没做完"}',
    },
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '目标')
    await sendPrompt(window, '/goal 完成重构')

    // 第一轮回复出来即可重新生成；回退把仍活动的目标暂停为 rewind。
    // 判定为 not_met 会自动续轮，多轮后每轮都有一个「重新生成」按钮；取最早那轮。
    const regenerate = window.getByRole('button', { name: '重新生成' }).first()
    await expect(regenerate).toBeVisible({ timeout: 20_000 })
    await regenerate.click()
    const dialog = window.getByRole('dialog', { name: '回退这段对话？' })
    await dialog.getByRole('button', { name: '回退并重新开始' }).click()

    await expect(resumeButton(window)).toBeVisible({ timeout: 20_000 })
    // 细条上只显示「已暂停」，回退原因在状态文字的提示里。
    await expect(window.getByTitle('对话已回退')).toBeVisible()
  } finally {
    await mock.close()
  }
})

test('目标模式：判定中暂停后恢复', async ({ launch, userData }) => {
  test.setTimeout(120_000)
  const mock = await startMockModel({
    reply: '还在做。',
    replyByPrompt: {
      '# Goal evaluation': '{"verdict":"not_met","reason":"还没做完"}',
    },
    // 判定延迟 1 秒，留出「判定中」窗口暂停；暂停不中止判定，但过期判定被丢弃。
    delayByPrompt: {
      '# Goal evaluation': 1000,
    },
  })
  try {
    const { window } = await launch()
    await configure(window, mock.baseUrl)
    await createSession(window, projectDir(userData), '目标')
    await sendPrompt(window, '/goal 完成重构')

    // 第一轮回复出来 → 进入判定中（判定被延迟，还没返回）。
    await expect(window.getByText('还在做。')).toBeVisible({ timeout: 20_000 })
    await window.waitForTimeout(200)
    await pauseButton(window).click()
    await expect(resumeButton(window)).toBeVisible({ timeout: 20_000 })

    // 等判定延迟过去：过期判定被丢弃，目标仍暂停、不自动续轮。
    await window.waitForTimeout(1500)
    await expect(resumeButton(window)).toBeVisible()
    await expect(pauseButton(window)).toHaveCount(0)

    // 恢复后回到 active。
    await resumeButton(window).click()
    await expect(pauseButton(window)).toBeVisible({ timeout: 30_000 })
  } finally {
    await mock.close()
  }
})
