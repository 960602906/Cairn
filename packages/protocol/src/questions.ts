/**
 * 用户提问（`ask_user` 工具）。
 *
 * 模型需要用户在几个方案中做出选择，或补充无法从工作区得到的信息时，调用 `ask_user`；宿主经主进程
 * 把问题交给界面，用户回答后作为工具结果回给模型，**同一轮继续执行**，不需要结束这一轮再让用户重新输入。
 *
 * 一次调用可以带多个问题（最多 `ASK_USER_MAX_QUESTIONS` 个），界面用一个卡片一次收齐所有回答。
 * 每个问题提供 2～6 个选项，模型可以标出一个推荐选项；用户始终可以填写自定义回答。
 */
import { z } from 'zod'
import { Id } from './common.js'

/** 一次调用最多包含的问题数。 */
export const ASK_USER_MAX_QUESTIONS = 4
/** 一个问题最少 / 最多的选项数。 */
export const ASK_USER_MIN_OPTIONS = 2
export const ASK_USER_MAX_OPTIONS = 6
/** 问题正文、选项名称与说明、自定义回答的长度上限。 */
export const ASK_USER_QUESTION_MAX_CHARS = 1_000
export const ASK_USER_OPTION_LABEL_MAX = 80
export const ASK_USER_OPTION_DESCRIPTION_MAX = 200
export const ASK_USER_CUSTOM_MAX = 2_000

export const AskUserOption = z.object({
  label: z.string().trim().min(1).max(ASK_USER_OPTION_LABEL_MAX),
  description: z.string().trim().max(ASK_USER_OPTION_DESCRIPTION_MAX).optional(),
  /** 模型推荐的选项。每个问题最多一个；界面高亮显示，并作为默认选中项。 */
  recommended: z.boolean().optional(),
})
export type AskUserOption = z.infer<typeof AskUserOption>

export const AskUserQuestion = z.object({
  /** 工具调用内唯一，用于把回答对应回问题。 */
  id: Id,
  question: z.string().trim().min(1).max(ASK_USER_QUESTION_MAX_CHARS),
  options: z.array(AskUserOption).min(ASK_USER_MIN_OPTIONS).max(ASK_USER_MAX_OPTIONS),
  /** 允许多选；省略表示单选。 */
  multiple: z.boolean().optional(),
})
export type AskUserQuestion = z.infer<typeof AskUserQuestion>

export const AskUserQuestions = z.array(AskUserQuestion).min(1).max(ASK_USER_MAX_QUESTIONS)
export type AskUserQuestions = z.infer<typeof AskUserQuestions>

/** 宿主交给主进程、主进程交给界面的待回答问题。 */
export const AskUserRequest = z.object({
  questionId: Id,
  toolCallId: Id,
  questions: AskUserQuestions,
})
export type AskUserRequest = z.infer<typeof AskUserRequest>

/**
 * 用户对一个问题的回答：选中的选项（多选时可以有多个）与自定义回答。
 * 单选且填写了自定义回答时 `selected` 为空；多选时可以同时有选中项与自定义回答。
 */
export const AskUserAnswer = z.object({
  questionId: Id,
  selected: z.array(z.string().min(1).max(ASK_USER_OPTION_LABEL_MAX)).max(ASK_USER_MAX_OPTIONS),
  custom: z.string().trim().min(1).max(ASK_USER_CUSTOM_MAX).optional(),
})
export type AskUserAnswer = z.infer<typeof AskUserAnswer>

export const AskUserResponse = z.object({
  answers: z.array(AskUserAnswer).max(ASK_USER_MAX_QUESTIONS),
})
export type AskUserResponse = z.infer<typeof AskUserResponse>
