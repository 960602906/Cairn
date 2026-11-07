/**
 * 计划模式（M3-05，Runtime §25.1，ADR-0028）。
 *
 * 计划是结构化的：目标、文件、步骤、风险、验证方式，另留一份 Markdown 原文给界面显示。
 * `plan.proposed` 在此之前只有一个字符串，但从未写入过事件日志，所以直接换成这个结构，不升事件版本。
 */
import { z } from 'zod'
import { Id } from './common.js'

/** 这一轮怎么工作：正常执行，或只读地提出计划。 */
export const PromptMode = z.enum(['normal', 'plan'])
export type PromptMode = z.infer<typeof PromptMode>

/** 步骤 id：给 `update_plan_step` 用，不跟显示顺序绑死。 */
export const PLAN_STEP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

export const PLAN_GOAL_MAX = 2_000
export const PLAN_TEXT_MAX = 4_000
export const PLAN_MARKDOWN_MAX = 20_000
export const PLAN_PATH_MAX = 500
export const PLAN_FILE_MAX = 50
export const PLAN_STEP_MAX = 20
export const PLAN_TITLE_MAX = 200
export const PLAN_NOTE_MAX = 2_000
export const PLAN_FEEDBACK_MAX = 4_000

export const PlanStep = z.object({
  id: z.string().regex(PLAN_STEP_ID_PATTERN),
  title: z.string().trim().min(1).max(PLAN_TITLE_MAX),
})
export type PlanStep = z.infer<typeof PlanStep>

export const PlanDocument = z
  .object({
    goal: z.string().trim().min(1).max(PLAN_GOAL_MAX),
    files: z.array(z.string().trim().min(1).max(PLAN_PATH_MAX)).max(PLAN_FILE_MAX),
    steps: z.array(PlanStep).min(1).max(PLAN_STEP_MAX),
    risks: z.string().max(PLAN_TEXT_MAX),
    verification: z.string().max(PLAN_TEXT_MAX),
    /** 模型写给用户看的 Markdown。空字符串时由工具用结构化字段补一份。 */
    markdown: z.string().max(PLAN_MARKDOWN_MAX),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>()
    doc.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate step id ${step.id}`,
          path: ['steps', index, 'id'],
        })
      }
      seen.add(step.id)
    })
  })
export type PlanDocument = z.infer<typeof PlanDocument>

/** 步骤在卡片上的状态。工具只能报后三种；`pending` 是还没开始。 */
export const PlanStepStatus = z.enum(['pending', 'in_progress', 'done', 'skipped'])
export type PlanStepStatus = z.infer<typeof PlanStepStatus>

export const PlanStepUpdateStatus = z.enum(['in_progress', 'done', 'skipped'])
export type PlanStepUpdateStatus = z.infer<typeof PlanStepUpdateStatus>

/** 批准之后、执行期间交给宿主的计划摘要（步骤标题可能已被用户改过）。 */
export const ActivePlan = z.object({
  planId: Id,
  goal: z.string().min(1).max(PLAN_GOAL_MAX),
  steps: z.array(PlanStep).min(1).max(PLAN_STEP_MAX),
})
export type ActivePlan = z.infer<typeof ActivePlan>
