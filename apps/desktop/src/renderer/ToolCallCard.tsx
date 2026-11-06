/**
 * 消息流中的工具调用（M1-16b）：工具名、参数摘要、状态，以及输出的前几行（执行中显示实时输出的最后几行）。
 * 状态来自 `tool.*` 事件的投影；完整输出与参数的展示（工具卡片样式、终端面板）在 M2。
 *
 * 不使用 `<p>`：消息流的测试按段落读取消息正文。
 */
import { useTranslation } from 'react-i18next'
import type { LiveToolOutputView, ToolCallView } from '@nexus/core'
import { translateError } from '@nexus/i18n'
import type { ContentPart } from '@nexus/protocol'

/** 输出最多显示的行数。 */
export const OUTPUT_PREVIEW_LINES = 5
/** 参数摘要的最大字符数。 */
export const INPUT_SUMMARY_CHARS = 120

/** 参数中最能说明调用的字段，按顺序取第一个字符串。 */
const SUMMARY_KEYS = ['command', 'path', 'pattern', 'query', 'url'] as const

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** 参数摘要：常见字段（命令、路径、搜索词）直接显示，否则显示单行 JSON。 */
export function summarizeInput(input: unknown): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const key of SUMMARY_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') {
        return truncate(value.replace(/\s+/g, ' ').trim(), INPUT_SUMMARY_CHARS)
      }
    }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    json = undefined
  }
  return truncate(json ?? String(input), INPUT_SUMMARY_CHARS)
}

/** 取文本的前（或后）几行，返回显示的行与省略的行数。 */
export function previewLines(
  text: string,
  from: 'start' | 'end',
  max = OUTPUT_PREVIEW_LINES,
): { readonly lines: string; readonly omitted: number } {
  const all = text.replace(/\n+$/, '').split('\n')
  if (all.length <= max) return { lines: all.join('\n'), omitted: 0 }
  const shown = from === 'start' ? all.slice(0, max) : all.slice(-max)
  return { lines: shown.join('\n'), omitted: all.length - max }
}

const outputText = (parts: readonly ContentPart[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')

export function ToolCallCard({
  name,
  input,
  tool,
  live,
}: {
  readonly name: string
  /** 模型给出的参数（工具事件到达之前使用）。 */
  readonly input: unknown
  readonly tool: ToolCallView | undefined
  readonly live: LiveToolOutputView | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const status = tool?.status ?? 'requested'
  const running = status === 'running' && live !== undefined
  const text = running
    ? live.chunks.map((c) => c.text).join('')
    : tool?.output
      ? outputText(tool.output)
      : ''
  const preview = text.trim() === '' ? undefined : previewLines(text, running ? 'end' : 'start')

  return (
    <section aria-label={t('message.toolCall', { name })} data-status={status}>
      <strong>{name}</strong> <code>{summarizeInput(tool?.input ?? input)}</code>{' '}
      <span>{t(`tool.status.${status}`)}</span>
      {tool?.error && <div role="note">{translateError(i18n, tool.error)}</div>}
      {preview && (
        <>
          {running && preview.omitted > 0 && (
            <div>{t('tool.earlierLines', { count: preview.omitted })}</div>
          )}
          <pre>{preview.lines}</pre>
          {!running && preview.omitted > 0 && (
            <div>{t('tool.moreLines', { count: preview.omitted })}</div>
          )}
        </>
      )}
      {tool?.truncated && <div>{t('tool.truncated')}</div>}
    </section>
  )
}
