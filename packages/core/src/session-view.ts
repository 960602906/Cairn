/**
 * 会话投影（架构 §7.3；Runtime §5、§17）。
 *
 * `reduceSession(view, event)` 是纯函数：由事件得到消息列表、会话信息与运行状态，
 * 界面（M0-15）和测试共用。规则：
 *
 * - **幂等**：`seq` 不大于 `lastSeq` 的事件（重复补发、乱序到达）和其他会话的事件直接忽略，
 *   返回原对象。因此"补发 + 实时"重叠时不会出现重复消息。
 * - **容错**：引用未知运行 / 轮次 / 步骤的事件、非法的状态转换都只推进 `lastSeq`，不改变内容，
 *   不抛出。
 * - **增量事件**（`*.delta`）只更新 `live` 中"进行中"的消息，不推进 `lastSeq`（`lastSeq` 只表示
 *   已归约的最后一条持久化事件，可直接作为 `afterSeq`）。`message.assistant.completed` 以完整内容
 *   写入 `messages` 并移除对应的进行中消息；轮次结束或宿主崩溃时丢弃该运行剩余的进行中消息。
 *   因此只用持久化事件与"持久化 + 增量"归约，最终结果相同。
 * - **工具调用**（M1-05c）：`tool.*` 持久化事件归约为 `tools`；`tool.output.delta` 只进入
 *   `liveToolOutput`（保留最后 `MAX_LIVE_TOOL_OUTPUT_CHARS` 个字符），工具结束、轮次结束或宿主崩溃时丢弃，
 *   规则与进行中的消息相同。
 * - 状态以不可变方式更新：只替换发生变化的部分，便于界面按引用比较。
 */
import {
  type AgentDefinitionRef,
  type RunAgentRef,
  type ContentPart,
  type ErrorInfo,
  type EventEnvelope,
  type EventPayload,
  type GoalEndReason,
  type GoalEvidence,
  type GoalLimits,
  type GoalPauseReason,
  type GoalVerdict,
  type LiveEvent,
  type MemoryScope,
  type ModelRef,
  type PersistedEvent,
  type PromptAgent,
  type PromptSkill,
  type ReasoningPart,
  type ReasoningEffort,
  type RunLimits,
  type RunMode,
  type RunState,
  type ResolvedMention,
  type SandboxExecution,
  type CheckpointReason,
  type PlanDocument,
  type PlanStepStatus,
  type SessionStatus,
  type SessionTeamBinding,
  type TaskListSource,
  type TokenUsage,
  type ToolCall,
  type ToolDisplay,
  type ToolOutputChunk as ProtocolToolOutputChunk,
} from '@cairn/protocol'
import { isPersistedEvent, taskListIdForPlan } from '@cairn/protocol/runtime'
import { canTransition, isActiveRunState } from './run-state.js'

/** 会话基本信息（来自 `session.created` / `session.renamed` / `session.model.changed`）。 */
export interface SessionInfo {
  readonly projectId: string
  readonly projectPath: string
  readonly workspacePath: string
  readonly title: string
  /** 会话使用的模型（下一轮起）；M1-04a 之前创建、没有记录模型的会话为 undefined。 */
  readonly model: ModelRef | undefined
  /** 本会话的思考强度（下一轮起）；没有设置时用模型配置里的默认值。 */
  readonly thinkingLevel: ReasoningEffort | undefined
  /** 绑定的团队模板（多 Agent 协作 §15）；普通 Agent 会话为 undefined。 */
  readonly team: SessionTeamBinding | undefined
  readonly createdAt: number
}

interface MessageMeta {
  readonly messageId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly seq: number
  readonly ts: number
}

export interface UserMessageView extends MessageMeta {
  readonly role: 'user'
  readonly content: readonly ContentPart[]
  /** 自动续轮消息的来源（ADR-0047）；省略或 `user` 是用户自己发送的。 */
  readonly origin?: 'user' | 'goal'
  /** `origin === 'goal'` 时指向目标。 */
  readonly goalId?: string
  /** 用 `@` 引用的文件与文件夹（ADR-0037）。展开的内容只给模型，不在这里。 */
  readonly mentions: readonly ResolvedMention[]
  /** `/技能名` 指定的技能。展开的正文只给模型，不在这里。 */
  readonly skills: readonly PromptSkill[]
  /** `@Agent名` 要求委派的 Agent。 */
  readonly agents: readonly PromptAgent[]
}

export interface AssistantMessageView extends MessageMeta {
  readonly role: 'assistant'
  readonly content: readonly ContentPart[]
  readonly reasoning: ReasoningPart | undefined
  readonly toolCalls: readonly ToolCall[]
  readonly model: ModelRef
  /** 被停止或出错打断的部分回复。 */
  readonly incomplete: boolean
}

export type MessageView = UserMessageView | AssistantMessageView

/** 正在流式输出、尚未完成的助手消息（只来自增量事件，不落库）。 */
export interface LiveMessageView {
  readonly messageId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly text: string
  readonly reasoning: string
  /** 已合并的最后一条增量的 seq，用于丢弃重复或迟到的增量。 */
  readonly lastDeltaSeq: number
  readonly startedAt: number
}

export type ToolCallStatus = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled'

/** 一次工具调用（来自 `tool.*` 持久化事件）。 */
export interface ToolCallView {
  readonly toolCallId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly name: string
  readonly input: unknown
  readonly status: ToolCallStatus
  readonly requestedAt: number
  /** 交给模型的输出（`tool.completed`）。 */
  readonly output: readonly ContentPart[] | undefined
  /** 只给界面显示的结果（`tool.completed.display`，M2-06）。 */
  readonly display: ToolDisplay | undefined
  /** 命令实际使用的沙箱（M5-04/M5-05）：来自 `tool.started`，旧事件为 undefined。 */
  readonly sandbox: SandboxExecution | undefined
  readonly truncated: boolean
  readonly error: ErrorInfo | undefined
  readonly cancelReason: EventPayload<'tool.cancelled'>['reason'] | undefined
  readonly durationMs: number | undefined
}

export type ToolOutputChunk = Readonly<ProtocolToolOutputChunk>

/** 执行中的工具的实时输出（只来自 `tool.output.delta`，不落库）。 */
export interface LiveToolOutputView {
  readonly toolCallId: string
  readonly runId: string
  /** 相邻的同一输出流合并为一段。 */
  readonly chunks: readonly ToolOutputChunk[]
  /** 超过上限后从开头丢弃的字符数。 */
  readonly omittedChars: number
  readonly lastDeltaSeq: number
}

/** 每个工具调用保留的实时输出上限（字符数）；完整结果以 `tool.completed` 为准。 */
export const MAX_LIVE_TOOL_OUTPUT_CHARS = 64 * 1024

export type StepStatus = 'running' | 'completed'

export interface StepView {
  readonly stepId: string
  readonly model: ModelRef
  readonly status: StepStatus
  readonly startedAt: number
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error' | undefined
  readonly durationMs: number | undefined
}

export type TurnStatus = 'running' | 'completed' | 'aborted' | 'failed'

export interface TurnView {
  readonly turnId: string
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt: number | undefined
  /** 本轮已开始的步骤数。 */
  readonly stepCount: number
  /** 当前（或最后一个）步骤。 */
  readonly step: StepView | undefined
  readonly durationMs: number | undefined
  readonly abortReason: 'user' | 'shutdown' | 'superseded' | undefined
  readonly error: ErrorInfo | undefined
  readonly retryable: boolean | undefined
  /** 本轮触发的限额（`turn.limit_reached`）；轮次随后仍以失败或完成结束。 */
  readonly limitReached: { readonly limit: keyof RunLimits; readonly value: number } | undefined
  /**
   * 模型请求失败、正在等待重试（`model.retry`，M1-14a）；下一步开始或本轮结束时清除。
   * `at` 为事件时间，界面据此与 `delayMs` 显示剩余等待。
   */
  readonly retry: RetryView | undefined
}

export interface RetryView {
  readonly attempt: number
  readonly maxRetries: number
  readonly delayMs: number
  readonly error: ErrorInfo
  readonly at: number
}

export interface RunView {
  readonly runId: string
  readonly parentRunId: string | undefined
  readonly agent: RunAgentRef
  readonly model: ModelRef
  readonly mode: RunMode
  readonly limits: RunLimits
  readonly state: RunState
  readonly createdAt: number
  /** `run.created` 的 seq；用来判断运行是否创建于某次回退之后。旧快照可能没有。 */
  readonly seq?: number
  /** 最近一轮；尚未开始时为 `undefined`。 */
  readonly turn: TurnView | undefined
  readonly usage: TokenUsage
}

/** 父运行发起的一次委派（`run.delegated`，M4-02）；完成状态来自 `run.child.completed`。 */
export interface DelegationView {
  readonly childRunId: string
  readonly parentRunId: string
  readonly agent: AgentDefinitionRef
  readonly task: string
  readonly workspace: 'shared' | 'isolated' | 'auto' | undefined
  readonly workspacePath: string | undefined
  readonly budget: RunLimits | undefined
  readonly turnId: string | undefined
  readonly createdAt: number
  readonly completed:
    | {
        readonly status: 'completed' | 'failed' | 'aborted' | 'needs_input' | 'limit_reached'
        readonly summary: string | undefined
        readonly usage: TokenUsage | undefined
        readonly changeSetId: string | undefined
        readonly issues: readonly string[] | undefined
      }
    | undefined
}

/** 一条等待用户确认的记忆提议（`memory.proposed`，M7-03）；确认或忽略后从视图里移除。 */
export interface MemoryProposalView {
  readonly memoryId: string
  readonly scope: MemoryScope
  readonly content: string
  readonly sourceAgentId: string | undefined
  /** 提议它的运行；界面用它把提议归到对应的轮次。 */
  readonly runId: string
  readonly createdAt: number
}

/** 审查循环的一轮（`team.review.round`，M7-07）。 */
export interface ReviewRoundView {
  readonly round: number
  readonly makerRunId: string
  readonly checkerRunId: string
  readonly verdict: 'pass' | 'revise'
  readonly feedback?: string
}

/**
 * 一段审查循环（M7-07）：`rounds` 记录每轮的 maker / checker，`status` 在
 * `team.review.completed` 后出现。界面按 `turnId` 把它挂到对应的轮次。
 */
export interface ReviewLoopView {
  readonly reviewId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly seq: number
  readonly rounds: readonly ReviewRoundView[]
  readonly status: 'passed' | 'exhausted' | 'failed' | 'stopped' | 'limit_reached' | undefined
  readonly summary: string | undefined
}

/** pipeline 的一个阶段（`team.pipeline.stage`，M7-08）。 */
export interface PipelineStageView {
  readonly stage: string
  readonly agentRunId: string
  readonly status: 'completed' | 'failed' | 'aborted' | 'needs_input' | 'limit_reached'
  readonly summary?: string
}

/**
 * 一条流水线（M7-08）：阶段按完成顺序记录，`status` / `skipped` 在
 * `team.pipeline.completed` 后出现。界面按 `turnId` 把它挂到对应的轮次。
 */
export interface PipelineView {
  readonly pipelineId: string
  readonly runId: string
  readonly turnId: string | undefined
  readonly seq: number
  readonly stages: readonly PipelineStageView[]
  readonly status: 'completed' | 'failed' | 'stopped' | 'limit_reached' | undefined
  readonly skipped: readonly string[]
  readonly summary: string | undefined
}

/** 会话的一个检查点（`checkpoint.created`，M2-08 的检查点分隔线与历史菜单）。 */
export interface CheckpointView {
  readonly checkpointId: string
  readonly reason: CheckpointReason
  readonly seq: number
  readonly runId: string
  /** 创建时所在的轮次；恢复前创建的检查点没有。 */
  readonly turnId: string | undefined
  readonly createdAt: number
}

/** 一次恢复（`checkpoint.restored`）。 */
export interface RestoreView {
  readonly checkpointId: string
  readonly seq: number
  readonly ts: number
}

/** 计划里的一步（M3-05）。状态从 `pending` 起，由 `plan.step.updated` 推进。 */
export interface PlanStepView {
  readonly id: string
  readonly title: string
  readonly status: PlanStepStatus
  readonly note?: string
}

export type PlanCardStatus = 'proposed' | 'approved' | 'rejected'

/** 一份计划（`plan.proposed` 起）。步骤标题在批准时可能被用户改过。 */
export interface PlanView {
  readonly planId: string
  readonly content: PlanDocument
  readonly steps: readonly PlanStepView[]
  readonly status: PlanCardStatus
  readonly feedback?: string
  readonly seq: number
  readonly runId: string
  readonly turnId?: string
}

/** 最近一份还在等用户决定的计划；没有时返回 undefined。 */
export function proposedPlan(view: SessionView): PlanView | undefined {
  for (let index = view.plans.length - 1; index >= 0; index -= 1) {
    const plan = view.plans[index]
    if (plan?.status === 'proposed') return plan
  }
  return undefined
}

/** 最近一份已批准的计划。后面又提出或放弃的计划不会把它盖掉。 */
export function activeExecutionPlan(view: SessionView): PlanView | undefined {
  for (let index = view.plans.length - 1; index >= 0; index -= 1) {
    const plan = view.plans[index]
    if (plan?.status === 'approved') return plan
  }
  return undefined
}

/** 待办列表里的一项（ADR-0038）。状态从 `pending` 起，由 `tasklist.item.updated` 推进。 */
export interface TaskItemView {
  readonly itemId: string
  readonly title: string
  readonly status: PlanStepStatus
  readonly note?: string
}

/** 会话里的一份待办列表（`tasklist.created` 起）。计划批准创建的那份带 `planId`。 */
export interface TaskListView {
  readonly listId: string
  readonly title: string
  readonly source: TaskListSource
  readonly planId?: string
  readonly items: readonly TaskItemView[]
  /** 已关闭的列表不再接受更新，也不出现在浮动进度卡上。 */
  readonly closed: boolean
  readonly seq: number
  readonly runId: string
  readonly turnId?: string
}

/** 未关闭的待办列表，按创建顺序。 */
export function activeTaskLists(view: SessionView): readonly TaskListView[] {
  return view.taskLists.filter((list) => !list.closed)
}

/** 计划关联的执行列表；旧会话没有时返回 undefined，调用方回退到 `plan.steps`。 */
export function taskListForPlan(view: SessionView, planId: string): TaskListView | undefined {
  return view.taskLists.find((list) => list.source === 'plan' && list.planId === planId)
}

/** 列表里是否还有没做完的项。 */
export function taskListInProgress(list: TaskListView): boolean {
  return list.items.some((item) => item.status === 'pending' || item.status === 'in_progress')
}

/** 计划卡片显示的步骤：有关联列表时用列表项，否则用计划快照（旧会话）。 */
export function planProgressSteps(view: SessionView, plan: PlanView): readonly TaskItemView[] {
  const list = taskListForPlan(view, plan.planId)
  return list
    ? list.items
    : plan.steps.map((step) => ({
        itemId: step.id,
        title: step.title,
        status: step.status,
        ...(step.note ? { note: step.note } : {}),
      }))
}

/** 旧会话没有列表事件：按计划快照合成一份，让进度卡与侧栏继续工作。 */
function synthesizedPlanList(plan: PlanView): TaskListView {
  return {
    listId: taskListIdForPlan(plan.planId),
    title: plan.content.goal,
    source: 'plan',
    planId: plan.planId,
    items: plan.steps.map((step) => ({
      itemId: step.id,
      title: step.title,
      status: step.status,
      ...(step.note ? { note: step.note } : {}),
    })),
    closed: false,
    seq: plan.seq,
    runId: plan.runId,
    ...(plan.turnId ? { turnId: plan.turnId } : {}),
  }
}

/** 一次目标判定（`goal.evaluated`）。`turnId` 取事件信封，界面按它挂到轮次。 */
export interface GoalEvaluationView {
  readonly turnId: string | undefined
  readonly verdict: GoalVerdict
  readonly reason: string
  readonly evidence: readonly GoalEvidence[]
  readonly model: ModelRef
  readonly seq: number
  readonly at: number
}

/** 影响目标状态的生命周期事件；回退时按 seq 过滤后重放。 */
export interface GoalLifecycleView {
  readonly seq: number
  readonly at: number
  readonly kind: 'created' | 'paused' | 'resumed' | 'ended'
  readonly reason?: GoalPauseReason | GoalEndReason
  readonly detail?: string
  readonly turns?: number
  readonly durationMs?: number
}

export type GoalStatus = 'active' | 'paused' | 'ended'

/** 会话里的一次目标（ADR-0047）。一个会话最多一个未结束目标。 */
export interface GoalView {
  readonly goalId: string
  readonly condition: string
  readonly limits: GoalLimits
  readonly status: GoalStatus
  /** `goal.created` 的 seq。 */
  readonly seq: number
  readonly createdAt: number
  /** 目标第一条用户消息的 seq；编辑到它时目标不再代表用户意图。 */
  readonly initialMessageSeq: number | undefined
  /** 已结束的活动区间之和；结束时取 `goal.ended.durationMs`。 */
  readonly activeMs: number
  /** 活动时当前区间的起点。 */
  readonly activeSince: number | undefined
  /** 目标 `active` 时开始的根运行轮次；回退时按 `turnId` 过滤。 */
  readonly turnIds: readonly string[]
  readonly evaluations: readonly GoalEvaluationView[]
  readonly lifecycle: readonly GoalLifecycleView[]
  readonly pauseReason: GoalPauseReason | undefined
  readonly pauseDetail: string | undefined
  readonly endReason: GoalEndReason | undefined
  readonly endDetail: string | undefined
  readonly endedAt: number | undefined
  /** 结果卡挂在哪个轮次。 */
  readonly endedTurnId: string | undefined
}

/**
 * 浮动进度卡显示的列表：执行中的计划优先（旧会话用合成列表），
 * 否则最近一个仍有未完成项的临时列表；都完成时不显示。
 */
export function progressTaskList(view: SessionView): TaskListView | undefined {
  const plan = activeExecutionPlan(view)
  if (plan) {
    const list = taskListForPlan(view, plan.planId) ?? synthesizedPlanList(plan)
    if (!list.closed && taskListInProgress(list)) return list
  }
  for (let index = view.taskLists.length - 1; index >= 0; index -= 1) {
    const list = view.taskLists[index]!
    if (list.source === 'ad_hoc' && !list.closed && taskListInProgress(list)) return list
  }
  return undefined
}

export interface SessionView {
  readonly sessionId: string
  /** 已归约的最后一条持久化事件的 seq；0 表示尚未处理任何事件（seq 从 1 开始）。 */
  readonly lastSeq: number
  /** 收到 `session.created` 之前为 `undefined`。 */
  readonly info: SessionInfo | undefined
  readonly archived: boolean
  /** 最近一次宿主崩溃；之后开始新一轮时清除。 */
  readonly crash: ErrorInfo | undefined
  readonly runs: Readonly<Record<string, RunView>>
  /** 按创建顺序排列的运行 id。 */
  readonly runOrder: readonly string[]
  /** 按 seq 顺序的消息；同一 `messageId` 只出现一次。 */
  readonly messages: readonly MessageView[]
  /** 进行中的消息，按 messageId 索引；界面显示在 `messages` 之后。 */
  readonly live: Readonly<Record<string, LiveMessageView>>
  /** 工具调用，按 toolCallId 索引。 */
  readonly tools: Readonly<Record<string, ToolCallView>>
  /** 执行中的工具的实时输出，按 toolCallId 索引。 */
  readonly liveToolOutput: Readonly<Record<string, LiveToolOutputView>>
  /** 会话累计用量（只统计 `usage.reported`，不重复计入 `step.completed.usage`）。 */
  readonly usage: TokenUsage
  /** 各轮的用量（M2-03，界面在轮次操作中显示 token 数），按 turnId 索引；没有 turnId 的用量不计入。 */
  readonly usageByTurn: Readonly<Record<string, TokenUsage>>
  /**
   * 上下文占用（M2-04，输入框的圆环）：最近一次主模型 `usage.reported` 的输入 + 输出 token 数，
   * 即下一次请求大约要带上的上下文；还没有用量时为 undefined。后台补全用量（`auxiliary`，M3-01）
   * 计入 `usage`，不更新这里。
   */
  readonly contextTokens: number | undefined
  /** 检查点，按创建顺序（M2-08）。 */
  readonly checkpoints: readonly CheckpointView[]
  /** 恢复，按发生顺序（M2-08）。 */
  readonly restores: readonly RestoreView[]
  /**
   * 最近一轮读到的项目说明（M3-02）。这一轮没读到时不出现，顶栏的标记随之消失。
   */
  readonly agentsMd?: { readonly lines: number; readonly truncated: boolean }
  /**
   * 最近一次成功的上下文压缩（M3-03）。原始消息仍在 `messages` 里；界面在这条事件的 seq 处画分隔线。
   */
  readonly compaction?: { readonly summary: string; readonly seq: number }
  /**
   * 摘要失败、丢掉工具输出后的那一次提示（M3-03）。只记第一次。
   */
  readonly toolOutputOmitted?: { readonly seq: number }
  /**
   * 最新的会话要点（M3-04）。只来自 `session.brief.updated`，不放进 `messages`。
   * 后面的轮次不会清掉它；空内容表示用户把它清空了。
   */
  readonly brief?: { readonly content: string; readonly editedBy: 'agent' | 'user' }
  /** 会话里的计划，按提出顺序（M3-05）。 */
  readonly plans: readonly PlanView[]
  /** 会话里的待办列表，按创建顺序（ADR-0038）。 */
  readonly taskLists: readonly TaskListView[]
  /** 目标模式（ADR-0047），按 goalId 索引。 */
  readonly goals: Readonly<Record<string, GoalView>>
  /** 目标的创建顺序；视图只保留最近 20 个。 */
  readonly goalOrder: readonly string[]
  /** 最近创建、仍在视图里的目标。 */
  readonly latestGoalId: string | undefined
  /** 最近创建、仍未结束的目标；最多一个。 */
  readonly openGoalId: string | undefined
  /** 父运行发起的子任务，按发生顺序（M4-05）。 */
  readonly delegations: readonly DelegationView[]
  /** 等待用户确认的记忆提议（M7-03），按提议顺序；确认、忽略或删除后移除。 */
  readonly memoryProposals: readonly MemoryProposalView[]
  readonly reviewLoops: readonly ReviewLoopView[]
  /** 会话里执行过的流水线（M7-08），按发生顺序。 */
  readonly pipelineRuns: readonly PipelineView[]
}

/** 当前未结束的目标（`active` 或 `paused`）。 */
export function openGoal(view: SessionView): GoalView | undefined {
  return view.openGoalId === undefined ? undefined : view.goals[view.openGoalId]
}

/**
 * 目标 `active`、最后一轮已完成、该轮还没有判定、会话没有活动运行。
 * 界面据此显示“判定中”；主进程的状态机不依赖它。
 */
export function isAwaitingGoalEvaluation(view: SessionView): boolean {
  const goal = openGoal(view)
  if (!goal || goal.status !== 'active') return false
  const turnId = goal.turnIds.at(-1)
  if (turnId === undefined) return false
  const run = rootRun(view)
  if (run === undefined || isActiveRunState(run.state)) return false
  if (run.turn?.turnId !== turnId || run.turn.status !== 'completed') return false
  return !goal.evaluations.some((evaluation) => evaluation.turnId === turnId)
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

export function createSessionView(sessionId: string): SessionView {
  return {
    sessionId,
    lastSeq: 0,
    info: undefined,
    archived: false,
    crash: undefined,
    runs: {},
    runOrder: [],
    messages: [],
    live: {},
    tools: {},
    liveToolOutput: {},
    usage: ZERO_USAGE,
    usageByTurn: {},
    contextTokens: undefined,
    checkpoints: [],
    restores: [],
    plans: [],
    taskLists: [],
    goals: {},
    goalOrder: [],
    latestGoalId: undefined,
    openGoalId: undefined,
    delegations: [],
    memoryProposals: [],
    reviewLoops: [],
    pipelineRuns: [],
  }
}

/** 依次归约一组事件。 */
export function reduceSessionEvents(
  view: SessionView,
  events: Iterable<EventEnvelope>,
): SessionView {
  let next = view
  for (const event of events) next = reduceSession(next, event)
  return next
}

/** 归约一条事件；被忽略的事件返回原对象。 */
export function reduceSession(view: SessionView, event: EventEnvelope): SessionView {
  if (event.sessionId !== view.sessionId) return view
  if (event.seq <= view.lastSeq) return view
  if (!isPersistedEvent(event)) return applyLive(view, event) ?? view
  const advanced: SessionView = { ...view, lastSeq: event.seq }
  const next = apply(advanced, event) ?? advanced
  return dropFinishedToolOutput(dropFinishedLive(next, event), event)
}

/** 合并一条增量事件；返回 `undefined` 表示忽略。 */
function applyLive(view: SessionView, event: LiveEvent): SessionView | undefined {
  if (event.type === 'tool.output.delta') return applyToolOutput(view, event)
  if (event.type === 'command.output.delta') return undefined
  const { messageId, text } = event.payload
  if (view.messages.some((m) => m.messageId === messageId)) return undefined
  const prev = view.live[messageId]
  if (prev && event.seq <= prev.lastDeltaSeq) return undefined
  const base: LiveMessageView = prev ?? {
    messageId,
    runId: event.runId,
    turnId: event.turnId,
    text: '',
    reasoning: '',
    lastDeltaSeq: 0,
    startedAt: event.ts,
  }
  const live: LiveMessageView =
    event.type === 'message.assistant.delta'
      ? { ...base, text: base.text + text, lastDeltaSeq: event.seq }
      : { ...base, reasoning: base.reasoning + text, lastDeltaSeq: event.seq }
  return { ...view, live: { ...view.live, [messageId]: live } }
}

/**
 * 持久化事件之后清理进行中的消息：完成事件移除对应消息；
 * 轮次结束移除该运行的全部进行中消息；宿主崩溃移除全部。
 */
function dropFinishedLive(view: SessionView, event: PersistedEvent): SessionView {
  const ids = Object.keys(view.live)
  if (ids.length === 0) return view
  let keep: (live: LiveMessageView) => boolean
  switch (event.type) {
    case 'message.assistant.completed':
      keep = (live) => live.messageId !== event.payload.messageId
      break
    case 'turn.completed':
    case 'turn.aborted':
    case 'turn.failed':
    case 'run.disposed':
      keep = (live) => live.runId !== event.runId
      break
    case 'session.crashed':
      keep = () => false
      break
    default:
      return view
  }
  const kept = ids.filter((id) => keep(view.live[id]!))
  if (kept.length === ids.length) return view
  return { ...view, live: Object.fromEntries(kept.map((id) => [id, view.live[id]!])) }
}

/** 合并一条工具输出增量：只接受尚未结束的已知调用。 */
function applyToolOutput(
  view: SessionView,
  event: Extract<LiveEvent, { type: 'tool.output.delta' }>,
): SessionView | undefined {
  const { toolCallId, stream, text } = event.payload
  const tool = view.tools[toolCallId]
  if (!tool || (tool.status !== 'requested' && tool.status !== 'running')) return undefined
  const prev = view.liveToolOutput[toolCallId]
  if (prev && event.seq <= prev.lastDeltaSeq) return undefined
  if (text === '') return undefined
  const chunks = [...(prev?.chunks ?? [])]
  const last = chunks.at(-1)
  if (last?.stream === stream) chunks[chunks.length - 1] = { stream, text: last.text + text }
  else chunks.push({ stream, text })
  let omitted = prev?.omittedChars ?? 0
  let total = chunks.reduce((n, c) => n + c.text.length, 0)
  while (total > MAX_LIVE_TOOL_OUTPUT_CHARS) {
    const first = chunks[0]!
    const excess = total - MAX_LIVE_TOOL_OUTPUT_CHARS
    if (first.text.length <= excess) {
      chunks.shift()
      omitted += first.text.length
      total -= first.text.length
    } else {
      chunks[0] = { stream: first.stream, text: first.text.slice(excess) }
      omitted += excess
      total -= excess
    }
  }
  const live: LiveToolOutputView = {
    toolCallId,
    runId: tool.runId,
    chunks,
    omittedChars: omitted,
    lastDeltaSeq: event.seq,
  }
  return { ...view, liveToolOutput: { ...view.liveToolOutput, [toolCallId]: live } }
}

/** 工具结束、轮次结束或宿主崩溃时丢弃实时输出（与进行中的消息相同）。 */
function dropFinishedToolOutput(view: SessionView, event: PersistedEvent): SessionView {
  const ids = Object.keys(view.liveToolOutput)
  if (ids.length === 0) return view
  let keep: (live: LiveToolOutputView) => boolean
  switch (event.type) {
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.cancelled':
      keep = (live) => live.toolCallId !== event.payload.toolCallId
      break
    case 'turn.completed':
    case 'turn.aborted':
    case 'turn.failed':
    case 'run.disposed':
      keep = (live) => live.runId !== event.runId
      break
    case 'session.crashed':
      keep = () => false
      break
    default:
      return view
  }
  const kept = ids.filter((id) => keep(view.liveToolOutput[id]!))
  if (kept.length === ids.length) return view
  return {
    ...view,
    liveToolOutput: Object.fromEntries(kept.map((id) => [id, view.liveToolOutput[id]!])),
  }
}

/** 更新一个尚未结束的工具调用。 */
function updateTool(
  view: SessionView,
  toolCallId: string,
  fn: (tool: ToolCallView) => ToolCallView,
): SessionView | undefined {
  const tool = view.tools[toolCallId]
  if (!tool || (tool.status !== 'requested' && tool.status !== 'running')) return undefined
  const next = fn(tool)
  return next === tool ? undefined : { ...view, tools: { ...view.tools, [toolCallId]: next } }
}

function stepsFrom(content: PlanDocument, previous: readonly PlanStepView[]): PlanStepView[] {
  return content.steps.map((step) => {
    const prior = previous.find((item) => item.id === step.id)
    return {
      id: step.id,
      title: step.title,
      status: prior?.status ?? 'pending',
      ...(prior?.note ? { note: prior.note } : {}),
    }
  })
}

function proposePlan(
  view: SessionView,
  event: EventEnvelope<'plan.proposed'>,
): SessionView | undefined {
  if (view.plans.some((plan) => plan.planId === event.payload.planId)) return undefined
  const plan: PlanView = {
    planId: event.payload.planId,
    content: event.payload.content,
    steps: stepsFrom(event.payload.content, []),
    status: 'proposed',
    seq: event.seq,
    runId: event.runId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
  }
  return { ...view, plans: [...view.plans, plan] }
}

function resolveTaskList(
  view: SessionView,
  listId: string,
  update: (list: TaskListView) => TaskListView | undefined,
): SessionView | undefined {
  const index = view.taskLists.findIndex((list) => list.listId === listId)
  if (index < 0) return undefined
  const next = update(view.taskLists[index]!)
  if (!next || next === view.taskLists[index]) return undefined
  const taskLists = view.taskLists.slice()
  taskLists[index] = next
  return { ...view, taskLists }
}

/** 整体修订：保留同 id 的进度与说明，移除的消失，新 id 从 `pending` 起。 */
function revisedItemViews(
  previous: readonly TaskItemView[],
  items: readonly { readonly itemId: string; readonly title: string }[],
): TaskItemView[] {
  return items.map((item) => {
    const prior = previous.find((entry) => entry.itemId === item.itemId)
    return {
      itemId: item.itemId,
      title: item.title,
      status: prior?.status ?? 'pending',
      ...(prior?.note ? { note: prior.note } : {}),
    }
  })
}

function resolvePlan(
  view: SessionView,
  planId: string,
  update: (plan: PlanView) => PlanView | undefined,
): SessionView | undefined {
  const index = view.plans.findIndex((plan) => plan.planId === planId)
  if (index < 0) return undefined
  const next = update(view.plans[index]!)
  if (!next || next === view.plans[index]) return undefined
  const plans = view.plans.slice()
  plans[index] = next
  return { ...view, plans }
}

/** 返回 `undefined` 表示事件内容被忽略（只推进 lastSeq）。 */
function apply(view: SessionView, event: PersistedEvent): SessionView | undefined {
  switch (event.type) {
    case 'session.created': {
      if (view.info) return undefined
      const { projectId, projectPath, workspacePath, title, model } = event.payload
      return {
        ...view,
        info: {
          projectId,
          projectPath,
          workspacePath,
          title,
          model,
          thinkingLevel: undefined,
          team: undefined,
          createdAt: event.ts,
        },
      }
    }
    case 'session.renamed':
      return view.info ? { ...view, info: { ...view.info, title: event.payload.title } } : undefined
    case 'session.model.changed':
      return view.info ? { ...view, info: { ...view.info, model: event.payload.model } } : undefined
    case 'session.team.changed':
      return view.info ? { ...view, info: { ...view.info, team: event.payload.team } } : undefined
    case 'session.thinkingLevel.changed':
      return view.info
        ? { ...view, info: { ...view.info, thinkingLevel: event.payload.thinkingLevel } }
        : undefined
    case 'session.archived':
      return { ...view, archived: true }
    case 'session.unarchived':
      return { ...view, archived: false }
    case 'checkpoint.created': {
      const checkpoint: CheckpointView = {
        checkpointId: event.payload.checkpointId,
        reason: event.payload.reason,
        seq: event.seq,
        runId: event.runId,
        turnId: event.turnId,
        createdAt: event.ts,
      }
      return { ...view, checkpoints: [...view.checkpoints, checkpoint] }
    }
    case 'checkpoint.restored': {
      const restore: RestoreView = {
        checkpointId: event.payload.checkpointId,
        seq: event.seq,
        ts: event.ts,
      }
      return { ...view, restores: [...view.restores, restore] }
    }
    case 'session.crashed':
      return { ...view, crash: event.payload.error }

    case 'run.created': {
      if (view.runs[event.runId]) return undefined
      const run: RunView = {
        runId: event.runId,
        parentRunId: event.parentRunId,
        ...event.payload,
        state: 'idle',
        createdAt: event.ts,
        seq: event.seq,
        turn: undefined,
        usage: ZERO_USAGE,
      }
      return {
        ...view,
        runs: { ...view.runs, [run.runId]: run },
        runOrder: [...view.runOrder, run.runId],
      }
    }
    case 'run.state.changed':
      return updateRun(view, event.runId, (run) =>
        canTransition(run.state, event.payload.to)
          ? { ...run, state: event.payload.to }
          : undefined,
      )
    case 'run.disposed':
      return updateRun(view, event.runId, (run) =>
        run.state === 'disposed' ? undefined : { ...run, state: 'disposed' },
      )

    case 'run.delegated': {
      if (view.delegations.some((item) => item.childRunId === event.payload.childRunId)) {
        return undefined
      }
      const delegation: DelegationView = {
        childRunId: event.payload.childRunId,
        parentRunId: event.runId,
        agent: event.payload.agent,
        task: event.payload.task,
        workspace: event.payload.workspace,
        workspacePath: event.payload.workspacePath,
        budget: event.payload.budget,
        turnId: event.turnId,
        createdAt: event.ts,
        completed: undefined,
      }
      return { ...view, delegations: [...view.delegations, delegation] }
    }
    case 'run.child.completed': {
      const index = view.delegations.findIndex(
        (item) => item.childRunId === event.payload.childRunId,
      )
      if (index < 0) return undefined
      const current = view.delegations[index]!
      const completed: DelegationView['completed'] = {
        status: event.payload.status,
        summary: event.payload.summary,
        usage: event.payload.usage,
        changeSetId: event.payload.changeSetId,
        issues: event.payload.issues,
      }
      return {
        ...view,
        delegations: view.delegations.with(index, { ...current, completed }),
      }
    }

    case 'turn.started': {
      const { turnId } = event
      if (turnId === undefined) return undefined
      const loaded = event.payload.context?.agentsMd
      const withTurn = updateRun(view, event.runId, (run) =>
        run.turn?.turnId === turnId ? undefined : { ...run, turn: newTurn(turnId, event.ts) },
      )
      const next = attachPendingUserMessage(withTurn ?? view, event.runId, turnId)
      let result: SessionView | undefined
      // 重复的 turn.started，而且标记不用变：只推进 seq
      if (next !== view || view.agentsMd !== undefined || loaded !== undefined) {
        const { agentsMd: _previous, ...rest } = next
        result = {
          ...rest,
          crash: undefined,
          ...(loaded ? { agentsMd: { lines: loaded.lines, truncated: loaded.truncated } } : {}),
        }
      }
      return trackGoalTurn(result ?? view, event) ?? result
    }
    case 'turn.completed':
      return endTurn(view, event, { status: 'completed', durationMs: event.payload.durationMs })
    case 'turn.aborted':
      return endTurn(view, event, { status: 'aborted', abortReason: event.payload.reason })
    case 'turn.failed':
      return endTurn(view, event, {
        status: 'failed',
        error: event.payload.error,
        retryable: event.payload.retryable,
      })
    case 'turn.limit_reached':
      return updateTurn(view, event, (turn) =>
        turn.status === 'running' ? { ...turn, limitReached: { ...event.payload } } : undefined,
      )
    case 'model.retry':
      return updateTurn(view, event, (turn) =>
        turn.status === 'running'
          ? { ...turn, retry: { ...event.payload, at: event.ts } }
          : undefined,
      )

    case 'step.started': {
      const { stepId } = event
      if (stepId === undefined) return undefined
      return updateTurn(view, event, (turn) =>
        turn.status !== 'running' || turn.step?.stepId === stepId
          ? undefined
          : {
              ...turn,
              retry: undefined,
              stepCount: turn.stepCount + 1,
              step: {
                stepId,
                model: event.payload.model,
                status: 'running',
                startedAt: event.ts,
                finishReason: undefined,
                durationMs: undefined,
              },
            },
      )
    }
    case 'step.completed':
      return updateTurn(view, event, (turn) => {
        const { step } = turn
        if (!step || step.stepId !== event.stepId || step.status !== 'running') return undefined
        const { finishReason, durationMs } = event.payload
        return { ...turn, step: { ...step, status: 'completed', finishReason, durationMs } }
      })

    case 'message.user': {
      // 只借用正在进行的轮次，避免把下一轮输入误挂到上一轮已完成的消息上。
      // 正常顺序是 message.user 先落库、turn.started 后到；宿主恢复等情况下也可能反过来。
      const run = view.runs[event.runId]
      const turnId = event.turnId ?? (run?.turn?.status === 'running' ? run.turn.turnId : undefined)
      const next = upsertMessage(view, {
        role: 'user',
        ...meta(event, event.payload.messageId, turnId),
        content: event.payload.content,
        ...(event.payload.origin !== undefined ? { origin: event.payload.origin } : {}),
        ...(event.payload.goalId !== undefined ? { goalId: event.payload.goalId } : {}),
        mentions: event.payload.mentions ?? [],
        skills: event.payload.skills ?? [],
        agents: event.payload.agents ?? [],
      })
      return anchorGoalMessage(next, event.seq, event.payload.origin)
    }
    case 'message.assistant.completed': {
      const { messageId, content, reasoning, toolCalls, model, incomplete } = event.payload
      return upsertMessage(view, {
        role: 'assistant',
        ...meta(event, messageId),
        content,
        reasoning,
        toolCalls: toolCalls ?? [],
        model,
        incomplete: incomplete ?? false,
      })
    }

    case 'conversation.rewound':
      return rewindView(view, event)

    case 'plan.proposed':
      return proposePlan(view, event)
    case 'plan.approved':
      return resolvePlan(view, event.payload.planId, (plan) => {
        if (plan.status !== 'proposed') return undefined
        const content = event.payload.content ?? plan.content
        return {
          ...plan,
          content,
          steps: stepsFrom(content, plan.steps),
          status: 'approved',
        }
      })
    case 'plan.rejected':
      return resolvePlan(view, event.payload.planId, (plan) => {
        if (plan.status !== 'proposed') return undefined
        return {
          ...plan,
          status: 'rejected',
          ...(event.payload.feedback ? { feedback: event.payload.feedback } : {}),
        }
      })
    case 'plan.steps.revised':
      return resolvePlan(view, event.payload.planId, (plan) => {
        if (plan.status !== 'approved') return undefined
        const content = { ...plan.content, steps: event.payload.steps, markdown: '' }
        return { ...plan, content, steps: stepsFrom(content, plan.steps) }
      })
    case 'plan.step.updated':
      return resolvePlan(view, event.payload.planId, (plan) => {
        if (plan.status !== 'approved') return undefined
        // 修订后步骤位置可能变了：有 id 时按 id 定位，旧事件没有 id 才用 index。
        const index =
          event.payload.stepId === undefined
            ? event.payload.stepIndex
            : plan.steps.findIndex((step) => step.id === event.payload.stepId)
        const current = plan.steps[index]
        if (index < 0 || !current) return undefined
        const note = event.payload.note?.trim()
        const steps = plan.steps.map((step, i) =>
          i === index
            ? {
                ...step,
                status: event.payload.status,
                ...(note ? { note } : step.note ? { note: step.note } : {}),
              }
            : step,
        )
        return { ...plan, steps }
      })

    case 'tasklist.created': {
      const { listId, title, source, planId, items } = event.payload
      if (view.taskLists.some((list) => list.listId === listId)) return undefined
      if (new Set(items.map((item) => item.itemId)).size !== items.length) return undefined
      const list: TaskListView = {
        listId,
        title,
        source,
        ...(planId ? { planId } : {}),
        items: items.map((item) => ({
          itemId: item.itemId,
          title: item.title,
          status: 'pending',
        })),
        closed: false,
        seq: event.seq,
        runId: event.runId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
      }
      return { ...view, taskLists: [...view.taskLists, list] }
    }
    case 'tasklist.items.revised':
      return resolveTaskList(view, event.payload.listId, (list) => {
        if (list.closed) return undefined
        const { items } = event.payload
        if (new Set(items.map((item) => item.itemId)).size !== items.length) return undefined
        return { ...list, items: revisedItemViews(list.items, items) }
      })
    case 'tasklist.item.updated':
      return resolveTaskList(view, event.payload.listId, (list) => {
        if (list.closed) return undefined
        const index = list.items.findIndex((item) => item.itemId === event.payload.itemId)
        const current = list.items[index]
        if (!current) return undefined
        const note = event.payload.note?.trim()
        return {
          ...list,
          items: list.items.with(index, {
            ...current,
            status: event.payload.status,
            ...(note ? { note } : current.note ? { note: current.note } : {}),
          }),
        }
      })
    case 'tasklist.closed':
      return resolveTaskList(view, event.payload.listId, (list) =>
        list.closed ? undefined : { ...list, closed: true },
      )

    case 'goal.created': {
      const { goalId, condition, limits } = event.payload
      if (view.goals[goalId] !== undefined || openGoal(view) !== undefined) return undefined
      const goal: GoalView = {
        goalId,
        condition,
        limits,
        status: 'active',
        seq: event.seq,
        createdAt: event.ts,
        initialMessageSeq: undefined,
        activeMs: 0,
        activeSince: event.ts,
        turnIds: [],
        evaluations: [],
        lifecycle: [{ seq: event.seq, at: event.ts, kind: 'created' }],
        pauseReason: undefined,
        pauseDetail: undefined,
        endReason: undefined,
        endDetail: undefined,
        endedAt: undefined,
        endedTurnId: undefined,
      }
      return addGoal(view, goal)
    }
    case 'goal.paused': {
      const { reason, detail } = event.payload
      return updateGoal(view, event.payload.goalId, (goal) => {
        if (goal.status !== 'active') return undefined
        const elapsed =
          goal.activeSince === undefined ? 0 : Math.max(0, event.ts - goal.activeSince)
        return {
          ...goal,
          status: 'paused',
          activeMs: goal.activeMs + elapsed,
          activeSince: undefined,
          pauseReason: reason,
          pauseDetail: detail,
          lifecycle: [
            ...goal.lifecycle,
            {
              seq: event.seq,
              at: event.ts,
              kind: 'paused',
              reason,
              ...(detail !== undefined ? { detail } : {}),
            },
          ],
        }
      })
    }
    case 'goal.resumed':
      return updateGoal(view, event.payload.goalId, (goal) => {
        if (goal.status !== 'paused') return undefined
        return {
          ...goal,
          status: 'active',
          activeSince: event.ts,
          pauseReason: undefined,
          pauseDetail: undefined,
          lifecycle: [...goal.lifecycle, { seq: event.seq, at: event.ts, kind: 'resumed' }],
        }
      })
    case 'goal.evaluated': {
      const { goalId, verdict, reason, evidence, model } = event.payload
      return updateGoal(view, goalId, (goal) => {
        if (goal.status === 'ended') return undefined
        if (
          event.turnId !== undefined &&
          goal.evaluations.some((item) => item.turnId === event.turnId)
        ) {
          return undefined
        }
        return {
          ...goal,
          evaluations: [
            ...goal.evaluations,
            {
              turnId: event.turnId,
              verdict,
              reason,
              evidence: evidence ?? [],
              model,
              seq: event.seq,
              at: event.ts,
            },
          ],
        }
      })
    }
    case 'goal.ended':
      return updateGoal(view, event.payload.goalId, (goal) => {
        if (goal.status === 'ended') return undefined
        const { reason, detail, turns, durationMs } = event.payload
        return {
          ...goal,
          status: 'ended',
          activeMs: durationMs,
          activeSince: undefined,
          endReason: reason,
          endDetail: detail,
          endedAt: event.ts,
          endedTurnId: event.turnId,
          lifecycle: [
            ...goal.lifecycle,
            {
              seq: event.seq,
              at: event.ts,
              kind: 'ended',
              reason,
              turns,
              durationMs,
              ...(detail !== undefined ? { detail } : {}),
            },
          ],
        }
      })

    case 'memory.proposed': {
      const { memoryId, scope, content, sourceAgentId } = event.payload
      if (view.memoryProposals.some((item) => item.memoryId === memoryId)) return undefined
      return {
        ...view,
        memoryProposals: [
          ...view.memoryProposals,
          {
            memoryId,
            scope,
            content,
            sourceAgentId,
            runId: event.runId,
            createdAt: event.ts,
          },
        ],
      }
    }
    case 'team.review.round': {
      const { reviewId, round, makerRunId, checkerRunId, verdict, feedback } = event.payload
      const entry: ReviewRoundView = {
        round,
        makerRunId,
        checkerRunId,
        verdict,
        ...(feedback === undefined ? {} : { feedback }),
      }
      const existing = view.reviewLoops.find((item) => item.reviewId === reviewId)
      if (existing) {
        if (existing.rounds.some((item) => item.round === round)) return undefined
        return {
          ...view,
          reviewLoops: view.reviewLoops.map((item) =>
            item.reviewId === reviewId ? { ...item, rounds: [...item.rounds, entry] } : item,
          ),
        }
      }
      return {
        ...view,
        reviewLoops: [
          ...view.reviewLoops,
          {
            reviewId,
            runId: event.runId,
            turnId: event.turnId,
            seq: event.seq,
            rounds: [entry],
            status: undefined,
            summary: undefined,
          },
        ],
      }
    }
    case 'team.review.completed': {
      const { reviewId, status, summary } = event.payload
      const completed = (item: ReviewLoopView): ReviewLoopView => ({
        ...item,
        status,
        ...(summary === undefined ? {} : { summary }),
      })
      const existing = view.reviewLoops.find((item) => item.reviewId === reviewId)
      if (existing) {
        return {
          ...view,
          reviewLoops: view.reviewLoops.map((item) =>
            item.reviewId === reviewId ? completed(item) : item,
          ),
        }
      }
      // 第一轮就失败（maker 或 checker 没拿到判定）时不会发出轮次事件，完成事件要能补出这段循环。
      return {
        ...view,
        reviewLoops: [
          ...view.reviewLoops,
          completed({
            reviewId,
            runId: event.runId,
            turnId: event.turnId,
            seq: event.seq,
            rounds: [],
            status: undefined,
            summary: undefined,
          }),
        ],
      }
    }

    case 'team.pipeline.stage': {
      const { pipelineId, stage, agentRunId, status, summary } = event.payload
      const entry: PipelineStageView = {
        stage,
        agentRunId,
        status,
        ...(summary === undefined ? {} : { summary }),
      }
      const existing = view.pipelineRuns.find((item) => item.pipelineId === pipelineId)
      if (existing) {
        if (existing.stages.some((item) => item.stage === stage)) return undefined
        return {
          ...view,
          pipelineRuns: view.pipelineRuns.map((item) =>
            item.pipelineId === pipelineId ? { ...item, stages: [...item.stages, entry] } : item,
          ),
        }
      }
      return {
        ...view,
        pipelineRuns: [
          ...view.pipelineRuns,
          {
            pipelineId,
            runId: event.runId,
            turnId: event.turnId,
            seq: event.seq,
            stages: [entry],
            status: undefined,
            skipped: [],
            summary: undefined,
          },
        ],
      }
    }
    case 'team.pipeline.completed': {
      const { pipelineId, status, skipped, summary } = event.payload
      const completed = (item: PipelineView): PipelineView => ({
        ...item,
        status,
        skipped,
        ...(summary === undefined ? {} : { summary }),
      })
      const existing = view.pipelineRuns.find((item) => item.pipelineId === pipelineId)
      if (existing) {
        return {
          ...view,
          pipelineRuns: view.pipelineRuns.map((item) =>
            item.pipelineId === pipelineId ? completed(item) : item,
          ),
        }
      }
      // 一个阶段都没跑（例如阶段列表非法）时补出这条流水线，界面仍能看到失败原因。
      return {
        ...view,
        pipelineRuns: [
          ...view.pipelineRuns,
          completed({
            pipelineId,
            runId: event.runId,
            turnId: event.turnId,
            seq: event.seq,
            stages: [],
            status: undefined,
            skipped: [],
            summary: undefined,
          }),
        ],
      }
    }

    // 确认、忽略、删除都会让提议从界面上消失；`auto` 写入只有 accepted，没有提议可移除。
    case 'memory.accepted':
    case 'memory.rejected':
    case 'memory.deleted': {
      const remaining = view.memoryProposals.filter(
        (item) => item.memoryId !== event.payload.memoryId,
      )
      return remaining.length === view.memoryProposals.length
        ? undefined
        : { ...view, memoryProposals: remaining }
    }

    case 'session.brief.updated': {
      const content = event.payload.content.trim()
      if (!content) {
        if (!view.brief) return undefined
        const { brief: _brief, ...rest } = view
        return rest
      }
      if (view.brief?.content === content && view.brief.editedBy === event.payload.editedBy) {
        return undefined
      }
      return { ...view, brief: { content, editedBy: event.payload.editedBy } }
    }

    case 'context.compacted': {
      const { summary, tokensAfter, degraded, omittedToolCallIds } = event.payload
      const dropping = degraded === true || (omittedToolCallIds?.length ?? 0) > 0
      return {
        ...view,
        ...(tokensAfter === undefined ? {} : { contextTokens: tokensAfter }),
        ...(!degraded && summary.trim() !== '' ? { compaction: { summary, seq: event.seq } } : {}),
        ...(view.toolOutputOmitted || !dropping ? {} : { toolOutputOmitted: { seq: event.seq } }),
      }
    }

    case 'usage.reported': {
      const usage = event.payload.usage
      const withRun = updateRun(view, event.runId, (run) => ({
        ...run,
        usage: addUsage(run.usage, usage),
      }))
      const turnId = event.turnId
      return {
        ...(withRun ?? view),
        usage: addUsage(view.usage, usage),
        contextTokens: event.payload.auxiliary
          ? view.contextTokens
          : usage.inputTokens + usage.outputTokens,
        ...(turnId === undefined
          ? {}
          : {
              usageByTurn: {
                ...view.usageByTurn,
                [turnId]: addUsage(view.usageByTurn[turnId] ?? ZERO_USAGE, usage),
              },
            }),
      }
    }

    case 'tool.requested': {
      const { toolCallId, name, input } = event.payload
      if (view.tools[toolCallId]) return undefined
      const tool: ToolCallView = {
        toolCallId,
        runId: event.runId,
        turnId: event.turnId,
        name,
        input,
        status: 'requested',
        requestedAt: event.ts,
        output: undefined,
        display: undefined,
        sandbox: undefined,
        truncated: false,
        error: undefined,
        cancelReason: undefined,
        durationMs: undefined,
      }
      return { ...view, tools: { ...view.tools, [toolCallId]: tool } }
    }
    case 'tool.started':
      return updateTool(view, event.payload.toolCallId, (tool) =>
        tool.status === 'running'
          ? tool
          : { ...tool, status: 'running', sandbox: event.payload.sandbox ?? tool.sandbox },
      )
    case 'tool.completed': {
      const { toolCallId, output, truncated, durationMs, display } = event.payload
      return updateTool(view, toolCallId, (tool) => ({
        ...tool,
        status: 'completed',
        output,
        display,
        sandbox: display?.sandbox ?? tool.sandbox,
        truncated: truncated ?? false,
        durationMs,
      }))
    }
    case 'tool.failed':
      return updateTool(view, event.payload.toolCallId, (tool) => ({
        ...tool,
        status: 'failed',
        error: event.payload.error,
      }))
    case 'tool.cancelled':
      return updateTool(view, event.payload.toolCallId, (tool) => ({
        ...tool,
        status: 'cancelled',
        cancelReason: event.payload.reason,
      }))

    default:
      // 审批、检查点等事件由后续阶段的投影处理。
      return undefined
  }
}

function newTurn(turnId: string, ts: number): TurnView {
  return {
    turnId,
    status: 'running',
    startedAt: ts,
    endedAt: undefined,
    stepCount: 0,
    step: undefined,
    durationMs: undefined,
    abortReason: undefined,
    error: undefined,
    retryable: undefined,
    limitReached: undefined,
    retry: undefined,
  }
}

function updateRun(
  view: SessionView,
  runId: string,
  fn: (run: RunView) => RunView | undefined,
): SessionView | undefined {
  const run = view.runs[runId]
  if (!run) return undefined
  const next = fn(run)
  return next && { ...view, runs: { ...view.runs, [runId]: next } }
}

/** 只更新事件 `turnId` 所指的当前轮次。 */
function updateTurn(
  view: SessionView,
  event: PersistedEvent,
  fn: (turn: TurnView) => TurnView | undefined,
): SessionView | undefined {
  return updateRun(view, event.runId, (run) => {
    if (!run.turn || run.turn.turnId !== event.turnId) return undefined
    const turn = fn(run.turn)
    return turn && { ...run, turn }
  })
}

function endTurn(
  view: SessionView,
  event: PersistedEvent,
  patch: Partial<TurnView> & { status: Exclude<TurnStatus, 'running'> },
): SessionView | undefined {
  return updateTurn(view, event, (turn) =>
    turn.status === 'running'
      ? { ...turn, ...patch, retry: undefined, endedAt: event.ts }
      : undefined,
  )
}

function meta(event: PersistedEvent, messageId: string, turnId = event.turnId): MessageMeta {
  return { messageId, runId: event.runId, turnId, seq: event.seq, ts: event.ts }
}

/** 主进程先落库的用户消息没有 turnId；轮次开始后把同运行最近的一条补上，供定位使用。 */
function attachPendingUserMessage(view: SessionView, runId: string, turnId: string): SessionView {
  for (let index = view.messages.length - 1; index >= 0; index -= 1) {
    const message = view.messages[index]!
    if (message.role !== 'user' || message.runId !== runId || message.turnId !== undefined) {
      continue
    }
    return {
      ...view,
      messages: view.messages.with(index, { ...message, turnId }),
    }
  }
  return view
}

/** 新消息追加到末尾；同一 messageId 已存在时原位替换（保持显示顺序）。 */
function upsertMessage(view: SessionView, message: MessageView): SessionView {
  const index = view.messages.findIndex((m) => m.messageId === message.messageId)
  const messages = index === -1 ? [...view.messages, message] : view.messages.with(index, message)
  return { ...view, messages }
}

/** 投影最多保留的目标数；超出的只淘汰最早结束的目标。 */
const GOAL_VIEW_LIMIT = 20

/** 由目标表与顺序重算派生 id，并裁掉过期的已结束目标。 */
function syncGoals(
  goals: Readonly<Record<string, GoalView>>,
  order: readonly string[],
): Pick<SessionView, 'goals' | 'goalOrder' | 'latestGoalId' | 'openGoalId'> {
  const goalOrder = order.filter((goalId) => goals[goalId] !== undefined)
  while (goalOrder.length > GOAL_VIEW_LIMIT) {
    const index = goalOrder.findIndex((goalId) => goals[goalId]?.status === 'ended')
    if (index < 0) break
    goalOrder.splice(index, 1)
  }
  const kept: Record<string, GoalView> = {}
  let latestGoalId: string | undefined
  let openGoalId: string | undefined
  for (const goalId of goalOrder) {
    const goal = goals[goalId]
    if (goal === undefined) continue
    kept[goalId] = goal
    latestGoalId = goalId
    if (goal.status !== 'ended') openGoalId = goalId
  }
  return { goals: kept, goalOrder, latestGoalId, openGoalId }
}

function addGoal(view: SessionView, goal: GoalView): SessionView {
  return {
    ...view,
    ...syncGoals({ ...view.goals, [goal.goalId]: goal }, [...view.goalOrder, goal.goalId]),
  }
}

function updateGoal(
  view: SessionView,
  goalId: string,
  fn: (goal: GoalView) => GoalView | undefined,
): SessionView | undefined {
  const goal = view.goals[goalId]
  if (goal === undefined) return undefined
  const next = fn(goal)
  if (next === undefined) return undefined
  return { ...view, ...syncGoals({ ...view.goals, [goalId]: next }, view.goalOrder) }
}

/**
 * 目标的第一个用户输入决定目标代表哪段对话（ADR-0047）。自动续轮不锚定；
 * 重新生成首条消息后投影清空了字段，紧随其后的重发会重新锚定（即使目标已暂停）。
 */
function anchorGoalMessage(
  view: SessionView,
  seq: number,
  origin: 'user' | 'goal' | undefined,
): SessionView {
  if (origin === 'goal') return view
  const goal = openGoal(view)
  if (goal === undefined || goal.initialMessageSeq !== undefined) return view
  return (
    updateGoal(view, goal.goalId, (current) =>
      current.initialMessageSeq === undefined ? { ...current, initialMessageSeq: seq } : undefined,
    ) ?? view
  )
}

/** 根运行开始的轮次计入目标预算；暂停期间与子运行的轮次不计数。 */
function trackGoalTurn(
  view: SessionView,
  event: EventEnvelope<'turn.started'>,
): SessionView | undefined {
  if (event.parentRunId !== undefined || event.turnId === undefined) return undefined
  const goal = openGoal(view)
  if (goal === undefined || goal.status !== 'active' || goal.turnIds.includes(event.turnId)) {
    return undefined
  }
  const turnId = event.turnId
  return updateGoal(view, goal.goalId, (current) =>
    current.status === 'active' && !current.turnIds.includes(turnId)
      ? { ...current, turnIds: [...current.turnIds, turnId] }
      : undefined,
  )
}

function subtractUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  }
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    sum.cacheReadTokens = Math.max(0, (a.cacheReadTokens ?? 0) - (b.cacheReadTokens ?? 0))
  }
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) {
    sum.reasoningTokens = Math.max(0, (a.reasoningTokens ?? 0) - (b.reasoningTokens ?? 0))
  }
  return sum
}

/**
 * 回退对目标的影响（ADR-0047）：
 * - 目标创建于回退区间，或编辑到目标首条消息：目标从投影移除。
 * - 已结束的目标不因回退复活；结束卡挂载的轮次被回退时清空挂载点。
 * - 其余目标按 `seq` 过滤生命周期事件后重放，重算活动时长与暂停原因；回退区间内的判定与
 *   轮次一并过滤，首条消息被回退时清空锚点。
 * - 保留下来的目标若仍 `active`，由主进程在回退的同一同步段写 `paused(rewind)`。
 */
function rewindGoals(
  view: SessionView,
  event: EventEnvelope<'conversation.rewound'>,
  removedTurns: ReadonlySet<string>,
): Pick<SessionView, 'goals' | 'goalOrder' | 'latestGoalId' | 'openGoalId'> {
  const { fromSeq } = event.payload
  const goals: Record<string, GoalView> = {}
  const goalOrder: string[] = []
  for (const goalId of view.goalOrder) {
    const goal = view.goals[goalId]
    if (goal === undefined || goal.seq >= fromSeq) continue
    if (
      event.payload.reason === 'edit' &&
      goal.initialMessageSeq !== undefined &&
      goal.initialMessageSeq >= fromSeq
    ) {
      continue
    }
    goals[goalId] = rewindGoal(goal, fromSeq, removedTurns)
    goalOrder.push(goalId)
  }
  return syncGoals(goals, goalOrder)
}

function rewindGoal(goal: GoalView, fromSeq: number, removedTurns: ReadonlySet<string>): GoalView {
  const lifecycle = goal.lifecycle.filter((entry) => entry.seq < fromSeq)
  const turnIds = goal.turnIds.filter((turnId) => !removedTurns.has(turnId))
  const evaluations = goal.evaluations.filter((evaluation) => evaluation.seq < fromSeq)
  const initialMessageSeq =
    goal.initialMessageSeq !== undefined && goal.initialMessageSeq < fromSeq
      ? goal.initialMessageSeq
      : undefined
  const endedTurnId =
    goal.endedTurnId !== undefined && !removedTurns.has(goal.endedTurnId)
      ? goal.endedTurnId
      : undefined

  if (goal.status === 'ended') {
    // 结束不因回退撤销；即使 goal.ended 落在回退区间，也保留在生命周期里。
    const ended = goal.lifecycle.findLast((entry) => entry.kind === 'ended')
    return {
      ...goal,
      lifecycle:
        ended === undefined || lifecycle.includes(ended) ? lifecycle : [...lifecycle, ended],
      turnIds,
      evaluations,
      initialMessageSeq,
      endedTurnId,
    }
  }

  let status: GoalStatus = 'active'
  let activeMs = 0
  let activeSince: number | undefined = goal.createdAt
  let pauseReason: GoalPauseReason | undefined
  let pauseDetail: string | undefined
  for (const entry of lifecycle) {
    if (entry.kind === 'paused' && status === 'active') {
      activeMs += Math.max(0, entry.at - (activeSince ?? entry.at))
      activeSince = undefined
      status = 'paused'
      pauseReason = entry.reason as GoalPauseReason | undefined
      pauseDetail = entry.detail
    } else if (entry.kind === 'resumed' && status === 'paused') {
      status = 'active'
      activeSince = entry.at
      pauseReason = undefined
      pauseDetail = undefined
    }
  }
  return {
    ...goal,
    status,
    activeMs,
    activeSince,
    pauseReason,
    pauseDetail,
    lifecycle,
    turnIds,
    evaluations,
    initialMessageSeq,
    endedTurnId,
  }
}

/**
 * 回退对话（`conversation.rewound`，编辑重发 / 重新生成）：丢掉 `fromSeq` 及之后在投影里的结果。
 *
 * - 消息、检查点、恢复、计划、待办、审查循环、流水线与用量按 seq 过滤；轮次相关的条目按
 *   `turnId` 兜底。被回退的一轮在运行上的 `turn` 一并清掉，新的输入重新开一轮。
 * - 回退点之后创建的运行（含子运行）移除；保留下来的运行如果仍停在运行中，回到 `idle`。
 * - 进行中的消息与工具输出只在运行中才有意义，回退时只保留未受影响的那些。
 * - 工作区文件与检查点日志本身不受影响；这里只改变对话投影。
 */
function rewindView(view: SessionView, event: EventEnvelope<'conversation.rewound'>): SessionView {
  const { fromSeq } = event.payload
  const removedMessages = view.messages.filter((message) => message.seq >= fromSeq)
  const removedTurns = new Set(
    removedMessages.flatMap((message) => (message.turnId === undefined ? [] : [message.turnId])),
  )
  // 运行按创建 seq 判断：回退点之前创建的是同一段对话，保留下来重新开始一轮；回退点之后
  // （含子运行）才移除。不能用“消息被回退”来判断——根运行同时承载被回退与保留的轮次。
  const messageRuns = new Set(removedMessages.map((message) => message.runId))
  const removedRuns = new Set<string>()
  const beforeSeq = <T extends { readonly seq: number }>(items: readonly T[]): readonly T[] =>
    items.filter((item) => item.seq < fromSeq)
  const keep = <T>(items: readonly T[], removed: (item: T) => boolean): readonly T[] =>
    items.filter((item) => !removed(item))

  const runOrder = view.runOrder.filter((runId) => {
    const run = view.runs[runId]
    if (run === undefined) return false
    const removed =
      run.seq !== undefined
        ? run.seq >= fromSeq
        : run.parentRunId !== undefined &&
          (messageRuns.has(runId) || messageRuns.has(run.parentRunId))
    if (removed) removedRuns.add(runId)
    return !removed
  })
  const runs: Record<string, RunView> = {}
  for (const runId of runOrder) {
    const run = view.runs[runId]!
    const turn = run.turn !== undefined && removedTurns.has(run.turn.turnId) ? undefined : run.turn
    const state = isActiveRunState(run.state) ? 'idle' : run.state
    runs[runId] = turn === run.turn && state === run.state ? run : { ...run, turn, state }
  }

  const messages = keep(view.messages, (message) => message.seq >= fromSeq)
  const tools = Object.fromEntries(
    Object.entries(view.tools).filter(([, tool]) =>
      tool.turnId === undefined ? tool.requestedAt < event.ts : !removedTurns.has(tool.turnId),
    ),
  )
  const live = Object.fromEntries(
    Object.entries(view.live).filter(([, message]) =>
      message.turnId === undefined
        ? message.startedAt < event.ts
        : !removedTurns.has(message.turnId),
    ),
  )
  const liveToolOutput = Object.fromEntries(
    Object.entries(view.liveToolOutput).filter(([toolCallId]) => tools[toolCallId] !== undefined),
  )

  const usageByTurn: Record<string, TokenUsage> = {}
  let usage = view.usage
  for (const [turnId, value] of Object.entries(view.usageByTurn)) {
    if (removedTurns.has(turnId)) usage = subtractUsage(usage, value)
    else usageByTurn[turnId] = value
  }

  const plans = keep(beforeSeq(view.plans), (plan) => isRemovedTurn(plan.turnId, removedTurns))
  const taskLists = keep(beforeSeq(view.taskLists), (list) =>
    isRemovedTurn(list.turnId, removedTurns),
  )
  const reviewLoops = keep(beforeSeq(view.reviewLoops), (loop) =>
    isRemovedTurn(loop.turnId, removedTurns),
  )
  const pipelineRuns = keep(beforeSeq(view.pipelineRuns), (pipeline) =>
    isRemovedTurn(pipeline.turnId, removedTurns),
  )
  const delegations = keep(
    view.delegations,
    (delegation) =>
      removedRuns.has(delegation.childRunId) ||
      removedRuns.has(delegation.parentRunId) ||
      (delegation.turnId === undefined
        ? delegation.createdAt >= event.ts
        : removedTurns.has(delegation.turnId)),
  )
  const memoryProposals = keep(
    view.memoryProposals,
    (proposal) => removedRuns.has(proposal.runId) || proposal.createdAt >= event.ts,
  )

  // 最近一轮的 AGENTS.md 标记属于被回退的那一轮；下一次输入会重新读取。
  const {
    agentsMd: _agentsMd,
    compaction: _compaction,
    toolOutputOmitted: _omitted,
    ...rest
  } = view
  return {
    ...rest,
    ...rewindGoals(view, event, removedTurns),
    runs,
    runOrder,
    messages,
    tools,
    live,
    liveToolOutput,
    usage,
    usageByTurn,
    checkpoints: beforeSeq(view.checkpoints),
    restores: beforeSeq(view.restores),
    plans,
    taskLists,
    delegations,
    memoryProposals,
    reviewLoops,
    pipelineRuns,
    crash: undefined,
    ...(view.compaction !== undefined && view.compaction.seq < fromSeq
      ? { compaction: view.compaction }
      : {}),
    ...(view.toolOutputOmitted !== undefined && view.toolOutputOmitted.seq < fromSeq
      ? { toolOutputOmitted: view.toolOutputOmitted }
      : {}),
  }
}

function isRemovedTurn(turnId: string | undefined, removed: ReadonlySet<string>): boolean {
  return turnId !== undefined && removed.has(turnId)
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  }
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) {
    sum.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
  }
  return sum
}

/** 最近创建的顶层运行（无 `parentRunId`）；会话的状态与输入都以它为准。 */
export function rootRun(view: SessionView): RunView | undefined {
  return view.runOrder
    .map((id) => view.runs[id])
    .findLast((run) => run !== undefined && run.parentRunId === undefined)
}

/**
 * 会话在列表中显示的状态（`SessionStatus`）。
 * 以最近创建的顶层运行（`rootRun`）为准；归档与崩溃优先。
 */
export function sessionStatus(view: SessionView): SessionStatus {
  if (view.archived) return 'archived'
  if (view.crash) return 'crashed'
  switch (rootRun(view)?.state) {
    case 'thinking':
    case 'tooling':
    case 'awaiting_children':
    case 'aborting':
      return 'running'
    case 'awaiting_approval':
      return 'waiting_approval'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'idle'
  }
}
