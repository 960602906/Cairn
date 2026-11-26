/**
 * 会话全文搜索的公共部分：从事件里取出可搜索的正文，生成命中附近的片段。
 *
 * 只索引用户与助手的消息正文；推理、工具输入输出与事件元数据不参与搜索，
 * 避免把巨大的工具输出塞进索引，也避免搜到不该出现在结果里的内容。
 */
import type { ContentPart, PersistedEvent } from '@cairn/protocol'

/** 消息正文里的可搜索文本：只取文字部分，图片等占位不参与搜索。 */
export function contentText(content: readonly ContentPart[]): string | undefined {
  const text = content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
  return text === '' ? undefined : text
}

/** 事件里的可搜索正文；不是消息或没有文字时为 undefined。 */
export function searchableText(event: PersistedEvent): string | undefined {
  if (event.type !== 'message.user' && event.type !== 'message.assistant.completed') {
    return undefined
  }
  return contentText(event.payload.content)
}

/** 搜索词是否都出现（不区分大小写）；空查询不算命中。 */
export function matchesQuery(text: string, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) return false
  const haystack = text.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * 命中附近的片段：压平换行与连续空白，取第一个命中词前后各一段，两端加省略号。
 * 命中词在压平后的文本里查找，和界面看到的内容一致。
 */
export function searchSnippet(text: string, query: string, radius = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const haystack = flat.toLowerCase()
  let index = -1
  let length = 0
  for (const term of query
    .toLowerCase()
    .split(/\s+/)
    .filter((value) => value !== '')) {
    const at = haystack.indexOf(term)
    if (at !== -1 && (index === -1 || at < index)) {
      index = at
      length = term.length
    }
  }
  if (index === -1) index = 0
  const start = Math.max(0, index - radius)
  const end = Math.min(flat.length, index + length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** 查询至少有一个非空白词。 */
export function normalizeQuery(query: string): string | undefined {
  const normalized = query.trim().replace(/\s+/g, ' ')
  return normalized === '' ? undefined : normalized
}
