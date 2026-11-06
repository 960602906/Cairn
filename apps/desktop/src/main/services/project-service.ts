/**
 * 项目（M1-16a，架构 §15.2）：实现 IPC 网关的 `ProjectCommands`。
 *
 * - **列表**（`project.list`）：数据库中的项目，按打开时间倒序。
 * - **打开**（`project.open`）：用注入的 `pickDirectory`（主进程中是系统的选择文件夹对话框）选择目录，
 *   已打开过的返回原有记录，否则以目录名为名称新建。用户取消时没有 `project`。
 *
 * 不依赖 Electron；对话框由入口注入（e2e 中替换为固定目录）。
 */
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { RpcError, type ProjectSummary } from '@cairn/protocol'
import type { ProjectRecord, Storage } from '@cairn/storage'

export const ProjectServiceErrorCode = {
  /** 对话框返回的不是绝对路径。 */
  InvalidPath: 'project.invalid_path',
} as const

export interface ProjectServiceOptions {
  readonly storage: Pick<Storage, 'projects'>
  /** 选择目录；取消时返回 undefined。 */
  readonly pickDirectory: () => Promise<string | undefined>
  readonly createId?: () => string
}

export interface ProjectCommands {
  list(): { projects: ProjectSummary[] }
  open(): Promise<{ project?: ProjectSummary }>
}

const toSummary = ({ projectId, name, path, createdAt }: ProjectRecord): ProjectSummary => ({
  projectId,
  name,
  path,
  createdAt,
})

export function createProjectService(options: ProjectServiceOptions): ProjectCommands {
  const { storage } = options
  const createId = options.createId ?? randomUUID
  return {
    list: () => ({ projects: storage.projects.list().map(toSummary) }),

    async open() {
      const path = await options.pickDirectory()
      if (path === undefined) return {}
      if (!isAbsolute(path)) throw new RpcError(ProjectServiceErrorCode.InvalidPath, { path })
      const project =
        storage.projects.getByPath(path) ??
        storage.projects.create({ projectId: createId(), name: basename(path) || path, path })
      return { project: toSummary(project) }
    },
  }
}
