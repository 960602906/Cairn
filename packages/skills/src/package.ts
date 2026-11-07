/**
 * 把一份技能的文件收成内存中的包：解析 `SKILL.md`，列出附带文件，标记脚本。
 * 安装与扫描都走这里，避免两套规则。
 */
import { SkillError, SkillErrorCode } from './errors.js'
import {
  isScript,
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTALL_MAX_BYTES,
  SKILL_MAX_FILES,
} from './limits.js'
import { parseSkillMarkdown, type ParsedSkill } from './parse.js'

export interface SkillFile {
  /** 相对技能目录的路径，`/` 分隔，不含 `SKILL.md` 自身。 */
  readonly path: string
  readonly bytes: number
  readonly script: boolean
}

export interface SkillPackage extends ParsedSkill {
  readonly files: readonly SkillFile[]
  readonly hasScripts: boolean
  /** 附带文件超过收录上限，列表只保留前面的一部分。 */
  readonly filesTruncated: boolean
}

/** 技能目录里的一个文件。键是相对路径。 */
export type SkillEntries = ReadonlyMap<string, Uint8Array>

export function skillPackage(entries: SkillEntries): SkillPackage {
  let total = 0
  for (const bytes of entries.values()) {
    total += bytes.byteLength
    if (bytes.byteLength > SKILL_FILE_MAX_BYTES || total > SKILL_INSTALL_MAX_BYTES) {
      throw new SkillError(
        SkillErrorCode.TooLarge,
        `The skill is larger than ${SKILL_INSTALL_MAX_BYTES} bytes.`,
      )
    }
  }
  if (entries.size > SKILL_MAX_FILES) {
    throw new SkillError(
      SkillErrorCode.TooLarge,
      `The skill has more than ${SKILL_MAX_FILES} files.`,
    )
  }
  const markdown = entries.get('SKILL.md')
  if (markdown === undefined) {
    throw new SkillError(SkillErrorCode.Invalid, 'The skill folder must contain SKILL.md.')
  }
  const parsed = parseSkillMarkdown(markdown)
  const files: SkillFile[] = []
  for (const [path, bytes] of entries) {
    if (path === 'SKILL.md') continue
    const head = bytes.subarray(0, 2)
    files.push({ path, bytes: bytes.byteLength, script: isScript(path, head) })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    ...parsed,
    files,
    hasScripts: files.some((file) => file.script),
    filesTruncated: false,
  }
}
