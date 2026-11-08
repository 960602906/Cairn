/**
 * 运行树投影（M4-04，管理界面 §8.2，ADR-0005）。
 *
 * 纯函数：只依赖已持久化的事件，按 `runId` / `turnId` / `stepId` 重建运行、轮次、步骤、工具调用与
 * 审批。相同事件序列总是得到相同的树与节点顺序；未知引用只忽略，不抛错。
 */
import {
  emptyRunUsage,
  type AgentDefinitionRef,
  type ErrorInfo,
  type EventEnvelope,
  type ModelRef,
  type RunLimits,
  type RunMode,
  type RunState,
  type RunTreeNode,
  type RunTreeStep,
  type RunTreeToolCall,
  type RunTreeTurn,
  type RunTree,
  type RunTreeApproval,
  type RunUsage,
} from '@cairn/protocol'

export interface ProjectRunTreeInput {
  readonly sessionId: string
  readonly events: readonly EventEnvelope[]
  /** 只返回这个运行及其子树；省略时返回第一个根运行的全部子树。 */
  readonly rootRunId?: string
  readonly generatedAt?: number
}

interface MutableToolCall {
  toolCallId: string
  name: string
  status: RunTreeToolCall['status']
  requestedAt: number
  startedAt?: number
  endedAt?: number
  durationMs?: number
  error?: ErrorInfo
  approval?: RunTreeApproval
}

interface MutableStep {
  stepId: string
  model: ModelRef
  startedAt: number
  endedAt?: number
  finishReason?: RunTreeStep['finishReason']
  usage: RunUsage
  toolCalls: MutableToolCall[]
  toolIndex: Map<string, MutableToolCall>
}

interface MutableTurn {
  turnId: string
  startedAt: number
  endedAt?: number
  status: RunTreeTurn['status']
  usage: RunUsage
  steps: MutableStep[]
  stepIndex: Map<string, MutableStep>
  limitHit: boolean
}

interface MutableRun {
  runId: string
  parentRunId?: string
  agent: AgentDefinitionRef
  model: ModelRef
  mode: RunMode
  state: RunState
  createdAt: number
  updatedAt: number
  limits: RunLimits
  ownUsage: RunUsage
  turns: MutableTurn[]
  turnIndex: Map<string, MutableTurn>
}

const usageOf = (): RunUsage => emptyRunUsage()

const addUsage = (target: RunUsage, source: RunUsage): void => {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.modelCalls += source.modelCalls
  target.toolCalls += source.toolCalls
  target.durationMs += source.durationMs
  if (source.cacheReadTokens !== undefined) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + source.cacheReadTokens
  }
}

/** 按 `runId` 建树并汇总子树用量；根运行缺省为第一个没有父运行的运行。 */
export function projectRunTree(input: ProjectRunTreeInput): RunTree {
  const runs = new Map<string, MutableRun>()
  const generatedAt = input.generatedAt ?? Date.now()

  const ensureRun = (event: EventEnvelope): MutableRun | undefined => {
    const existing = runs.get(event.runId)
    if (existing) return existing
    if (event.type !== 'run.created') return undefined
    const created: MutableRun = {
      runId: event.runId,
      ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
      agent: event.payload.agent,
      model: event.payload.model,
      mode: event.payload.mode,
      state: 'idle',
      createdAt: event.ts,
      updatedAt: event.ts,
      limits: event.payload.limits,
      ownUsage: usageOf(),
      turns: [],
      turnIndex: new Map(),
    }
    runs.set(event.runId, created)
    return created
  }

  const ensureTurn = (run: MutableRun, event: EventEnvelope): MutableTurn | undefined => {
    if (!event.turnId) return undefined
    const existing = run.turnIndex.get(event.turnId)
    if (existing) return existing
    const turn: MutableTurn = {
      turnId: event.turnId,
      startedAt: event.ts,
      status: 'running',
      usage: usageOf(),
      steps: [],
      stepIndex: new Map(),
      limitHit: false,
    }
    run.turnIndex.set(turn.turnId, turn)
    run.turns.push(turn)
    return turn
  }

  const ensureStep = (turn: MutableTurn, event: EventEnvelope): MutableStep | undefined => {
    if (!event.stepId) return undefined
    const existing = turn.stepIndex.get(event.stepId)
    if (existing) return existing
    const step: MutableStep = {
      stepId: event.stepId,
      model: {
        providerId: 'unknown',
        modelId: 'unknown',
      },
      startedAt: event.ts,
      usage: usageOf(),
      toolCalls: [],
      toolIndex: new Map(),
    }
    turn.stepIndex.set(step.stepId, step)
    turn.steps.push(step)
    return step
  }

  const findTool = (run: MutableRun, toolCallId: string): MutableToolCall | undefined => {
    for (const turn of run.turns) {
      for (const step of turn.steps) {
        const tool = step.toolIndex.get(toolCallId)
        if (tool) return tool
      }
    }
    return undefined
  }

  for (const event of input.events) {
    const run = ensureRun(event)
    if (!run) continue
    run.updatedAt = Math.max(run.updatedAt, event.ts)
    const turn = ensureTurn(run, event)
    const step = turn ? ensureStep(turn, event) : undefined

    switch (event.type) {
      case 'run.state.changed':
        run.state = event.payload.to
        break
      case 'run.disposed':
        run.state = 'disposed'
        break
      case 'turn.started':
        if (turn) {
          turn.status = 'running'
          turn.startedAt = event.ts
        }
        break
      case 'step.started':
        if (step) {
          step.model = event.payload.model
          step.startedAt = event.ts
          step.usage.modelCalls += 1
          run.ownUsage.modelCalls += 1
          turn!.usage.modelCalls += 1
        }
        break
      case 'step.completed':
        if (step) {
          step.model = event.payload.model
          step.finishReason = event.payload.finishReason
          step.endedAt = event.ts
          step.usage.durationMs += event.payload.durationMs
          turn!.usage.durationMs += event.payload.durationMs
          if (event.payload.usage) {
            step.usage.inputTokens += event.payload.usage.inputTokens
            step.usage.outputTokens += event.payload.usage.outputTokens
            if (event.payload.usage.cacheReadTokens !== undefined) {
              step.usage.cacheReadTokens =
                (step.usage.cacheReadTokens ?? 0) + event.payload.usage.cacheReadTokens
            }
            turn!.usage.inputTokens += event.payload.usage.inputTokens
            turn!.usage.outputTokens += event.payload.usage.outputTokens
            run.ownUsage.inputTokens += event.payload.usage.inputTokens
            run.ownUsage.outputTokens += event.payload.usage.outputTokens
            if (event.payload.usage.cacheReadTokens !== undefined) {
              turn!.usage.cacheReadTokens =
                (turn!.usage.cacheReadTokens ?? 0) + event.payload.usage.cacheReadTokens
              run.ownUsage.cacheReadTokens =
                (run.ownUsage.cacheReadTokens ?? 0) + event.payload.usage.cacheReadTokens
            }
          }
        }
        break
      case 'tool.requested': {
        if (!step) break
        const existing = step.toolIndex.get(event.payload.toolCallId)
        if (existing) {
          existing.name = event.payload.name
          break
        }
        const tool: MutableToolCall = {
          toolCallId: event.payload.toolCallId,
          name: event.payload.name,
          status: 'requested',
          requestedAt: event.ts,
        }
        step.toolIndex.set(tool.toolCallId, tool)
        step.toolCalls.push(tool)
        step.usage.toolCalls += 1
        turn!.usage.toolCalls += 1
        run.ownUsage.toolCalls += 1
        break
      }
      case 'tool.started': {
        const tool = findTool(run, event.payload.toolCallId)
        if (tool) {
          tool.status = 'running'
          tool.startedAt = event.ts
        }
        break
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.cancelled': {
        const tool = findTool(run, event.payload.toolCallId)
        if (!tool) break
        tool.endedAt = event.ts
        if (event.type === 'tool.completed') {
          tool.status = 'completed'
          tool.durationMs = event.payload.durationMs
        } else if (event.type === 'tool.failed') {
          tool.status = 'failed'
          tool.error = event.payload.error
        } else {
          tool.status = 'cancelled'
        }
        break
      }
      case 'approval.requested': {
        const tool = findTool(run, event.payload.toolCallId)
        if (!tool) break
        tool.approval = {
          approvalId: event.payload.approvalId,
          reasonCode: event.payload.reasonCode,
          matchedRuleIds: [...event.payload.matchedRuleIds],
        }
        break
      }
      case 'approval.resolved': {
        for (const item of run.turns) {
          for (const itemStep of item.steps) {
            for (const tool of itemStep.toolCalls) {
              if (tool.approval?.approvalId !== event.payload.approvalId) continue
              tool.approval.decision = event.payload.decision
              tool.approval.decidedBy = event.payload.decidedBy
            }
          }
        }
        break
      }
      case 'turn.completed':
        if (turn) {
          turn.status = 'completed'
          turn.endedAt = event.ts
          turn.usage.durationMs = event.payload.durationMs
        }
        break
      case 'turn.aborted':
        if (turn) {
          turn.status = 'aborted'
          turn.endedAt = event.ts
        }
        break
      case 'turn.limit_reached':
        if (turn) turn.limitHit = true
        break
      case 'turn.failed':
        if (turn) {
          turn.status = turn.limitHit ? 'limit_reached' : 'failed'
          turn.endedAt = event.ts
        }
        break
      default:
        break
    }
  }

  const rootRunId =
    input.rootRunId ??
    [...runs.values()].find((run) => run.parentRunId === undefined)?.runId ??
    [...runs.keys()][0] ??
    ''

  const include = new Set<string>()
  if (rootRunId !== '') {
    const pending = [rootRunId]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (include.has(current) || !runs.has(current)) continue
      include.add(current)
      for (const run of runs.values()) {
        if (run.parentRunId === current) pending.push(run.runId)
      }
    }
  }

  const visible = [...runs.values()].filter((run) => include.has(run.runId))
  const aggregated = new Map<string, RunUsage>()
  const visiting = new Set<string>()
  const aggregate = (run: MutableRun): RunUsage => {
    const cached = aggregated.get(run.runId)
    if (cached) return cached
    if (visiting.has(run.runId)) return usageOf()
    visiting.add(run.runId)
    const usage: RunUsage = {
      ...run.ownUsage,
      durationMs: Math.max(0, run.updatedAt - run.createdAt),
    }
    for (const child of visible) {
      if (child.parentRunId === run.runId) addUsage(usage, aggregate(child))
    }
    visiting.delete(run.runId)
    aggregated.set(run.runId, usage)
    return usage
  }

  const nodes: RunTreeNode[] = visible.map((run) => ({
    runId: run.runId,
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    agent: run.agent,
    model: run.model,
    mode: run.mode,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    durationMs: Math.max(0, run.updatedAt - run.createdAt),
    limits: run.limits,
    usage: aggregate(run),
    turns: run.turns.map((turn) => ({
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
      status: turn.status,
      usage: turn.usage,
      steps: turn.steps.map((item) => ({
        stepId: item.stepId,
        model: item.model,
        startedAt: item.startedAt,
        ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
        ...(item.finishReason === undefined ? {} : { finishReason: item.finishReason }),
        usage: item.usage,
        toolCalls: item.toolCalls.map((tool) => ({
          toolCallId: tool.toolCallId,
          name: tool.name,
          status: tool.status,
          requestedAt: tool.requestedAt,
          ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }),
          ...(tool.endedAt === undefined ? {} : { endedAt: tool.endedAt }),
          ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
          ...(tool.error === undefined ? {} : { error: tool.error }),
          ...(tool.approval === undefined ? {} : { approval: tool.approval }),
        })),
      })),
    })),
  }))

  // 保留事件顺序，方便界面稳定渲染。
  return {
    sessionId: input.sessionId,
    rootRunId,
    generatedAt,
    runs: nodes,
  }
}
