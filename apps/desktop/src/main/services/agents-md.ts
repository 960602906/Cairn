/**
 * 读取项目根目录的 `AGENTS.md`（M3-02）。
 *
 * 文件名不区分大小写；同时有 `AGENTS.md` 和其他大小写时用 `AGENTS.md`。
 * 超过 32 KB 只读前缀，并在正文后注明截断。开关关闭时不读文件。
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS_MD_MAX_BYTES, decodeAgentsMd } from '@cairn/core'

export interface LoadedAgentsMd {
  /** 放进系统提示词的正文（含截断说明，不含标题）。 */
  readonly text: string
  readonly sha256: string
  readonly bytes: number
  readonly truncated: boolean
  readonly lines: number
}

const FILE_NAME = 'agents.md'

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 项目关闭读取时不碰磁盘。读不到或文件是空的时返回 undefined。 */
export function loadProjectAgentsMd(
  project: { readonly path: string; readonly readAgentsMd: boolean },
  read: (root: string) => LoadedAgentsMd | undefined = readAgentsMd,
): LoadedAgentsMd | undefined {
  if (!project.readAgentsMd) return undefined
  return read(project.path)
}

/** 读项目根目录的 `AGENTS.md`。目录不存在时返回 undefined；其他读写错误抛出。 */
export function readAgentsMd(root: string): LoadedAgentsMd | undefined {
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isFile() || entry.isSymbolicLink() ? [entry.name] : [],
    )
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const matches = names.filter((name) => name.toLowerCase() === FILE_NAME).sort()
  const name = matches.find((item) => item === 'AGENTS.md') ?? matches[0]
  if (name === undefined) return undefined

  const file = join(root, name)
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!stat.isFile()) return undefined
  const total = stat.size
  const toRead = Math.min(total, AGENTS_MD_MAX_BYTES)
  const bytes = Buffer.alloc(toRead)
  const fd = openSync(file, 'r')
  try {
    let offset = 0
    while (offset < toRead) {
      const got = readSync(fd, bytes, offset, toRead - offset, offset)
      if (got === 0) break
      offset += got
    }
  } finally {
    closeSync(fd)
  }
  const decoded = decodeAgentsMd(bytes.subarray(0, toRead), total)
  if (!decoded) return undefined
  return {
    text: decoded.text,
    sha256: createHash('sha256').update(decoded.included).digest('hex'),
    bytes: total,
    truncated: decoded.truncated,
    lines: decoded.lines,
  }
}
