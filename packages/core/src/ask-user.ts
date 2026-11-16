/**
 * 用户提问工具（`ask_user`）。
 *
 * 模型需要用户在几个方案中选择，或补充无法从工作区得到的信息时调用；宿主把问题交给界面，用户回答后
 * 作为工具结果回给模型，**同一轮继续执行**。一次可以问 1～4 个问题，每个问题 2～6 个选项，并可标出
 * 一个推荐选项；用户始终可以填写自定义回答。
 *
 * 委派子运行不直接向用户提问（设计文档「子 → 用户」）：子运行的工具流水线不提供 `askUser`，
 * 这个工具在那里报不可用，需要澄清时以 `needs_input` 返回父运行。
 */
import {
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_OPTION_DESCRIPTION_MAX,
  ASK_USER_OPTION_LABEL_MAX,
  ASK_USER_QUESTION_MAX_CHARS,
  AskUserOption,
  type AskUserResponse,
} from '@cairn/protocol'
import { z } from 'zod'
import { ToolError, ToolErrorCode, type ToolDefinition, type ToolRegistry } from './tools.js'

export const ASK_USER_TOOL = 'ask_user'

const QuestionInput = z.object({
  question: z.string().trim().min(1).max(ASK_USER_QUESTION_MAX_CHARS),
  options: z.array(AskUserOption).min(ASK_USER_MIN_OPTIONS).max(ASK_USER_MAX_OPTIONS),
  /** 允许多选；省略表示单选。 */
  multiple: z.boolean().optional(),
})

const InputSchema = z.object({
  questions: z.array(QuestionInput).min(1).max(ASK_USER_MAX_QUESTIONS),
})

const QUESTIONS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: ASK_USER_MAX_QUESTIONS,
      description: 'One to four questions to ask the user together.',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            minLength: 1,
            maxLength: ASK_USER_QUESTION_MAX_CHARS,
            description: 'The question, in the language the user writes in.',
          },
          options: {
            type: 'array',
            minItems: ASK_USER_MIN_OPTIONS,
            maxItems: ASK_USER_MAX_OPTIONS,
            description:
              'Concrete choices. The user can always give a custom answer instead or in addition.',
            items: {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  minLength: 1,
                  maxLength: ASK_USER_OPTION_LABEL_MAX,
                  description: 'Short label shown on the button.',
                },
                description: {
                  type: 'string',
                  maxLength: ASK_USER_OPTION_DESCRIPTION_MAX,
                  description: 'Optional one-line explanation of what this choice means.',
                },
                recommended: {
                  type: 'boolean',
                  description:
                    'Set true on the single option you recommend. The UI highlights it and makes it the default choice.',
                },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          multiple: {
            type: 'boolean',
            description: 'Allow selecting more than one option. Defaults to false.',
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('\n')
}

/** 标题不能重复，推荐项每个问题最多一个；否则界面无法把回答对应回问题/选项。 */
function checkQuestions(questions: z.infer<typeof InputSchema>['questions']): string | undefined {
  for (const [index, question] of questions.entries()) {
    const prefix = `questions.${index}`
    const labels = question.options.map((option) => option.label)
    if (new Set(labels).size !== labels.length) return `${prefix}.options: labels must be unique`
    if (question.options.filter((option) => option.recommended === true).length > 1)
      return `${prefix}.options: mark at most one option as recommended`
  }
  return undefined
}

/** 把回答按问题顺序整理成给模型看的 JSON 文本。 */
export function renderAnswers(
  questions: readonly { readonly id: string; readonly question: string }[],
  response: AskUserResponse,
): string {
  const byId = new Map(response.answers.map((answer) => [answer.questionId, answer]))
  const answers = questions.map((question) => {
    const answer = byId.get(question.id)
    return {
      question: question.question,
      selected: answer?.selected ?? [],
      ...(answer?.custom ? { custom: answer.custom } : {}),
    }
  })
  return JSON.stringify({ answers }, null, 2)
}

function askUserTool(): ToolDefinition {
  return {
    name: ASK_USER_TOOL,
    description:
      'Ask the user a question and wait for their answer. Use it when you genuinely need a decision between concrete approaches, or information you cannot find in the workspace; do not use it for things you can decide yourself. Provide 1-4 questions, each with 2-6 concrete options and at most one marked recommended. The user can also type a custom answer. The answer comes back as the tool result and your turn continues, so never end your turn with a question in plain text.',
    inputSchema: QUESTIONS_JSON_SCHEMA,
    category: 'read',
    source: { kind: 'builtin' },
    trust: 'builtin',
    // 必须串行：等问题回答期间不能同时执行其它工具，问题也按模型给出的顺序出现。
    parallel: false,
    async execute(input, ctx) {
      if (!ctx.askUser)
        throw new ToolError(
          ToolErrorCode.ExecutionFailed,
          'Asking the user is not available in this run.',
        )
      const parsed = InputSchema.safeParse(input)
      if (!parsed.success)
        throw new ToolError(
          ToolErrorCode.InvalidInput,
          `Invalid questions:\n${issuesOf(parsed.error)}`,
          { name: ASK_USER_TOOL },
        )
      const problem = checkQuestions(parsed.data.questions)
      if (problem)
        throw new ToolError(ToolErrorCode.InvalidInput, `Invalid questions:\n${problem}`, {
          name: ASK_USER_TOOL,
        })
      const questions = parsed.data.questions.map((question, index) => ({
        id: `q${index + 1}`,
        question: question.question,
        options: question.options,
        ...(question.multiple ? { multiple: true } : {}),
      }))
      const response = await ctx.askUser({ questionId: ctx.toolCallId, questions })
      return {
        content: [{ type: 'text', text: renderAnswers(questions, response) }],
      }
    },
  }
}

/** 注册 `ask_user`。是否交给模型由 Agent 的工具选择决定。 */
export function registerAskUserTool(registry: ToolRegistry): void {
  registry.register(askUserTool())
}
