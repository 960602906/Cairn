import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '@cairn/storage'
import { loadSessionMemory } from './session-memory.js'

function setup() {
  let now = 1_000
  const storage = createMemoryStorage({ now: () => now })
  storage.projects.create({ projectId: 'p1', name: 'A', path: '/work/a' })
  storage.projects.create({ projectId: 'p2', name: 'B', path: '/work/b' })
  storage.sessions.create({
    sessionId: 's1',
    projectId: 'p1',
    workspacePath: '/work/a',
    title: 'A1',
  })
  storage.sessions.create({
    sessionId: 's2',
    projectId: 'p1',
    workspacePath: '/work/a',
    title: 'A2',
  })
  storage.sessions.create({
    sessionId: 's3',
    projectId: 'p2',
    workspacePath: '/work/b',
    title: 'B1',
  })
  const add = (
    memoryId: string,
    scope: 'session' | 'project' | 'global',
    content: string,
    target = { sessionId: 's1', projectId: 'p1' },
    active = true,
  ) => {
    now += 1
    storage.memories.propose({
      memoryId,
      scope,
      content,
      ...(scope === 'session' ? { sessionId: target.sessionId } : {}),
      ...(scope === 'project' ? { projectId: target.projectId } : {}),
    })
    if (active) storage.memories.confirm(memoryId)
  }
  return { storage, add }
}

describe('loadSessionMemory', () => {
  it('只读取当前会话与当前项目的记忆，并按会话 → 项目 → 全局排序', () => {
    const { storage, add } = setup()
    add('g1', 'global', '全局偏好')
    add('p1m', 'project', 'A 项目约定')
    add('s1m', 'session', 'A1 会话约定')
    add('s2m', 'session', 'A2 会话约定', { sessionId: 's2', projectId: 'p1' })
    add('p2m', 'project', 'B 项目约定', { sessionId: 's3', projectId: 'p2' })
    const loaded = loadSessionMemory(storage, 's1', ['session', 'project', 'global'])
    expect(loaded?.text).toBe(
      '## Session\n- A1 会话约定\n\n## Project\n- A 项目约定\n\n## Global\n- 全局偏好',
    )
    expect(loaded?.entries).toBe(3)
    expect(loaded?.dropped).toBe(0)
    expect(loaded?.truncated).toBe(false)
  })

  it('按 Agent 声明的范围过滤：只声明会话时看不到项目与全局记忆', () => {
    const { storage, add } = setup()
    add('g1', 'global', '全局偏好')
    add('p1m', 'project', 'A 项目约定')
    add('s1m', 'session', 'A1 会话约定')
    expect(loadSessionMemory(storage, 's1', ['session'])?.text).toBe('## Session\n- A1 会话约定')
    expect(loadSessionMemory(storage, 's1', ['global'])?.text).toBe('## Global\n- 全局偏好')
    expect(loadSessionMemory(storage, 's1', [])).toBeUndefined()
  })

  it('不读取待确认的条目', () => {
    const { storage, add } = setup()
    add('pending', 'session', '还没确认', undefined, false)
    expect(loadSessionMemory(storage, 's1', ['session'])).toBeUndefined()
  })

  it('项目 B 的记忆不会出现在项目 A 的会话里', () => {
    const { storage, add } = setup()
    add('p2m', 'project', 'B 项目约定', { sessionId: 's3', projectId: 'p2' })
    expect(loadSessionMemory(storage, 's1', ['project'])).toBeUndefined()
    expect(loadSessionMemory(storage, 's3', ['project'])?.text).toBe('## Project\n- B 项目约定')
  })

  it('会话不存在时返回 undefined', () => {
    const { storage } = setup()
    expect(loadSessionMemory(storage, 'missing', ['session'])).toBeUndefined()
  })
})
