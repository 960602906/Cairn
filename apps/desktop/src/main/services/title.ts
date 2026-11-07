/**
 * 自动标题的纯逻辑（M3-01）：什么时候生成、标题怎么整理。
 * 真正的模型调用在 `title-service.ts`。
 */
import type { ContentPart, ModelRef, PersistedEvent } from '@cairn/protocol'

/** 自动标题的长度上限（码位）。用户手动标题仍是 200。 */
export const AUTO_TITLE_MAX_LENGTH = 30

/** 送给模型的用户消息与回复各自的上限，避免一次补全带上整段长文。 */
export const AUTO_TITLE_SOURCE_MAX_LENGTH = 4_000

/**
 * 告诉模型：用用户的语言，只回标题。标记语 "You name a conversation." 也被端到端测试的
 * mock 用来识别这次请求。
 */
export const TITLE_SYSTEM_PROMPT = [
  'You name a conversation.',
  'Read the first user message and the assistant reply, then reply with a title only.',
  'Use the same language as the user.',
  'At most 30 characters.',
  'No quotes and no explanation.',
].join('\n')

export interface AutoTitleInput {
  readonly userText: string
  readonly assistantText: string
  /** 会话当前的主模型；没有记录时为 undefined。 */
  readonly model: ModelRef | undefined
  readonly runId: string
  readonly turnId: string
}

const QUOTES: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['「', '」'],
  ['“', '”'],
  ['‘', '’'],
  ['《', '》'],
]

/** 取第一行、去掉一层包裹的引号、压成一行，并截到 30 个码位。空结果表示不要采用。 */
export function normalizeTitle(raw: string, max = AUTO_TITLE_MAX_LENGTH): string {
  let text = (raw.split(/\r?\n/, 1)[0] ?? '').trim()
  for (const [open, close] of QUOTES) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      text = text.slice(open.length, -close.length).trim()
      break
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  const chars = [...text]
  if (chars.length > max) text = chars.slice(0, max).join('').trim()
  return text
}

/** 截到 `max` 个码位（送给模型之前）。 */
export function clipText(text: string, max = AUTO_TITLE_SOURCE_MAX_LENGTH): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

function textOf(content: readonly ContentPart[]): string {
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/**
 * 是否该为这个会话生成标题。
 *
 * 只在第一轮成功结束时：这一轮是会话的第一个 turn，且到目前为止只有这一次 `turn.completed`。
 * 第一轮失败或被中止之后的轮次不再补标题。标题已有内容，或出现过非 `auto` 的 `session.renamed`
 * （用户改过，含改成空标题），也不生成。
 */
export function autoTitleInput(events: readonly PersistedEvent[]): AutoTitleInput | undefined {
  let title = ''
  let manual = false
  let model: ModelRef | undefined
  let firstTurnId: string | undefined
  const completed: { turnId: string; runId: string }[] = []
  const users: string[] = []
  const assistants = new Map<string, string[]>()

  for (const event of events) {
    switch (event.type) {
      case 'session.created':
        title = event.payload.title
        model = event.payload.model
        break
      case 'session.renamed':
        title = event.payload.title
        if (event.payload.source !== 'auto') manual = true
        break
      case 'session.model.changed':
        model = event.payload.model
        break
      case 'turn.started':
        if (firstTurnId === undefined && event.turnId) firstTurnId = event.turnId
        break
      case 'turn.completed':
        if (event.turnId) completed.push({ turnId: event.turnId, runId: event.runId })
        break
      case 'message.user':
        users.push(textOf(event.payload.content))
        break
      case 'message.assistant.completed':
        if (event.turnId) {
          const list = assistants.get(event.turnId) ?? []
          list.push(textOf(event.payload.content))
          assistants.set(event.turnId, list)
        }
        break
      default:
        break
    }
  }

  const done = completed[0]
  if (!done || completed.length !== 1 || done.turnId !== firstTurnId) return undefined
  if (manual || title.trim() !== '') return undefined
  const userText = users.find((text) => text.trim() !== '')
  const assistantText = (assistants.get(done.turnId) ?? [])
    .filter((text) => text.trim() !== '')
    .join('\n')
  if (!userText || assistantText.trim() === '') return undefined
  return { userText, assistantText, model, runId: done.runId, turnId: done.turnId }
}

/** 生成过程中用户改了标题（或标题已经不是空的）时，不再写入自动标题。 */
export function autoTitleBlocked(events: readonly PersistedEvent[]): boolean {
  let title = ''
  for (const event of events) {
    if (event.type === 'session.created') title = event.payload.title
    if (event.type === 'session.renamed') {
      title = event.payload.title
      if (event.payload.source !== 'auto') return true
    }
  }
  return title.trim() !== ''
}
