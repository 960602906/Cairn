/**
 * 会话要点的纯逻辑（M3-04）：什么时候更新、用户改过的文字怎么保住。
 * 真正的模型调用在 `brief-service.ts`。
 */
import type { ContentPart, ModelRef, PersistedEvent } from '@cairn/protocol'
import { clipText } from './title.js'

/**
 * 告诉模型只记录用户明确说过的话。标记语 "You keep a session brief." 也被端到端测试的
 * mock 用来识别这次请求。
 */
export const BRIEF_SYSTEM_PROMPT = [
  'You keep a session brief.',
  'Update the brief using only goals, constraints, and preferences the user explicitly stated.',
  'Do not record the assistant inferences, plans, or guesses.',
  'Do not invent.',
  'If the user stated nothing new, return the current brief unchanged.',
  'Write in the user language.',
  'Output only the brief.',
].join('\n')

/** 用户改过要点时附加给模型的说明。真正保住原文的是 `mergeBrief`，不靠模型自觉。 */
export const BRIEF_USER_EDITED_NOTE =
  'The current brief was edited by the user. Keep that text verbatim and only append new items the user stated.'

export interface SessionBriefSnapshot {
  readonly content: string
  readonly editedBy: 'agent' | 'user'
}

export interface BriefUpdateInput {
  readonly userText: string
  readonly assistantText: string
  readonly model: ModelRef | undefined
  readonly runId: string
  readonly turnId: string
  readonly brief: SessionBriefSnapshot | undefined
}

/** 去掉首尾空白后是否同一段要点。相同就不发事件。 */
export function sameBrief(previous: string | undefined, next: string): boolean {
  return (previous ?? '').trim() === next.trim()
}

/**
 * 最新一条会话要点。空内容表示用户清空了，返回 undefined。
 */
export function latestBrief(events: readonly PersistedEvent[]): SessionBriefSnapshot | undefined {
  let found: SessionBriefSnapshot | undefined
  for (const event of events) {
    if (event.type !== 'session.brief.updated') continue
    const content = event.payload.content.trim()
    found = content ? { content, editedBy: event.payload.editedBy } : undefined
  }
  return found
}

/**
 * 合并模型给出的新要点。
 *
 * 用户编辑过的版本必须原样保留，模型只能在后面追加它还没写过的行。
 * 没有新内容时返回用户的原文（调用方不发事件）。
 * 没有用户编辑时采用模型的正文；模型没写东西则返回空字符串（调用方不因此清空已有要点）。
 */
export function mergeBrief(current: SessionBriefSnapshot | undefined, modelText: string): string {
  const next = modelText.trim()
  if (current?.editedBy !== 'user') return next
  const base = current.content.trim()
  if (!base) return next
  if (!next || next === base) return base
  if (next.startsWith(base)) return next
  const extras = next
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !base.includes(line))
  return extras.length > 0 ? `${base}\n${extras.join('\n')}` : base
}

function textOf(content: readonly ContentPart[]): string {
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/**
 * 最近一轮成功结束后用来更新要点的材料。没有完成的轮次，或这一轮没有用户文字时，不更新。
 */
export function briefUpdateInput(events: readonly PersistedEvent[]): BriefUpdateInput | undefined {
  let model: ModelRef | undefined
  let pendingUser = ''
  const assistants = new Map<string, string[]>()
  let last: BriefUpdateInput | undefined

  for (const event of events) {
    switch (event.type) {
      case 'session.created':
        model = event.payload.model
        break
      case 'session.model.changed':
        model = event.payload.model
        break
      case 'message.user':
        pendingUser = textOf(event.payload.content)
        break
      case 'message.assistant.completed':
        if (event.turnId && !event.payload.incomplete) {
          const list = assistants.get(event.turnId) ?? []
          list.push(textOf(event.payload.content))
          assistants.set(event.turnId, list)
        }
        break
      case 'turn.completed': {
        if (!event.turnId) break
        const userText = pendingUser.trim()
        if (!userText) break
        const assistantText = (assistants.get(event.turnId) ?? [])
          .filter((text) => text.trim() !== '')
          .join('\n')
        last = {
          userText,
          assistantText,
          model,
          runId: event.runId,
          turnId: event.turnId,
          brief: latestBrief(events),
        }
        break
      }
      default:
        break
    }
  }
  return last
}

/** 送给模型的这一轮材料。当前要点在前，方便它增量改。 */
export function briefRequest(input: BriefUpdateInput): string {
  const current = input.brief?.content.trim()
  return [
    current ? `Current brief:\n${clipText(current)}` : 'Current brief:\n(none)',
    ...(input.brief?.editedBy === 'user' ? [BRIEF_USER_EDITED_NOTE] : []),
    `User:\n${clipText(input.userText)}`,
    `Assistant:\n${clipText(input.assistantText)}`,
  ].join('\n\n')
}
