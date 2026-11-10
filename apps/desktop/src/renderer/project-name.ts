/** 项目名称的显示规则：默认项目按当前界面语言显示，普通项目使用保存的名称。 */
import type { ProjectSummary } from '@cairn/protocol'
import { lastSegment } from './paths.js'

export function projectDisplayName(
  project: Pick<ProjectSummary, 'name' | 'isDefault'> | undefined,
  defaultName?: string,
  fallback = '',
): string {
  if (project?.isDefault === true) return defaultName ?? project.name
  return project?.name ?? fallback
}

/** 按路径找项目并返回显示名；项目还没读到时退回路径最后一段。 */
export function projectNameForPath(
  path: string | undefined,
  projects: readonly ProjectSummary[],
  defaultName: string,
): string | undefined {
  if (path === undefined) return undefined
  const project = projects.find((item) => item.path === path)
  return projectDisplayName(project, defaultName, lastSegment(path))
}
