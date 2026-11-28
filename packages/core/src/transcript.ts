/**
 * 导出对话（Markdown）：把会话里的用户与助手消息拼成可直接分享的 Markdown。
 *
 * 只导出对话正文、图片占位与工具调用名称；推理、工具输入输出与内部事件不写入，
 * 避免导出文件过大或带出不该分享的内容。中文与英文两种标题由调用方按界面语言选择。
 */
import type { ContentPart } from '@cairn/protocol'
import type { MessageView } from './session-view.js'

export type TranscriptLocale = 'zh-CN' | 'en-US'

interface TranscriptLabels {
  readonly user: string
  readonly assistant: string
  readonly image: string
  readonly file: (name: string) => string
  readonly incomplete: string
  readonly tools: (names: string) => string
  readonly untitled: string
}

const LABELS: Record<TranscriptLocale, TranscriptLabels> = {
  'zh-CN': {
    user: '用户',
    assistant: '助手',
    image: '[图片]',
    file: (name) => `[附件：${name}]`,
    incomplete: '（回复未完成）',
    tools: (names) => `工具调用：${names}`,
    untitled: '未命名会话',
  },
  'en-US': {
    user: 'User',
    assistant: 'Assistant',
    image: '[image]',
    file: (name) => `[file: ${name}]`,
    incomplete: '(reply incomplete)',
    tools: (names) => `Tool calls: ${names}`,
    untitled: 'Untitled chat',
  },
}

export interface TranscriptOptions {
  readonly title: string
  readonly locale?: TranscriptLocale
  /** 项目 / 工作区路径，写在标题下的引用行；省略时不写。 */
  readonly projectPath?: string
}

function partText(part: ContentPart, labels: TranscriptLabels): string {
  if (part.type === 'text') return part.text
  return part.type === 'image' ? labels.image : labels.file(part.name)
}

/** 工具调用名称按首次出现顺序汇总；重复调用显示次数，如 `Read`、`Bash×2`。 */
function toolSummary(
  message: Extract<MessageView, { role: 'assistant' }>,
  separator: string,
): string {
  const counts = new Map<string, number>()
  for (const call of message.toolCalls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, count]) => (count === 1 ? name : `${name}×${count}`))
    .join(separator)
}

/** 会话导出的 Markdown：标题、项目路径（可选）与按时间排列的消息。 */
export function transcriptMarkdown(
  messages: readonly MessageView[],
  options: TranscriptOptions,
): string {
  const locale = options.locale ?? 'zh-CN'
  const labels = LABELS[locale]
  const blocks: string[] = []
  const title = options.title.replace(/\s+/g, ' ').trim()
  blocks.push(`# ${title === '' ? labels.untitled : title}`)
  if (options.projectPath !== undefined && options.projectPath !== '') {
    blocks.push(`> ${options.projectPath}`)
  }
  for (const message of messages) {
    const text = message.content
      .map((part) => partText(part, labels))
      .join('')
      .trim()
    if (message.role === 'user') {
      if (text === '') continue
      blocks.push(`## ${labels.user}\n\n${text}`)
      continue
    }
    const lines: string[] = []
    if (text !== '') lines.push(text)
    if (message.incomplete) lines.push(`_${labels.incomplete}_`)
    const tools =
      message.toolCalls.length === 0 ? '' : toolSummary(message, locale === 'zh-CN' ? '、' : ', ')
    if (tools !== '') lines.push(`> ${labels.tools(tools)}`)
    if (lines.length === 0) continue
    blocks.push(`## ${labels.assistant}\n\n${lines.join('\n\n')}`)
  }
  return `${blocks.join('\n\n')}\n`
}

const ILLEGAL_FILENAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])

/** Windows / macOS / Linux 都不接受的文件名字符，以及控制字符，替换成空格。 */
function cleanFileNameChar(char: string): string {
  const code = char.codePointAt(0) ?? 0
  return ILLEGAL_FILENAME_CHARS.has(char) || code < 0x20 ? ' ' : char
}

/** 保存对话框里的默认文件名：去掉路径分隔符与控制字符，空标题回退到 `session`。 */
export function transcriptFileName(title: string): string {
  const base = Array.from(title, cleanFileNameChar)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return `${base === '' ? 'session' : base}.md`
}
