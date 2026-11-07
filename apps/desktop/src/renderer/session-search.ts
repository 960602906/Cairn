/**
 * 会话搜索（M2-12）：按标题、未命名时的显示名、项目名或路径过滤，大小写不敏感。
 * 空白查询保留列表原有顺序（最近更新在前）。
 */
import type { ProjectSummary, SessionSummary } from '@cairn/protocol'
import { lastSegment } from './paths.js'

export interface SearchHit {
  readonly session: SessionSummary
  /** 显示用的标题：空标题换成未命名文案，搜索也按它匹配。 */
  readonly title: string
  readonly projectName: string
}

export function searchSessions(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
  query: string,
  untitledLabel: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase()
  const hits = sessions.map((session) => {
    const title = session.title === '' ? untitledLabel : session.title
    const projectName =
      projects.find((project) => project.path === session.projectPath)?.name ??
      lastSegment(session.projectPath)
    return { session, title, projectName }
  })
  if (needle === '') return hits
  return hits.filter((hit) =>
    [hit.title, hit.projectName, hit.session.projectPath].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  )
}
