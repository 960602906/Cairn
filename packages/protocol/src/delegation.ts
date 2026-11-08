/**
 * 多 Agent 委派协议（M4-02，多 Agent 协作设计 §5、§6、§10；ADR-0020、ADR-0030）。
 *
 * 这里只定义数据形状与上限；校验与执行在 `@cairn/core` 的 `delegation`。
 */
import { z } from 'zod'
import { Id, RunLimits } from './common.js'

/** 全局委派深度硬上限（设计 §10.3）：任何策略都不能超过它。 */
export const DELEGATION_MAX_DEPTH = 3
/** 单轮子运行数量硬上限。 */
export const DELEGATION_MAX_CHILDREN_PER_TURN = 12
/** 并行子运行数量硬上限。 */
export const DELEGATION_MAX_PARALLEL = 8

/** 未配置时的默认值（设计 §10.1）。 */
export const DELEGATION_DEFAULT_MAX_DEPTH = 1
export const DELEGATION_DEFAULT_MAX_CHILDREN_PER_TURN = 6
export const DELEGATION_DEFAULT_MAX_PARALLEL = 3
export const DELEGATION_DEFAULT_CHILD_BUDGET_SHARE = 0.5

/** 任务书各字段的长度上限，避免把父运行上下文挤进子运行。 */
export const DELEGATE_TASK_MAX_CHARS = 1_000
export const TASK_BRIEF_GOAL_MAX_CHARS = 4_000
export const TASK_BRIEF_DELIVERABLE_MAX_CHARS = 4_000
export const TASK_BRIEF_CONTEXT_MAX_CHARS = 8_000
export const TASK_BRIEF_FILES_MAX = 50
export const TASK_BRIEF_FILE_PATH_MAX_CHARS = 500
export const TASK_BRIEF_CONSTRAINTS_MAX = 20
export const TASK_BRIEF_CONSTRAINT_MAX_CHARS = 1_000
/** 返回给父运行的结果字段上限。 */
export const DELEGATE_SUMMARY_MAX_CHARS = 4_000
export const DELEGATE_QUESTION_MAX_CHARS = 2_000

/** 工作区方式（设计 §7.1）。`auto` 由目标 Agent 的权限决定。 */
export const DelegationWorkspace = z.enum(['auto', 'shared', 'isolated'])
export type DelegationWorkspace = z.infer<typeof DelegationWorkspace>

/** 合并审阅方式（设计 §7.3）。 */
export const DelegationMergeReview = z.enum(['user', 'parent-then-user'])
export type DelegationMergeReview = z.infer<typeof DelegationMergeReview>

/**
 * Agent 的委派策略（设计 §10.1）。省略时视为未启用；数值在运行时由
 * `resolveDelegationPolicy` 钳到全局硬上限。
 */
export const DelegationPolicy = z
  .object({
    enabled: z.boolean(),
    /** 可以委派的 Agent 定义 id。 */
    allowedAgents: z.array(Id).max(50),
    maxDepth: z.number().int().min(0).max(DELEGATION_MAX_DEPTH),
    maxChildrenPerTurn: z.number().int().min(1).max(DELEGATION_MAX_CHILDREN_PER_TURN),
    maxParallel: z.number().int().min(1).max(DELEGATION_MAX_PARALLEL),
    childBudgetShare: z.number().min(0).max(1),
    defaultWorkspace: DelegationWorkspace,
    mergeReview: DelegationMergeReview,
  })
  .strict()
export type DelegationPolicy = z.infer<typeof DelegationPolicy>

/** 任务书（设计 §6.1）：父运行交给子运行的全部上下文。 */
export const TaskBrief = z
  .object({
    goal: z.string().min(1).max(TASK_BRIEF_GOAL_MAX_CHARS),
    context: z.string().max(TASK_BRIEF_CONTEXT_MAX_CHARS).optional(),
    files: z
      .array(z.string().min(1).max(TASK_BRIEF_FILE_PATH_MAX_CHARS))
      .max(TASK_BRIEF_FILES_MAX)
      .optional(),
    constraints: z
      .array(z.string().min(1).max(TASK_BRIEF_CONSTRAINT_MAX_CHARS))
      .max(TASK_BRIEF_CONSTRAINTS_MAX)
      .optional(),
    deliverable: z.string().min(1).max(TASK_BRIEF_DELIVERABLE_MAX_CHARS),
    /** 目标 Agent 定义了 `outputSchema` 时由调用方自动带入。 */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    /** 父运行希望的预算；不能超过可分配额度，运行时取最小值。 */
    budget: RunLimits.partial().optional(),
  })
  .strict()
export type TaskBrief = z.infer<typeof TaskBrief>

/** `delegate` 工具的参数（设计 §5）。 */
export const DelegateInput = z
  .object({
    /** 目标 Agent 定义 id，必须在父 Agent 的 `allowedAgents` 中。 */
    agent: Id,
    /** 一句话目标，便于界面与事件摘要。 */
    task: z.string().min(1).max(DELEGATE_TASK_MAX_CHARS),
    brief: TaskBrief,
    /** 工作区方式；省略时用目标 Agent 的默认值。 */
    workspace: z.enum(['shared', 'isolated']).optional(),
  })
  .strict()
export type DelegateInput = z.infer<typeof DelegateInput>

/** 子运行的结果状态（设计 §6.2）。 */
export const DelegateStatus = z.enum([
  'completed',
  'failed',
  'aborted',
  'needs_input',
  'limit_reached',
])
export type DelegateStatus = z.infer<typeof DelegateStatus>

export const DelegateChangeFile = z
  .object({
    path: z.string().min(1),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  })
  .strict()
export type DelegateChangeFile = z.infer<typeof DelegateChangeFile>

export const DelegateChanges = z
  .object({
    changeSetId: Id,
    files: z.array(DelegateChangeFile),
    merge: z.enum(['pending_review', 'merged', 'rejected', 'conflict']),
  })
  .strict()
export type DelegateChanges = z.infer<typeof DelegateChanges>

/** 子运行的用量：父运行把它计入本轮消耗（ADR-0030）。 */
export const DelegateUsage = z
  .object({
    tokens: z.number().int().nonnegative(),
    /** 模型有单价时才有；界面不显示金额（视觉规范 §10）。 */
    cost: z.number().nonnegative().optional(),
    durationMs: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
  })
  .strict()
export type DelegateUsage = z.infer<typeof DelegateUsage>

/** `delegate` 工具的返回值（设计 §6.2）：结构化结果，不含子运行历史。 */
export const DelegateResult = z
  .object({
    status: DelegateStatus,
    summary: z.string().max(DELEGATE_SUMMARY_MAX_CHARS),
    output: z.unknown().optional(),
    changes: DelegateChanges.optional(),
    /** `status` 为 `needs_input` 时的问题。 */
    question: z.string().max(DELEGATE_QUESTION_MAX_CHARS).optional(),
    usage: DelegateUsage,
    /** 供界面跳转查看完整过程。 */
    childRunId: Id,
  })
  .strict()
export type DelegateResult = z.infer<typeof DelegateResult>

/** 一条委派校验问题；`code` 由界面 / 模型翻译。 */
export const DelegationIssue = z
  .object({
    code: z.string().min(1),
    /** `warning` 只提醒父 Agent，仍然放行。 */
    severity: z.enum(['error', 'warning']).default('error'),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict()
export type DelegationIssue = z.infer<typeof DelegationIssue>

/** 委派校验结果（设计 §5、§10.3）。 */
export const DelegationValidation = z
  .object({
    ok: z.boolean(),
    issues: z.array(DelegationIssue),
  })
  .strict()
export type DelegationValidation = z.infer<typeof DelegationValidation>
