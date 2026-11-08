/**
 * 上下文快照（M4-04，ADR-0033）：在每次模型调用前，把实际发送的系统提示词、工具、技能、历史与
 * 压缩摘要整理成可检查的摘要。只保存估算 token 与截断后的预览，不保存完整工具输出。
 */
import {
  type RunAgentRef,
  type CanonicalMessage,
  type ModelRef,
  type RunSnapshotInput,
  type RunSnapshotMessage,
  type RunSnapshotSection,
  type RunSnapshotSkill,
  type RunSnapshotTool,
} from '@cairn/protocol'
import { estimateTokens } from './context-budget.js'
import type { RuntimeToolSpec } from './runtime.js'

/** 单份快照的字符上限；超过时先丢历史预览，再截断文本。 */
export const RUN_SNAPSHOT_MAX_CHARS = 32_000
const SECTION_MAX_CHARS = 4_000
const TOOL_DESCRIPTION_MAX_CHARS = 500
const HISTORY_PREVIEW_MAX = 20
const HISTORY_MESSAGE_MAX_CHARS = 400
const COMPACTION_SUMMARY_MAX_CHARS = 2_000

export interface SnapshotCompaction {
  readonly summary: string
  readonly coversTurns: readonly [string, string]
  readonly tokensBefore?: number
  readonly tokensAfter?: number
}

export interface BuildRunSnapshotInput {
  readonly runId: string
  readonly parentRunId?: string
  readonly agent: RunAgentRef
  readonly model: ModelRef
  readonly turnId?: string
  readonly stepId?: string
  readonly systemPrompt: string
  readonly tools: readonly RuntimeToolSpec[]
  readonly skills?: readonly {
    readonly name: string
    readonly description: string
    readonly pinned: boolean
  }[]
  readonly history: readonly CanonicalMessage[]
  readonly compaction?: SnapshotCompaction
}

/** 按标题拆系统提示词；没有标题的放在第一段。 */
export function splitSystemPrompt(prompt: string): RunSnapshotSection[] {
  const parts = prompt
    .split(/\n{2,}(?=# )/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.map((part) => {
    const firstLine = part.split('\n', 1)[0]!
    const title = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : 'Base prompt'
    return {
      title,
      text: part.slice(0, SECTION_MAX_CHARS),
      tokens: estimateTokens(part),
    }
  })
}

function messageText(message: CanonicalMessage): string {
  if (message.role === 'summary') return `Summary: ${message.content}`
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return [text, `Tool calls: ${message.toolCalls.map((call) => call.name).join(', ')}`]
      .filter((part) => part.length > 0)
      .join('\n')
  }
  return text
}

/** 按字符上限裁剪：先丢最早的历史预览，再截断各段文本。 */
export function fitSnapshot(snapshot: RunSnapshotInput): RunSnapshotInput {
  let current = snapshot
  const size = () => JSON.stringify(current).length
  while (size() > RUN_SNAPSHOT_MAX_CHARS && current.history.preview.length > 0) {
    current = {
      ...current,
      history: { ...current.history, preview: current.history.preview.slice(1) },
    }
  }
  while (size() > RUN_SNAPSHOT_MAX_CHARS) {
    const longestSection = [...current.systemPrompt]
      .sort((a, b) => b.text.length - a.text.length)
      .find((section) => section.text.length > 0)
    if (longestSection) {
      current = {
        ...current,
        systemPrompt: current.systemPrompt.map((section) =>
          section === longestSection
            ? { ...section, text: section.text.slice(0, Math.floor(section.text.length / 2)) }
            : section,
        ),
      }
      continue
    }

    const longestTool = [...current.tools]
      .sort((a, b) => b.description.length - a.description.length)
      .find((tool) => tool.description.length > 0)
    if (longestTool) {
      current = {
        ...current,
        tools: current.tools.map((tool) =>
          tool === longestTool
            ? {
                ...tool,
                description: tool.description.slice(0, Math.floor(tool.description.length / 2)),
              }
            : tool,
        ),
      }
      continue
    }

    const longestSkill = [...current.skills]
      .sort((a, b) => b.description.length - a.description.length)
      .find((skill) => skill.description.length > 0)
    if (!longestSkill) break
    current = {
      ...current,
      skills: current.skills.map((skill) =>
        skill === longestSkill
          ? {
              ...skill,
              description: skill.description.slice(0, Math.floor(skill.description.length / 2)),
            }
          : skill,
      ),
    }
  }
  return current
}

export function buildRunSnapshot(input: BuildRunSnapshotInput): RunSnapshotInput {
  const systemPrompt = splitSystemPrompt(input.systemPrompt)
  const tools: RunSnapshotTool[] = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description.slice(0, TOOL_DESCRIPTION_MAX_CHARS),
    tokens: estimateTokens(`${tool.name}\n${tool.description}`),
  }))
  const skills: RunSnapshotSkill[] = (input.skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description.slice(0, TOOL_DESCRIPTION_MAX_CHARS),
    pinned: skill.pinned,
    tokens: estimateTokens(`${skill.name}\n${skill.description}`),
  }))

  const preview: RunSnapshotMessage[] = []
  let historyTokens = 0
  for (const message of input.history) {
    const text = messageText(message)
    historyTokens += estimateTokens(text)
    preview.push({
      role: message.role,
      text: text.slice(0, HISTORY_MESSAGE_MAX_CHARS),
      tokens: estimateTokens(text),
      ts: message.ts,
    })
  }

  const compaction =
    input.compaction === undefined
      ? undefined
      : {
          summary: input.compaction.summary.slice(0, COMPACTION_SUMMARY_MAX_CHARS),
          coversTurns: [input.compaction.coversTurns[0], input.compaction.coversTurns[1]] as [
            string,
            string,
          ],
          ...(input.compaction.tokensBefore === undefined
            ? {}
            : { tokensBefore: input.compaction.tokensBefore }),
          ...(input.compaction.tokensAfter === undefined
            ? {}
            : { tokensAfter: input.compaction.tokensAfter }),
        }

  const tokens =
    systemPrompt.reduce((sum, section) => sum + section.tokens, 0) +
    tools.reduce((sum, tool) => sum + tool.tokens, 0) +
    skills.reduce((sum, skill) => sum + skill.tokens, 0) +
    historyTokens +
    (compaction ? estimateTokens(compaction.summary) : 0)

  return fitSnapshot({
    runId: input.runId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    agent: input.agent,
    model: input.model,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    tokens,
    systemPrompt,
    skills,
    tools,
    history: {
      messages: input.history.length,
      tokens: historyTokens,
      preview: preview.slice(-HISTORY_PREVIEW_MAX),
    },
    ...(compaction ? { compaction } : {}),
  })
}
