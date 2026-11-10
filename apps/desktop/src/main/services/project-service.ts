/**
 * 项目（M1-16a，M3-02，架构 §15.2）：实现 IPC 网关的 `ProjectCommands`。
 *
 * - **列表**（`project.list`）：还在列表中的项目，按打开时间倒序，带会话数和最近使用。
 * - **打开**（`project.open`）：用注入的 `pickDirectory` 选择目录。已打开过的返回原有记录
 *   （从列表移除过的会恢复）；否则以目录名为名称新建。用户取消时没有 `project`。
 * - **克隆**（`project.clone`）：把远端仓库克隆到指定父目录，再按打开目录的同一规则登记。
 * - **修改**（`project.update`）：名称、是否读取 `AGENTS.md`、是否启用项目内 Skills。
 * - **移除**（`project.remove`）：只从列表去掉，不删除目录和会话。
 * - **Git 摘要 / 切换分支**（`project.gitInfo` / `project.gitCheckout`）：输入框上方的目录与分支。
 *
 * 不依赖 Electron；对话框由入口注入（e2e 中替换为固定目录）。
 */
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { PROJECT_NAME_MAX_LENGTH, RpcError, type ProjectSummary } from '@cairn/protocol'
import type { ProjectRecord, Storage } from '@cairn/storage'
import { workspaceNameFromRemoteUrl, type CloneRepositoryInput } from './git-clone.js'
import type { ProjectGitInfo } from './git-info.js'

export const ProjectServiceErrorCode = {
  /** 对话框返回的不是绝对路径。 */
  InvalidPath: 'project.invalid_path',
  /** 项目不在列表中。 */
  NotFound: 'project.not_found',
  /** 名称是空的，或超过长度上限。 */
  InvalidName: 'project.invalid_name',
  /** 主进程没有接入 Git 克隆能力。 */
  CloneUnavailable: 'project.clone_unavailable',
  /** 主进程没有接入 Git 能力。 */
  GitUnavailable: 'project.git_unavailable',
} as const

export interface ProjectServiceOptions {
  readonly storage: Pick<Storage, 'projects' | 'sessions'>
  /** 选择目录；取消时返回 undefined。 */
  readonly pickDirectory: () => Promise<string | undefined>
  /** 克隆仓库并返回目标目录；省略时 `project.clone` 报错。 */
  readonly cloneRepository?: (input: CloneRepositoryInput) => Promise<string>
  /** 读取项目目录的 Git 摘要；省略时 `project.gitInfo` 只返回空对象。 */
  readonly readGitInfo?: (path: string) => Promise<ProjectGitInfo>
  /** 切换项目目录的 Git 分支；省略时 `project.gitCheckout` 报错。 */
  readonly checkoutGitBranch?: (path: string, branch: string) => Promise<ProjectGitInfo>
  readonly createId?: () => string
}

export interface ProjectCommands {
  list(): { projects: ProjectSummary[] }
  open(): Promise<{ project?: ProjectSummary }>
  pickDirectory(): Promise<{ path?: string }>
  clone(input: {
    remoteUrl: string
    parentPath: string
    name?: string | undefined
    branch?: string | undefined
  }): Promise<{ project: ProjectSummary }>
  gitInfo(input: { path: string }): Promise<ProjectGitInfo>
  gitCheckout(input: { path: string; branch: string }): Promise<ProjectGitInfo>
  update(input: {
    projectId: string
    name?: string | undefined
    readAgentsMd?: boolean | undefined
    enableProjectSkills?: boolean | undefined
    pinned?: boolean | undefined
    archived?: boolean | undefined
  }): ProjectSummary
  remove(input: { projectId: string }): Record<string, never>
}

function summarize(storage: Pick<Storage, 'sessions'>, project: ProjectRecord): ProjectSummary {
  const sessions = storage.sessions.list({
    projectId: project.projectId,
    includeArchived: true,
  })
  const lastUsedAt = sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0)
  return {
    projectId: project.projectId,
    name: project.name,
    path: project.path,
    createdAt: project.createdAt,
    sessionCount: sessions.filter((session) => !session.archived).length,
    ...(lastUsedAt > 0 ? { lastUsedAt } : {}),
    readAgentsMd: project.readAgentsMd,
    enableProjectSkills: project.enableProjectSkills,
    ...(project.pinnedAt === undefined ? {} : { isPinned: true, pinnedAt: project.pinnedAt }),
    ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
  }
}

export function createProjectService(options: ProjectServiceOptions): ProjectCommands {
  const { storage } = options
  const createId = options.createId ?? randomUUID
  const register = (path: string): ProjectRecord => {
    const existing = storage.projects.getByPath(path)
    return existing
      ? existing.removedAt !== undefined
        ? storage.projects.restore(existing.projectId)
        : existing
      : storage.projects.create({
          projectId: createId(),
          name: basename(path) || path,
          path,
        })
  }
  const listed = (projectId: string): ProjectRecord => {
    const project = storage.projects.get(projectId)
    if (!project || project.removedAt !== undefined) {
      throw new RpcError(ProjectServiceErrorCode.NotFound, { projectId })
    }
    return project
  }

  return {
    list: () => ({
      projects: storage.projects.list().map((project) => summarize(storage, project)),
    }),

    async open() {
      const path = await options.pickDirectory()
      if (path === undefined) return {}
      if (!isAbsolute(path)) throw new RpcError(ProjectServiceErrorCode.InvalidPath, { path })
      const project = register(path)
      return { project: summarize(storage, project) }
    },

    async pickDirectory() {
      const path = await options.pickDirectory()
      return path === undefined ? {} : { path }
    },

    async clone(input) {
      if (!options.cloneRepository) {
        throw new RpcError(ProjectServiceErrorCode.CloneUnavailable)
      }
      const name = input.name?.trim() || workspaceNameFromRemoteUrl(input.remoteUrl)
      const path = await options.cloneRepository({
        remoteUrl: input.remoteUrl,
        parentPath: input.parentPath,
        name,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
      })
      if (!isAbsolute(path)) throw new RpcError(ProjectServiceErrorCode.InvalidPath, { path })
      return { project: summarize(storage, register(path)) }
    },

    async gitInfo({ path }) {
      if (!isAbsolute(path)) {
        throw new RpcError(ProjectServiceErrorCode.InvalidPath, { path })
      }
      return options.readGitInfo ? options.readGitInfo(path) : {}
    },

    async gitCheckout({ path, branch }) {
      if (!isAbsolute(path)) {
        throw new RpcError(ProjectServiceErrorCode.InvalidPath, { path })
      }
      if (!options.checkoutGitBranch) {
        throw new RpcError(ProjectServiceErrorCode.GitUnavailable)
      }
      return options.checkoutGitBranch(path, branch)
    },

    update(input) {
      listed(input.projectId)
      const patch: {
        name?: string
        readAgentsMd?: boolean
        enableProjectSkills?: boolean
        pinned?: boolean
        archived?: boolean
      } = {}
      if (input.name !== undefined) {
        const name = input.name.trim()
        if (name === '' || name.length > PROJECT_NAME_MAX_LENGTH) {
          throw new RpcError(ProjectServiceErrorCode.InvalidName)
        }
        patch.name = name
      }
      if (input.readAgentsMd !== undefined) patch.readAgentsMd = input.readAgentsMd
      if (input.enableProjectSkills !== undefined)
        patch.enableProjectSkills = input.enableProjectSkills
      if (input.pinned !== undefined) patch.pinned = input.pinned
      if (input.archived !== undefined) patch.archived = input.archived
      const project =
        patch.name !== undefined ||
        patch.readAgentsMd !== undefined ||
        patch.enableProjectSkills !== undefined ||
        patch.pinned !== undefined ||
        patch.archived !== undefined
          ? storage.projects.update(input.projectId, patch)
          : listed(input.projectId)
      return summarize(storage, project)
    },

    remove({ projectId }) {
      listed(projectId)
      storage.projects.remove(projectId)
      return {}
    },
  }
}
