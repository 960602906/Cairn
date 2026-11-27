/**
 * 团队模板试运行（M7-09）：在草稿状态开一个隐藏会话，以主控 Agent 的草稿运行，
 * 模板的委派覆盖与协作说明并入这一轮的定义。
 *
 * 覆盖：从模板选择（保存草稿 → 发布 → 开始试运行）到 review-loop 完成；非法模板被拒绝；
 * 版本回退后重新开始试运行行为一致；试运行会话不出现在会话列表、可整体清理。
 */
import type { Page } from '@playwright/test'
import { startMockModel } from '../scripts/mock-model.js'
import { expect, test } from './app.js'
import { projectDir } from './session.js'

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string } }

async function send<T>(window: Page, method: string, params: object): Promise<T> {
  const reply = (await window.evaluate(
    async ([m, p]) => {
      const cairn = (
        globalThis as unknown as { cairn: { request(m: string, p: object): Promise<unknown> } }
      ).cairn
      return cairn.request(m as string, p as object)
    },
    [method, params] as const,
  )) as Reply
  if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result as T
}

async function tryCall(window: Page, method: string, params: object): Promise<Reply> {
  return (await window.evaluate(
    async ([m, p]) => {
      const cairn = (
        globalThis as unknown as { cairn: { request(m: string, p: object): Promise<unknown> } }
      ).cairn
      return cairn.request(m as string, p as object)
    },
    [method, params] as const,
  )) as Reply
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

async function createAgent(window: Page, draft: Record<string, unknown>) {
  const saved = await send<{ agentId: string }>(window, 'agent.saveDraft', { definition: draft })
  const published = await send<{ published?: { version: number } }>(window, 'agent.publish', {
    agentId: saved.agentId,
  })
  return { agentId: saved.agentId, version: published.published?.version ?? 1 }
}

/**
 * 向试运行会话发一轮输入，等这一轮结束，返回关键事件的类型与审查结论。
 * 试运行会话不出现在界面上，所以直接订阅会话事件。
 */
async function runTrialTurn(window: Page, sessionId: string, prompt: string) {
  return window.evaluate(
    async ({ id, text }) => {
      const cairn = (
        globalThis as unknown as {
          cairn: {
            ready(): Promise<unknown>
            request(
              m: string,
              p: object,
            ): Promise<{ ok: boolean; result?: unknown; error?: unknown }>
            on(name: string, listener: (data: unknown) => void): () => void
          }
        }
      ).cairn
      await cairn.ready()
      const types: string[] = []
      const review: unknown[] = []
      let rootRunId: string | undefined
      let finished = false
      const stop = cairn.on('session.events', (data) => {
        const frame = data as { sessionId: string; events: { type: string; payload: unknown }[] }
        if (frame.sessionId !== id) return
        for (const event of frame.events) {
          types.push(event.type)
          const envelope = event as { type: string; runId: string; payload: unknown }
          if (envelope.type === 'run.created' && rootRunId === undefined) {
            rootRunId = envelope.runId
          }
          // 子运行也会发 turn.completed；只等根运行这一轮结束。
          if (
            envelope.runId === rootRunId &&
            (envelope.type === 'turn.completed' ||
              envelope.type === 'turn.aborted' ||
              envelope.type === 'turn.failed')
          ) {
            finished = true
          }
          if (envelope.type === 'team.review.completed') review.push(envelope.payload)
        }
      })
      const subscribed = await cairn.request('session.subscribe', { sessionId: id, afterSeq: 0 })
      if (subscribed.ok) {
        for (const event of (subscribed.result as { events: { type: string }[] }).events) {
          types.push(event.type)
        }
      }
      const sent = await cairn.request('session.prompt', {
        sessionId: id,
        content: [{ type: 'text', text }],
      })
      if (!sent.ok) throw new Error(`session.prompt: ${JSON.stringify(sent.error)}`)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !finished) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      stop()
      await cairn.request('session.unsubscribe', { sessionId: id })
      return { types, review }
    },
    { id: sessionId, text: prompt },
  )
}

test('从团队模板开始试运行，审查循环跑通且会话保持隐藏', async ({ launch, userData }) => {
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
        跑一次审查: [
          {
            name: 'review_loop',
            arguments: { goal: '写一份说明', maker: maker.agentId, checker: checker.agentId },
          },
        ],
      },
      replyByPrompt: {
        'Review whether the maker result':
          '{"status":"completed","summary":"通过","output":{"verdict":"pass"}}',
        写一份说明: '{"status":"completed","summary":"草案完成"}',
      },
    })
    await configureModel(window, mock.baseUrl)
    const project = projectDir(userData)

    const definition = {
      name: { 'zh-CN': '审查小组', 'en-US': 'Review crew' },
      description: { 'zh-CN': 'maker 写、checker 审', 'en-US': 'Maker then checker' },
      coordinator: lead.agentId,
      members: [maker.agentId, checker.agentId],
      pattern: 'review-loop' as const,
      reviewLoop: { maker: maker.agentId, checker: checker.agentId, maxRounds: 2 },
    }
    // 模板先以草稿存在：发布前就能试运行。
    const saved = await send<{ teamId: string; validation: { ok: boolean } }>(
      window,
      'team.saveDraft',
      { definition },
    )
    expect(saved.validation.ok).toBe(true)
    const first = await send<{ sessionId: string; teamId: string; teamDraftHash: string }>(
      window,
      'team.trial.start',
      { teamId: saved.teamId, projectPath: project },
    )
    expect(first.teamId).toBe(saved.teamId)

    const turn = await runTrialTurn(window, first.sessionId, '跑一次审查')
    expect(turn.types).toContain('team.review.round')
    expect(turn.review).toEqual([expect.objectContaining({ status: 'passed', rounds: 1 })])

    // 试运行不出现在会话列表，也不占主控 Agent 自己的试运行历史。
    const sessions = await send<{ sessions: { sessionId: string }[] }>(window, 'session.list', {})
    expect(sessions.sessions.map((session) => session.sessionId)).not.toContain(first.sessionId)
    const agentTrials = await send<{ trials: { sessionId: string }[] }>(window, 'trial.list', {
      agentId: lead.agentId,
    })
    expect(agentTrials.trials).toEqual([])

    // 发布后草稿清空：没有草稿时不能再开始试运行。
    const published = await send<{ published?: { version: number } }>(window, 'team.publish', {
      teamId: saved.teamId,
    })
    expect(published.published?.version).toBe(1)
    const noDraft = await tryCall(window, 'team.trial.start', {
      teamId: saved.teamId,
      projectPath: project,
    })
    expect(noDraft).toMatchObject({ ok: false, error: { code: 'team.no_draft' } })

    // 第 2 版改大轮次上限并发布。
    await send(window, 'team.saveDraft', {
      definition: {
        ...definition,
        id: saved.teamId,
        reviewLoop: { ...definition.reviewLoop, maxRounds: 3 },
      },
    })
    const second = await send<{ published?: { version: number } }>(window, 'team.publish', {
      teamId: saved.teamId,
    })
    expect(second.published?.version).toBe(2)

    // 版本回退：把第 1 版的字段重新存成草稿，试运行仍从草稿开始、行为一致。
    const v1 = await send<{ published?: { name: unknown; description: unknown } }>(
      window,
      'team.get',
      { teamId: saved.teamId, version: 1 },
    )
    expect(v1.published?.name).toEqual(definition.name)
    const rolledBack = await send<{ draft?: { reviewLoop: { maxRounds: number } } }>(
      window,
      'team.saveDraft',
      {
        definition: {
          id: saved.teamId,
          ...definition,
          name: v1.published?.name as Record<string, string>,
          description: v1.published?.description as Record<string, string>,
        },
      },
    )
    expect(rolledBack.draft?.reviewLoop.maxRounds).toBe(2)
    const third = await send<{ sessionId: string; teamDraftHash: string }>(
      window,
      'team.trial.start',
      { teamId: saved.teamId, projectPath: project },
    )
    // 回退到第 1 版的内容：草稿哈希与前一次相同。
    expect(third.teamDraftHash).toBe(first.teamDraftHash)
    const again = await runTrialTurn(window, third.sessionId, '跑一次审查')
    expect(again.review).toEqual([expect.objectContaining({ status: 'passed' })])

    const trials = await send<{ trials: { sessionId: string }[] }>(window, 'team.trial.list', {
      teamId: saved.teamId,
    })
    expect(trials.trials.map((trial) => trial.sessionId)).toEqual([
      third.sessionId,
      first.sessionId,
    ])
    const cleared = await send<{ cleared: number }>(window, 'team.trial.clear', {
      teamId: saved.teamId,
    })
    expect(cleared.cleared).toBe(2)
  } finally {
    await mock?.close()
  }
})

test('非法模板不能发布，也不能开始试运行', async ({ launch, userData }) => {
  const { window } = await launch()
  const maker = await createAgent(window, {
    ...baseDraft,
    name: { 'zh-CN': '起草员', 'en-US': 'Maker' },
    description: { 'zh-CN': '写初稿', 'en-US': 'Writes drafts' },
    instructions: '',
    tools: { allow: ['read'] },
    permissions: 'read-only',
  })
  const solo = await createAgent(window, {
    ...baseDraft,
    name: { 'zh-CN': '独行侠', 'en-US': 'Solo' },
    description: { 'zh-CN': '未开启委派', 'en-US': 'No delegation' },
    instructions: '',
    tools: { allow: ['read'] },
    permissions: 'read-only',
  })
  const saved = await send<{ teamId: string; validation: { ok: boolean; errors: unknown[] } }>(
    window,
    'team.saveDraft',
    {
      definition: {
        name: { 'zh-CN': '坏模板' },
        description: { 'zh-CN': '主控没有委派' },
        coordinator: solo.agentId,
        members: [maker.agentId],
        pattern: 'delegate',
      },
    },
  )
  expect(saved.validation.ok).toBe(false)
  const publish = await tryCall(window, 'team.publish', { teamId: saved.teamId })
  expect(publish).toMatchObject({ ok: false, error: { code: 'team.invalid' } })
  const start = await tryCall(window, 'team.trial.start', {
    teamId: saved.teamId,
    projectPath: projectDir(userData),
  })
  expect(start).toMatchObject({ ok: false, error: { code: 'team.invalid' } })
})

test('内置模板随应用提供：只读，无需草稿即可试运行', async ({ launch, userData }) => {
  const { window } = await launch()
  await window.evaluate(async () => {
    const cairn = (globalThis as unknown as { cairn: { ready(): Promise<unknown> } }).cairn
    await cairn.ready()
  })

  const list = await send<{
    teams: { teamId: string; source: string; archived: boolean; version: number }[]
  }>(window, 'team.list', {})
  const builtins = list.teams.filter((team) => team.source === 'builtin')
  expect(builtins.map((team) => team.teamId)).toEqual([
    'builtin.team-review-loop',
    'builtin.team-explore-build',
    'builtin.team-pipeline',
  ])
  expect(builtins.every((team) => !team.archived && team.version === 1)).toBe(true)

  const detail = await send<{
    source: string
    published: {
      id: string
      version: number
      name: Record<string, string>
      description: Record<string, string>
      coordinator: string
      members: string[]
      pattern: 'review-loop'
      reviewLoop: { maker: string; checker: string; maxRounds: number }
    }
  }>(window, 'team.get', { teamId: 'builtin.team-review-loop' })
  expect(detail.source).toBe('builtin')
  expect(detail.published.version).toBe(1)

  // 代码提供的模板不能改：按内置 id 存草稿或发布都被拒。
  const { id, name, description, coordinator, members, pattern, reviewLoop } = detail.published
  const save = await tryCall(window, 'team.saveDraft', {
    definition: { id, name, description, coordinator, members, pattern, reviewLoop },
  })
  expect(save).toMatchObject({ ok: false, error: { code: 'team.readonly' } })
  const publish = await tryCall(window, 'team.publish', { teamId: 'builtin.team-review-loop' })
  expect(publish).toMatchObject({ ok: false, error: { code: 'team.readonly' } })

  // 没有草稿也能开始试运行：直接以代码里的 v1 运行。
  const trial = await send<{ sessionId: string; teamId: string }>(window, 'team.trial.start', {
    teamId: 'builtin.team-review-loop',
    projectPath: projectDir(userData),
  })
  expect(trial.teamId).toBe('builtin.team-review-loop')
})
