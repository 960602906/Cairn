/**
 * 计划模式（M3-05，Runtime §25.1，ADR-0028）。
 *
 * - 计划这一轮的有效权限收紧为只读：写、执行、网络一律拒绝，规则里的 allow 也不能放开；
 * - 这一轮多一个 `propose_plan`，调用成功后结束本轮；
 * - 批准之后的正常轮次多一个 `update_plan_step`，用步骤 id 更新进度，说明写在事件的 `note` 上；
 * - 执行期间用户改任务时，模型用 `revise_plan_steps` 提交完整的新步骤列表，界面实时刷新。
 */
import { z } from 'zod'
import type { ActivePlan, PlanDocument, PlanStepUpdateStatus } from '@cairn/protocol'
import {
  PLAN_STEP_MAX,
  PlanDocument as PlanDocumentSchema,
  PlanStep as PlanStepSchema,
} from '@cairn/protocol'
import type { PermissionGuard } from './permissions.js'
import { ToolError, ToolErrorCode, type ToolDefinition, type ToolRegistry } from './tools.js'
import type { RuntimeToolEffect } from './runtime.js'

export const PROPOSE_PLAN_TOOL = 'propose_plan'
export const UPDATE_PLAN_STEP_TOOL = 'update_plan_step'
export const REVISE_PLAN_STEPS_TOOL = 'revise_plan_steps'

export const PlanErrorCode = {
  NotPending: 'plan.not_pending',
  UnknownStep: 'plan.unknown_step',
  NoActivePlan: 'plan.no_active_plan',
} as const

export const PlanModeReasonCode = 'permission.plan_mode'

export const PLAN_MODE_DENY_REASON =
  'Plan mode is read-only. You can read the project, but writing files, running commands, and using the network are not allowed until the user approves a plan.'

const CHANGING = new Set(['write', 'execute', 'network'])

/** 计划模式这一轮的强制拦截。`active` 为 false 时不拦截。 */
export function planModeGuard(active: () => boolean): PermissionGuard {
  return (request) => {
    if (!active() || !CHANGING.has(request.definition.category)) return undefined
    return {
      effect: 'deny',
      reasonCode: PlanModeReasonCode,
      reason: PLAN_MODE_DENY_REASON,
    }
  }
}

/** 这一步工具要不要交给模型。其他工具始终可见。 */
export function planToolVisible(
  name: string,
  mode: 'normal' | 'plan',
  hasActivePlan: boolean,
): boolean {
  if (name === PROPOSE_PLAN_TOOL) return mode === 'plan'
  if (name === UPDATE_PLAN_STEP_TOOL || name === REVISE_PLAN_STEPS_TOOL)
    return mode === 'normal' && hasActivePlan
  return true
}

export const PLAN_MODE_INSTRUCTIONS = `# Plan mode
This turn is plan mode. It is read-only: do not edit files, run commands, or use the network. Read the project, then call propose_plan exactly once.

propose_plan arguments:
- goal: what the user wants done
- files: project paths you expect to read or change
- steps: ordered steps, each with an id (letters, digits, "_" or "-", starting with a letter) and a short title
- risks: what could go wrong, or an empty string
- verification: how to check the result
- markdown: the same plan as Markdown, in the user's language, for them to read

After propose_plan returns, stop. Do not continue working in this turn.`

/** 批准之后追加的说明：按步骤做，并用工具报进度。 */
export function executionPlanInstructions(plan: {
  readonly goal: string
  readonly steps: readonly { readonly id: string; readonly title: string }[]
}): string {
  const steps = plan.steps
    .map((step, index) => `${index + 1}. ${step.id}: ${step.title}`)
    .join('\n')
  return `# Approved plan
The user approved this plan. Carry it out now — do not stop after presenting or acknowledging it. Use your available tools to execute the steps. Start by marking the first step in_progress with update_plan_step, then work through them. As you start, finish, or skip a step, call update_plan_step with that step's id. If the user changes the task while you work, call revise_plan_steps with the complete new step list before continuing; keep ids for retained steps so their progress survives, omit removed steps, and give added steps new ids. If you must deviate, keep going and pass a short note explaining why. A note does not block the work.

Goal: ${plan.goal}
Steps:
${steps}`
}

/** 用结构化字段拼一份给模型和界面看的正文。 */
export function renderPlan(content: PlanDocument): string {
  const files =
    content.files.length > 0 ? content.files.map((file) => `- ${file}`).join('\n') : '- (none)'
  const steps = content.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')
  return [
    content.goal,
    '',
    'Files:',
    files,
    '',
    'Steps:',
    steps,
    '',
    'Risks:',
    content.risks.trim() || '(none)',
    '',
    'Verification:',
    content.verification.trim() || '(none)',
  ].join('\n')
}

/** 用户改过的步骤标题。未知 id 原样留下，由调用方决定是否拒绝。 */
export function applyStepTitles(
  content: PlanDocument,
  edits: readonly { readonly id: string; readonly title: string }[] | undefined,
): PlanDocument {
  if (!edits || edits.length === 0) return content
  const titles = new Map(edits.map((edit) => [edit.id, edit.title]))
  return {
    ...content,
    steps: content.steps.map((step) => {
      const title = titles.get(step.id)
      return title === undefined ? step : { ...step, title }
    }),
  }
}

/** 批准后发给模型的用户消息。改过步骤就按结构化字段重写，否则用 Markdown 原文。 */
export function approvedPlanMessage(original: PlanDocument, approved: PlanDocument): string {
  const edited = original.steps.some((step, index) => step.title !== approved.steps[index]?.title)
  const markdown = approved.markdown.trim()
  const body = !edited && markdown !== '' ? markdown : renderPlan(approved)
  const firstStepId = approved.steps[0]?.id
  const directive = firstStepId
    ? `已批准此计划，请立即开始执行。先调用 update_plan_step 把第一步（${firstStepId}）标记为 in_progress，然后按步骤推进，不要停下来等确认。`
    : '已批准此计划，请立即开始执行，按步骤推进。'
  return `${directive}\n\n${body}`
}

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', minLength: 1, description: 'What the user wants done.' },
    files: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Project paths this plan expects to read or change.',
    },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: 'Stable id, starting with a letter.' },
          title: { type: 'string', minLength: 1, description: 'What this step does.' },
        },
        required: ['id', 'title'],
        additionalProperties: false,
      },
    },
    risks: { type: 'string', description: 'What could go wrong. Empty string if none.' },
    verification: { type: 'string', description: 'How to check the result.' },
    markdown: {
      type: 'string',
      description: "The same plan as Markdown in the user's language.",
    },
  },
  required: ['goal', 'files', 'steps', 'risks', 'verification', 'markdown'],
  additionalProperties: false,
} as const

const RevisedStepsSchema = z.object({
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .max(PLAN_STEP_MAX)
    .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
      message: 'duplicate step id',
    }),
})

const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description:
        'The complete ordered step list after this revision. Retain ids for existing steps, omit deleted steps, and assign new ids to added steps.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
        },
        required: ['id', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['steps'],
  additionalProperties: false,
} as const

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string', minLength: 1, description: 'Id of the step in the approved plan.' },
    status: {
      type: 'string',
      enum: ['in_progress', 'done', 'skipped'],
      description: 'The step is starting, finished, or skipped.',
    },
    note: {
      type: 'string',
      description: 'Optional note. Use it when this step deviates from the plan.',
    },
  },
  required: ['stepId', 'status'],
  additionalProperties: false,
} as const

export interface PlanToolDeps {
  readonly createId: () => string
  /** 正在执行的已批准计划；没有时 `update_plan_step` 失败。 */
  readonly activePlan: () => ActivePlan | undefined
  /**
   * 修订后同步宿主内存里的活动计划，使同一轮里的后续 `update_plan_step` 按新步骤校验。
   * 不传时只发事件，宿主会以旧步骤校验到下一次 `host.prompt` 为止。
   */
  readonly revisePlan?: ((steps: readonly { readonly id: string; readonly title: string }[]) => void) | undefined
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('\n')
}

function proposePlanTool(deps: PlanToolDeps): ToolDefinition {
  return {
    name: PROPOSE_PLAN_TOOL,
    description:
      'Record a structured plan for the user to approve. Call this once in plan mode, then stop. Available only in plan mode.',
    inputSchema: PROPOSE_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = PlanDocumentSchema.safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid plan:\n${issuesOf(parsed.error)}`,
          { name: PROPOSE_PLAN_TOOL },
        )
      }
      const markdown = parsed.data.markdown.trim()
      const content: PlanDocument = markdown
        ? parsed.data
        : { ...parsed.data, markdown: renderPlan(parsed.data) }
      const effect: RuntimeToolEffect = {
        type: 'plan.proposed',
        payload: { planId: deps.createId(), content },
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Plan recorded. This turn ends so the user can review it. Wait for the user to approve before executing.',
          },
        ],
        stopLoop: true,
        effects: [effect],
      }
    },
  }
}

function revisePlanStepsTool(deps: PlanToolDeps): ToolDefinition {
  return {
    name: REVISE_PLAN_STEPS_TOOL,
    description:
      'Replace the ordered steps of the approved plan when the user changes the task. Send the complete list; keep existing ids for retained steps to preserve progress, omit removed steps, and use new ids for added steps.',
    inputSchema: REVISE_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const parsed = RevisedStepsSchema.safeParse(input)
      if (!parsed.success) {
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid steps:\n${issuesOf(parsed.error)}`,
          { name: REVISE_PLAN_STEPS_TOOL },
        )
      }
      const plan = deps.activePlan()
      if (!plan) {
        throw new ToolError(
          PlanErrorCode.NoActivePlan,
          'No approved plan is being executed, so revise_plan_steps is not available.',
        )
      }
      const effect: RuntimeToolEffect = {
        type: 'plan.steps.revised',
        payload: { planId: plan.planId, steps: parsed.data.steps },
      }
      deps.revisePlan?.(parsed.data.steps)
      return {
        content: [{ type: 'text', text: 'Plan steps revised. Continue working on the updated list.' }],
        effects: [effect],
      }
    },
  }
}

function updatePlanStepTool(deps: PlanToolDeps): ToolDefinition {
  return {
    name: UPDATE_PLAN_STEP_TOOL,
    description:
      'Update one step of the approved plan. Use the step id. A note explains a deviation and does not block the work.',
    inputSchema: UPDATE_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    async execute(input) {
      const { stepId, status, note } = input as {
        stepId: string
        status: PlanStepUpdateStatus
        note?: string
      }
      const plan = deps.activePlan()
      if (!plan) {
        throw new ToolError(
          PlanErrorCode.NoActivePlan,
          'No approved plan is being executed, so update_plan_step is not available.',
        )
      }
      const stepIndex = plan.steps.findIndex((step) => step.id === stepId)
      if (stepIndex < 0) {
        const ids = plan.steps.map((step) => step.id).join(', ')
        throw new ToolError(
          PlanErrorCode.UnknownStep,
          `Unknown step id "${stepId}". Use one of: ${ids}.`,
          { stepId },
        )
      }
      const trimmed = note?.trim()
      const effect: RuntimeToolEffect = {
        type: 'plan.step.updated',
        payload: {
          planId: plan.planId,
          stepId,
          stepIndex,
          status,
          ...(trimmed ? { note: trimmed } : {}),
        },
      }
      return {
        content: [{ type: 'text', text: `Step ${stepId} is now ${status}.` }],
        effects: [effect],
      }
    },
  }
}

/** 注册计划工具。是否交给模型由 `planToolVisible` 决定，不在这里过滤。 */
export function registerPlanTools(registry: ToolRegistry, deps: PlanToolDeps): void {
  registry.register(proposePlanTool(deps))
  registry.register(updatePlanStepTool(deps))
  registry.register(revisePlanStepsTool(deps))
}
