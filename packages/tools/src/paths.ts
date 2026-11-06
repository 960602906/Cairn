/**
 * Node 版的工作区路径解析（M1-06b 的 `resolveWorkspacePath` + `fs.realpath`）。
 */
import fs from 'node:fs/promises'
import {
  resolveWorkspacePath,
  ToolError,
  type PathFileSystem,
  type PathResolution,
  type PathStyle,
  type ToolContext,
  type WorkspacePath,
} from '@cairn/core'

export const PATH_STYLE: PathStyle = process.platform === 'win32' ? 'win32' : 'posix'

const isNotFound = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 基于 `fs.realpath` 与 `fs.lstat` 的 `PathFileSystem`。 */
export const nodePathFileSystem: PathFileSystem = {
  async realpath(path) {
    try {
      return await fs.realpath(path)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  },
  async exists(path) {
    try {
      await fs.lstat(path)
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  },
}

/** `ToolContext.resolvePath` 的 Node 实现。 */
export function createPathResolver(
  workspaceRoot: string,
  style: PathStyle = PATH_STYLE,
): (input: string) => Promise<PathResolution> {
  return (input) => resolveWorkspacePath(workspaceRoot, input, { style, fs: nodePathFileSystem })
}

/** 给模型的路径错误说明（英文）。 */
const PATH_MESSAGES: Readonly<Record<string, string>> = {
  'path.empty': 'The path is empty.',
  'path.invalid_character': 'The path contains characters that are not allowed.',
  'path.malformed': 'The path is malformed.',
  'path.drive_relative':
    'Drive-relative paths such as "C:foo" are not supported. Use a path relative to the workspace.',
  'path.device': 'Device paths and reserved device names are not allowed.',
  'path.outside_workspace':
    'The path is outside the workspace. Only files inside the workspace can be accessed.',
  'path.root_not_absolute': 'The workspace root is not an absolute path.',
  'path.root_not_found': 'The workspace folder does not exist.',
  'path.broken_link': 'The path goes through a symbolic link whose target does not exist.',
}

/** 解析路径；失败时抛出 `ToolError`（错误码为 `path.*`，`params.path` 为模型给出的路径）。 */
export async function resolveOrThrow(ctx: ToolContext, input: string): Promise<WorkspacePath> {
  const result = await ctx.resolvePath(input)
  if (result.ok) return result.path
  throw new ToolError(
    result.code,
    `${PATH_MESSAGES[result.code] ?? 'The path is invalid.'} (path: ${input})`,
    {
      path: input,
    },
  )
}
