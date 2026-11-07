/**
 * 会话要点（M3-04，Runtime §25.2）。
 *
 * 要点是一条必须保留的摘要消息，放在模型历史的最前面。压缩时先把它拿开，避免被写进下一次摘要，
 * 压缩完再按最新文本放回去。用固定英文前缀识别，这样恢复和再压缩都认得出它。
 */
import type { CanonicalMessage } from '@cairn/protocol'

/** 发给模型的要点前缀。端到端测试也用这句话认出要点，不要改写。 */
export const SESSION_BRIEF_PREFIX =
  'Session brief (keep; the user stated these goals and constraints):\n\n'

export function isSessionBrief(message: CanonicalMessage): boolean {
  return message.role === 'summary' && message.content.startsWith(SESSION_BRIEF_PREFIX)
}

export function sessionBriefMessage(text: string, ts: number): CanonicalMessage {
  return {
    role: 'summary',
    content: SESSION_BRIEF_PREFIX + text.trim(),
    coversTurns: ['brief', 'brief'],
    ts,
  }
}

/** 历史里已有的要点正文；没有时为 undefined。 */
export function sessionBriefText(messages: readonly CanonicalMessage[]): string | undefined {
  const found = messages.find(isSessionBrief)
  if (!found || found.role !== 'summary') return undefined
  const text = found.content.slice(SESSION_BRIEF_PREFIX.length).trim()
  return text || undefined
}

/** 去掉要点。没有要点时返回原数组。 */
export function stripSessionBriefs(
  messages: readonly CanonicalMessage[],
): readonly CanonicalMessage[] {
  const next = messages.filter((message) => !isSessionBrief(message))
  return next.length === messages.length ? messages : next
}

/**
 * 把要点放在最前面。`brief` 为空时拿掉旧要点。
 * 已经是同一段文字时返回原数组，避免每次调用模型都重写历史。
 */
export function placeSessionBrief(
  messages: readonly CanonicalMessage[],
  brief: string,
  ts: number,
): readonly CanonicalMessage[] {
  const text = brief.trim()
  const rest = messages.filter((message) => !isSessionBrief(message))
  if (!text) return rest.length === messages.length ? messages : rest
  const content = SESSION_BRIEF_PREFIX + text
  const first = messages[0]
  if (
    rest.length + 1 === messages.length &&
    first &&
    isSessionBrief(first) &&
    first.content === content
  ) {
    return messages
  }
  return [sessionBriefMessage(text, ts), ...rest]
}
