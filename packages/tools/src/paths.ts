/**
 * Node 版的工作区路径解析（M1-06b 的 `resolveWorkspacePath` + `fs.realpath`）。
 */
import fs from 'node:fs/promises'
import {
  PathErrorCode,
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

export interface PathResolverOptions {
  readonly style?: PathStyle
  /**
   * 技能目录（M3-07）。这些目录里的路径可以读，调用方应把结果标成只读。
   * 每次解析时读取，以便每轮换上当前启用的技能。
   */
  readonly readOnlyRoots?: () => readonly string[]
}

/** `ToolContext.resolvePath` 的 Node 实现。第二个参数可以是路径风格，或带只读根目录的选项。 */
export function createPathResolver(
  workspaceRoot: string,
  styleOrOptions: PathStyle | PathResolverOptions = PATH_STYLE,
): (input: string) => Promise<PathResolution> {
  const options = typeof styleOrOptions === 'string' ? { style: styleOrOptions } : styleOrOptions
  const style = options.style ?? PATH_STYLE
  const readOnlyRoots = options.readOnlyRoots ?? (() => [])
  const fsOptions = { style, fs: nodePathFileSystem }
  return async (input) => {
    const primary = await resolveWorkspacePath(workspaceRoot, input, fsOptions)
    const roots = readOnlyRoots()
    if (primary.ok) {
      for (const root of roots) {
        const inside = await resolveWorkspacePath(root, primary.path.absolute, fsOptions)
        if (inside.ok) return { ok: true, path: primary.path, readOnly: true }
      }
      return primary
    }
    if (primary.code !== PathErrorCode.OutsideWorkspace) return primary
    for (const root of roots) {
      const extra = await resolveWorkspacePath(root, input, fsOptions)
      if (extra.ok) return { ok: true, path: extra.path, readOnly: true }
    }
    return primary
  }
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
  'path.read_only':
    'The path is inside a skill directory and can only be read. Change the project files instead.',
}

function invalidPath(code: string, input: string): ToolError {
  return new ToolError(code, `${PATH_MESSAGES[code] ?? 'The path is invalid.'} (path: ${input})`, {
    path: input,
  })
}

/** 解析路径；失败时抛出 `ToolError`（错误码为 `path.*`，`params.path` 为模型给出的路径）。 */
export async function resolveOrThrow(ctx: ToolContext, input: string): Promise<WorkspacePath> {
  const result = await ctx.resolvePath(input)
  if (result.ok) return result.path
  throw invalidPath(result.code, input)
}

/**
 * 解析可写路径。技能目录里的路径（`readOnly`）拒绝，错误码 `path.read_only`。
 * 写文件和改文件用这个，读文件仍用 `resolveOrThrow`。
 */
export async function resolveWritableOrThrow(
  ctx: ToolContext,
  input: string,
): Promise<WorkspacePath> {
  const result = await ctx.resolvePath(input)
  if (!result.ok) throw invalidPath(result.code, input)
  if (result.readOnly) throw invalidPath('path.read_only', input)
  return result.path
}
