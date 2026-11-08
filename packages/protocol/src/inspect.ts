/**
 * 运行检查器（M4-04，管理界面 §8.2，ADR-0033）。
 *
 * 运行树由事件日志投影得到；上下文快照在每次模型调用前由宿主采集，主进程脱敏后写入
 * `run_snapshots` 表。检查器只读，不修改运行。
 */
import { z } from 'zod'
import {
  ErrorInfo,
  Id,
  ModelRef,
  RunAgentRef,
  RunLimits,
  RunMode,
  RunState,
  Timestamp,
} from './common.js'
import { PermissionRule } from './permissions.js'

/** 运行、轮次、步骤与工具调用的用量；不包含金额（ADR-0024）。 */
export const RunUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /** 模型调用次数（`step.started`）。 */
  modelCalls: z.number().int().nonnegative(),
  /** 工具调用次数（`tool.requested`）。 */
  toolCalls: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
})
export type RunUsage = z.infer<typeof RunUsage>

export const RunTreeApproval = z.object({
  approvalId: Id,
  reasonCode: z.string().min(1),
  matchedRuleIds: z.array(Id),
  decision: z
    .enum(['allow_once', 'allow_session', 'allow_project', 'deny', 'cancelled'])
    .optional(),
  decidedBy: z.enum(['user', 'rule', 'system']).optional(),
})
export type RunTreeApproval = z.infer<typeof RunTreeApproval>

export const RunTreeToolCall = z.object({
  toolCallId: Id,
  name: Id,
  status: z.enum(['requested', 'running', 'completed', 'failed', 'cancelled']),
  requestedAt: Timestamp,
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
  durationMs: z.number().nonnegative().optional(),
  error: ErrorInfo.optional(),
  approval: RunTreeApproval.optional(),
})
export type RunTreeToolCall = z.infer<typeof RunTreeToolCall>

export const RunTreeStep = z.object({
  stepId: Id,
  model: ModelRef,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'aborted', 'error']).optional(),
  usage: RunUsage,
  toolCalls: z.array(RunTreeToolCall),
})
export type RunTreeStep = z.infer<typeof RunTreeStep>

export const RunTreeTurn = z.object({
  turnId: Id,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  status: z.enum(['running', 'completed', 'aborted', 'failed', 'limit_reached']),
  usage: RunUsage,
  steps: z.array(RunTreeStep),
})
export type RunTreeTurn = z.infer<typeof RunTreeTurn>

export const RunTreeNode = z.object({
  runId: Id,
  parentRunId: Id.optional(),
  agent: RunAgentRef,
  model: ModelRef,
  mode: RunMode,
  state: RunState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  durationMs: z.number().nonnegative(),
  limits: RunLimits,
  /** 含全部子运行的汇总用量。 */
  usage: RunUsage,
  turns: z.array(RunTreeTurn),
})
export type RunTreeNode = z.infer<typeof RunTreeNode>

export const RunTree = z.object({
  sessionId: Id,
  rootRunId: Id,
  generatedAt: Timestamp,
  runs: z.array(RunTreeNode),
})
export type RunTree = z.infer<typeof RunTree>

/** 系统提示词的一部分；`text` 已按快照大小上限截断。 */
export const RunSnapshotSection = z.object({
  title: z.string(),
  text: z.string(),
  tokens: z.number().int().nonnegative(),
})
export type RunSnapshotSection = z.infer<typeof RunSnapshotSection>

export const RunSnapshotTool = z.object({
  name: Id,
  description: z.string(),
  tokens: z.number().int().nonnegative(),
})
export type RunSnapshotTool = z.infer<typeof RunSnapshotTool>

export const RunSnapshotSkill = z.object({
  name: Id,
  description: z.string(),
  pinned: z.boolean(),
  tokens: z.number().int().nonnegative(),
})
export type RunSnapshotSkill = z.infer<typeof RunSnapshotSkill>

export const RunSnapshotMessage = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'summary']),
  text: z.string(),
  tokens: z.number().int().nonnegative(),
  ts: Timestamp,
})
export type RunSnapshotMessage = z.infer<typeof RunSnapshotMessage>

export const RunSnapshotCompaction = z.object({
  summary: z.string(),
  coversTurns: z.tuple([Id, Id]),
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
})
export type RunSnapshotCompaction = z.infer<typeof RunSnapshotCompaction>

export const RunSnapshot = z.object({
  snapshotId: Id,
  sessionId: Id,
  runId: Id,
  parentRunId: Id.optional(),
  agent: RunAgentRef,
  model: ModelRef,
  turnId: Id.optional(),
  stepId: Id.optional(),
  createdAt: Timestamp,
  /** 整份快照的估算 token。 */
  tokens: z.number().int().nonnegative(),
  systemPrompt: z.array(RunSnapshotSection),
  skills: z.array(RunSnapshotSkill),
  tools: z.array(RunSnapshotTool),
  history: z.object({
    messages: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    preview: z.array(RunSnapshotMessage),
  }),
  compaction: RunSnapshotCompaction.optional(),
})
export type RunSnapshot = z.infer<typeof RunSnapshot>

/** 宿主上报的快照；id、会话与时间由主进程填写。 */
export const RunSnapshotInput = RunSnapshot.omit({
  snapshotId: true,
  sessionId: true,
  createdAt: true,
})
export type RunSnapshotInput = z.infer<typeof RunSnapshotInput>

export const RunInspectSettings = z.object({
  /** 已脱敏：项目内相对路径或 `~`。 */
  projectPath: z.string(),
  workspacePath: z.string(),
  permissionRules: z.array(PermissionRule),
})
export type RunInspectSettings = z.infer<typeof RunInspectSettings>

export const RunInspectResult = z.object({
  tree: RunTree,
  snapshots: z.array(RunSnapshot),
  settings: RunInspectSettings,
})
export type RunInspectResult = z.infer<typeof RunInspectResult>

/** 空用量；投影与测试共用。 */
export function emptyRunUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 }
}
