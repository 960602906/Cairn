import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '@cairn/protocol'
import { contextBreakdown, latestSnapshot } from './context-breakdown.js'

const snapshot = (patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  snapshotId: 'snap1',
  sessionId: 's1',
  runId: 'r1',
  agent: { id: 'builtin.coder', version: 1 },
  model: { providerId: 'fake', modelId: 'fake-1' },
  createdAt: 10,
  tokens: 100,
  systemPrompt: [
    { title: 'Base prompt', text: 'base', tokens: 52 },
    { title: 'Skills', text: '- tdd: description', tokens: 30 },
    { title: 'Pinned skills', text: 'instructions', tokens: 20 },
  ],
  skills: [{ name: 'tdd', description: 'description', pinned: false, tokens: 30 }],
  tools: [{ name: 'read_file', description: 'read', tokens: 10 }],
  history: { messages: 1, tokens: 8, preview: [] },
  ...patch,
})

describe('contextBreakdown', () => {
  it('把技能提示词归入技能且不重复计入平行技能列表', () => {
    const result = contextBreakdown(snapshot())
    expect(result.parts).toEqual([
      { key: 'system', tokens: 52, tone: 'bg-accent' },
      { key: 'skills', tokens: 50, tone: 'bg-ok' },
      { key: 'tools', tokens: 10, tone: 'bg-warn' },
      { key: 'history', tokens: 8, tone: 'bg-muted' },
    ])
    expect(result.total).toBe(120)
  })

  it('估算压缩摘要并算入总量', () => {
    const result = contextBreakdown(
      snapshot({ compaction: { summary: '之前的目标', coversTurns: ['t0', 't1'] } }),
    )
    expect(result.parts.at(-1)).toMatchObject({ key: 'compaction', tokens: 5 })
    expect(result.total).toBe(125)
  })

  it('没有快照或全部为零时是空结果', () => {
    expect(contextBreakdown(undefined)).toEqual({ parts: [], total: 0 })
    expect(
      contextBreakdown(
        snapshot({
          systemPrompt: [],
          skills: [],
          tools: [],
          history: { messages: 0, tokens: 0, preview: [] },
        }),
      ),
    ).toEqual({ parts: [], total: 0 })
  })

  it('旧快照没有技能 section 时仍按系统提示词计数', () => {
    const result = contextBreakdown(
      snapshot({ systemPrompt: [{ title: '基础指令', text: 'base', tokens: 40 }] }),
    )
    expect(result.parts[0]).toMatchObject({ key: 'system', tokens: 40 })
    expect(result.parts.some((part) => part.key === 'skills')).toBe(false)
  })
})

describe('latestSnapshot', () => {
  it('按创建时间选最近的一份', () => {
    const older = snapshot({ snapshotId: 'old', createdAt: 1 })
    const newer = snapshot({ snapshotId: 'new', createdAt: 20 })
    expect(latestSnapshot([older, newer])?.snapshotId).toBe('new')
    expect(latestSnapshot([newer, older])?.snapshotId).toBe('new')
    expect(latestSnapshot([])).toBeUndefined()
  })
})
