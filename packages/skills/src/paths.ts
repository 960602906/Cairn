/**
 * 技能包里的相对路径。zip 与复制文件夹时都用同一套规则，拒绝逃出目录的路径。
 */
import { SkillError, SkillErrorCode } from './errors.js'

/**
 * 把 zip 条目或相对路径收成技能目录内的 `/` 路径。
 * 绝对路径、`..`、盘符和空路径返回 undefined（调用方视为路径穿越）。
 */
export function skillRelativePath(entry: string): string | undefined {
  if (entry.includes('\0')) return undefined
  const slash = entry.replace(/\\/g, '/')
  if (slash.startsWith('/') || /^[a-zA-Z]:/.test(slash)) return undefined
  const parts = slash.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined
  return parts.join('/')
}

export function requireSkillRelativePath(entry: string): string {
  const relative = skillRelativePath(entry)
  if (relative === undefined) {
    throw new SkillError(
      SkillErrorCode.Traversal,
      `The skill archive contains a path that escapes the skill folder (${entry}).`,
    )
  }
  return relative
}
