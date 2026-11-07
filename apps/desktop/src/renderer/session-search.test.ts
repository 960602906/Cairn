import { describe, expect, it } from 'vitest'
import type { ProjectSummary, SessionSummary } from '@cairn/protocol'
import { searchSessions } from './session-search.js'

const session = (sessionId: string, title: string, projectPath = '/work/api'): SessionSummary => ({
  sessionId,
  title,
  projectPath,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
})

const projects: readonly ProjectSummary[] = [
  { projectId: 'p1', name: 'API 服务', path: '/work/api', createdAt: 1 },
]

describe('searchSessions', () => {
  const sessions = [
    session('a', '修复登录'),
    session('b', '', '/work/web'),
    session('c', '写 README', '/work/api'),
  ]

  it('returns every session when the query is blank, using the untitled label', () => {
    const hits = searchSessions(sessions, projects, '  ', '未命名会话')
    expect(hits.map((hit) => [hit.session.sessionId, hit.title, hit.projectName])).toEqual([
      ['a', '修复登录', 'API 服务'],
      ['b', '未命名会话', 'web'],
      ['c', '写 README', 'API 服务'],
    ])
  })

  it('matches title, the untitled label, project name, and path, case-insensitively', () => {
    expect(
      searchSessions(sessions, projects, '登录', '未命名会话').map((h) => h.session.sessionId),
    ).toEqual(['a'])
    expect(
      searchSessions(sessions, projects, '未命名', '未命名会话').map((h) => h.session.sessionId),
    ).toEqual(['b'])
    expect(
      searchSessions(sessions, projects, 'api 服务', '未命名会话').map((h) => h.session.sessionId),
    ).toEqual(['a', 'c'])
    expect(
      searchSessions(sessions, projects, 'WORK/WEB', '未命名会话').map((h) => h.session.sessionId),
    ).toEqual(['b'])
    expect(searchSessions(sessions, projects, '不存在', '未命名会话')).toEqual([])
  })
})
