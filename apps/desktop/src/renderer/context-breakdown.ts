/**
 * 上下文用量分类：把最近一次模型调用前的快照整理成互斥的估算项。
 *
 * 系统提示词里的 `# Skills` / `# Pinned skills` 就是技能索引/正文，`snapshot.skills`
 * 是同一份内容的平行列表。这里只按系统提示词的 section 计一次，避免重复相加。
 */
import { estimateTokens } from '@cairn/core'
import type { RunSnapshot } from '@cairn/protocol'

export type ContextPartKey = 'system' | 'skills' | 'tools' | 'history' | 'compaction'

export interface ContextPart {
  readonly key: ContextPartKey
  readonly tokens: number
  /** 设计令牌里的纯色 class，用于占比条与圆点。 */
  readonly tone: string
}

export interface ContextBreakdown {
  readonly parts: readonly ContextPart[]
  readonly total: number
}

const TONES: Readonly<Record<ContextPartKey, string>> = {
  system: 'bg-accent',
  skills: 'bg-ok',
  tools: 'bg-warn',
  history: 'bg-muted',
  compaction: 'bg-danger',
}

const SKILL_TITLES = new Set(['Skills', 'Pinned skills'])

/** 最近的一份快照；快照按创建时间可能不是顺序排列。 */
export function latestSnapshot(snapshots: readonly RunSnapshot[]): RunSnapshot | undefined {
  return snapshots.reduce<RunSnapshot | undefined>(
    (latest, item) => (latest === undefined || item.createdAt > latest.createdAt ? item : latest),
    undefined,
  )
}

export function contextBreakdown(snapshot: RunSnapshot | undefined): ContextBreakdown {
  if (snapshot === undefined) {
    return { parts: [], total: 0 }
  }
  let system = 0
  let skills = 0
  for (const section of snapshot.systemPrompt) {
    if (SKILL_TITLES.has(section.title.trim())) skills += section.tokens
    else system += section.tokens
  }
  const tools = snapshot.tools.reduce((sum, tool) => sum + tool.tokens, 0)
  const history = snapshot.history.tokens
  const compaction = snapshot.compaction
    ? estimateTokens(snapshot.compaction.summary)
    : 0
  const values: Readonly<Record<ContextPartKey, number>> = {
    system,
    skills,
    tools,
    history,
    compaction,
  }
  const parts = (Object.keys(TONES) as ContextPartKey[])
    .map((key) => ({ key, tokens: values[key], tone: TONES[key] }))
    .filter((part) => part.tokens > 0)
  return {
    parts,
    total: parts.reduce((sum, part) => sum + part.tokens, 0),
  }
}
