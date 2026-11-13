import type { ModelRef, PlanDocument, RunLimits } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  FakeRuntime,
  PlanErrorCode,
  PlanModeReasonCode,
  PLAN_MODE_DENY_REASON,
  PROPOSE_PLAN_TOOL,
  REVISE_PLAN_STEPS_TOOL,
  RunEngine,
  UPDATE_PLAN_STEP_TOOL,
  applyStepTitles,
  approvedPlanMessage,
  buildSystemPrompt,
  createToolRegistry,
  decidePermission,
  planModeGuard,
  planToolVisible,
  presetRules,
  registerPlanTools,
  renderPlan,
  type ResolvedModel,
  type ToolContext,
  type ToolDefinition,
} from './index.js'

const doc: PlanDocument = {
  goal: '读代码',
  files: ['src/a.ts'],
  steps: [
    { id: 'read', title: '读 src/a.ts' },
    { id: 'test', title: '跑测试' },
  ],
  risks: '',
  verification: '单测通过',
  markdown: '1. 读代码',
}

const writeTool: ToolDefinition = {
  name: 'write_note',
  description: 'write',
  category: 'write',
  source: { kind: 'builtin' },
  trust: 'builtin',
  inputSchema: { type: 'object' },
  execute: () => Promise.resolve({ content: [] }),
}
const ctx = {} as ToolContext

describe('plan mode guard', () => {
  const request = {
    definition: writeTool,
    input: {},
    targets: {},
    toolCallId: 'c1',
  }

  it('denies writes even when auto mode would allow them', () => {
    const denied = decidePermission(request, presetRules('auto'), {
      guards: [planModeGuard(() => true)],
    })
    expect(denied).toMatchObject({
      decision: 'deny',
      reasonCode: PlanModeReasonCode,
      reason: PLAN_MODE_DENY_REASON,
    })
    const allowed = decidePermission(request, presetRules('auto'), {
      guards: [planModeGuard(() => false)],
    })
    expect(allowed).toEqual({ decision: 'allow' })
  })
})

describe('plan tools', () => {
  it('shows each tool only in the turn that can use it', () => {
    expect(planToolVisible(PROPOSE_PLAN_TOOL, 'plan', false)).toBe(true)
    expect(planToolVisible(PROPOSE_PLAN_TOOL, 'normal', true)).toBe(false)
    expect(planToolVisible(UPDATE_PLAN_STEP_TOOL, 'normal', true)).toBe(true)
    expect(planToolVisible(UPDATE_PLAN_STEP_TOOL, 'normal', false)).toBe(false)
    expect(planToolVisible(UPDATE_PLAN_STEP_TOOL, 'plan', true)).toBe(false)
    expect(planToolVisible('read_file', 'normal', false)).toBe(true)
  })

  it('records a plan and stops the turn, filling in empty markdown', async () => {
    const registry = createToolRegistry()
    registerPlanTools(registry, {
      createId: () => 'pl1',
      activePlan: () => undefined,
    })
    const tool = registry.get(PROPOSE_PLAN_TOOL)!
    const output = await tool.execute({ ...doc, markdown: '  ' }, ctx)
    expect(output.stopLoop).toBe(true)
    expect(output.content).toEqual([
      {
        type: 'text',
        text: 'Plan recorded. This turn ends so the user can review it. Wait for the user to approve before executing.',
      },
    ])
    expect(output.effects).toEqual([
      {
        type: 'plan.proposed',
        payload: {
          planId: 'pl1',
          content: { ...doc, markdown: renderPlan({ ...doc, markdown: '  ' }) },
        },
      },
    ])

    // 缺少必填字段时报错并列出具体路径
    await expect(tool.execute({ goal: 'x' }, ctx)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(
      tool.execute({ ...doc, steps: [{ id: '1bad', title: 'x' }] }, ctx),
    ).rejects.toMatchObject({
      code: 'tool.invalid_input',
    })
    await expect(
      tool.execute(
        {
          ...doc,
          steps: [
            { id: 'read', title: 'a' },
            { id: 'read', title: 'b' },
          ],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
  })

  it('updates a step by id and rejects a missing plan or id', async () => {
    let active: { planId: string; goal: string; steps: typeof doc.steps } | undefined = {
      planId: 'pl1',
      goal: doc.goal,
      steps: doc.steps,
    }
    const registry = createToolRegistry()
    registerPlanTools(registry, {
      createId: () => 'unused',
      activePlan: () => active,
    })
    const tool = registry.get(UPDATE_PLAN_STEP_TOOL)!
    const output = await tool.execute({ stepId: 'test', status: 'done', note: ' 改了测试 ' }, ctx)
    expect(output.stopLoop).toBeUndefined()
    expect(output.effects).toEqual([
      {
        type: 'plan.step.updated',
        payload: { planId: 'pl1', stepId: 'test', stepIndex: 1, status: 'done', note: '改了测试' },
      },
    ])
    await expect(tool.execute({ stepId: 'missing', status: 'done' }, ctx)).rejects.toMatchObject({
      code: PlanErrorCode.UnknownStep,
    })
    active = undefined
    await expect(
      tool.execute({ stepId: 'read', status: 'in_progress' }, ctx),
    ).rejects.toMatchObject({
      code: PlanErrorCode.NoActivePlan,
    })
  })

  it('revises the step list and syncs the host snapshot', async () => {
    let active: { planId: string; goal: string; steps: typeof doc.steps } | undefined = {
      planId: 'pl1',
      goal: doc.goal,
      steps: doc.steps,
    }
    const revised: { id: string; title: string }[][] = []
    const registry = createToolRegistry()
    registerPlanTools(registry, {
      createId: () => 'unused',
      activePlan: () => active,
      revisePlan: (steps) => {
        revised.push(steps.map((step) => ({ ...step })))
        if (active) active = { ...active, steps: steps.map((step) => ({ ...step })) }
      },
    })
    const tool = registry.get(REVISE_PLAN_STEPS_TOOL)!
    const steps = [
      { id: 'read', title: '读 src/a.ts' },
      { id: 'write', title: '写实现' },
    ]
    const output = await tool.execute({ steps }, ctx)
    expect(output.effects).toEqual([
      { type: 'plan.steps.revised', payload: { planId: 'pl1', steps } },
    ])
    expect(revised).toEqual([steps])
    // 修订后的步骤立即可用于 update_plan_step。
    const update = registry.get(UPDATE_PLAN_STEP_TOOL)!
    await expect(
      update.execute({ stepId: 'write', status: 'in_progress' }, ctx),
    ).resolves.toBeTruthy()

    await expect(
      tool.execute(
        {
          steps: [
            { id: 'read', title: 'a' },
            { id: 'read', title: 'b' },
          ],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' })
    active = undefined
    await expect(tool.execute({ steps }, ctx)).rejects.toMatchObject({
      code: PlanErrorCode.NoActivePlan,
    })
  })
})

describe('plan text', () => {
  it('prepends an approval directive and keeps markdown when titles are unchanged', () => {
    const approved = approvedPlanMessage(doc, doc)
    expect(approved).toContain('已批准此计划')
    expect(approved).toContain('update_plan_step')
    expect(approved).toContain('read')
    expect(approved).toContain(doc.markdown)
  })

  it('rewrites edited step titles in the approval message', () => {
    const edited = applyStepTitles(doc, [{ id: 'read', title: '先读测试' }])
    expect(edited.steps[0]?.title).toBe('先读测试')
    expect(approvedPlanMessage(doc, edited)).toContain('先读测试')
    expect(approvedPlanMessage(doc, edited)).not.toBe(doc.markdown)
    expect(renderPlan({ ...doc, files: [], risks: '  ', verification: '' })).toContain('(none)')
  })

  it('adds the plan section to the system prompt', () => {
    const base = {
      tools: false,
      environment: { os: 'Linux', workspacePath: '/work', date: '2026-11-07' },
    }
    expect(buildSystemPrompt({ ...base, plan: { kind: 'propose' } })).toContain('# Plan mode')
    expect(
      buildSystemPrompt({
        ...base,
        plan: { kind: 'execute', goal: doc.goal, steps: doc.steps },
      }),
    ).toContain('read: 读 src/a.ts')
  })
})

const ref: ModelRef = { providerId: 'fake', modelId: 'fake-1' }
const model: ResolvedModel = {
  ref,
  providerKind: 'openai',
  baseUrl: 'http://localhost:0',
  profile: {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: false,
  },
}
const limits: RunLimits = {
  maxStepsPerTurn: 10,
  maxTurnDurationMs: 60_000,
  maxConsecutiveToolErrors: 3,
}

describe('propose_plan ends the turn', () => {
  it('does not run the scripted reply after stopLoop, and emits the plan', async () => {
    const events: { type: string; payload?: unknown }[] = []
    const engine = await RunEngine.create({
      sessionId: 's1',
      runId: 'r1',
      agent: { id: 'builtin.coder', version: 1 },
      mode: 'interactive',
      limits,
      runtime: new FakeRuntime(
        {
          turns: [
            {
              steps: [
                { kind: 'tool', name: PROPOSE_PLAN_TOOL, input: doc },
                { kind: 'reply', text: 'should-not-run' },
              ],
            },
          ],
        },
        { now: () => 1000 },
      ),
      model,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      now: () => 1000,
      executeTool: async () => ({
        status: 'ok',
        content: [{ type: 'text', text: 'recorded' }],
        stopLoop: true,
        effects: [{ type: 'plan.proposed', payload: { planId: 'pl1', content: doc } }],
      }),
    })
    await engine.prompt({ messageId: 'u1', content: [{ type: 'text', text: '计划' }] })
    expect(events.map((event) => event.type)).toContain('plan.proposed')
    expect(events.map((event) => event.type)).toContain('turn.completed')
    expect(JSON.stringify(events)).not.toContain('should-not-run')
    expect(events.filter((event) => event.type === 'step.started')).toHaveLength(1)
  })
})
