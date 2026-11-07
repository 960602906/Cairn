/**
 * @cairn/skills —— 技能的解析、扫描与安装（M3-07，Runtime §21.2，ADR-0017）。
 * 兼容社区 `SKILL.md` 约定。不依赖 Electron，也不负责启用状态。
 */
export { SkillError, SkillErrorCode } from './errors.js'
export {
  isScript,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTALL_MAX_BYTES,
  SKILL_MARKDOWN_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  SKILL_PIN_MAX_CHARS,
} from './limits.js'
export { installSkill, previewSkill, type SkillSource } from './load.js'
export { skillPackage, type SkillEntries, type SkillFile, type SkillPackage } from './package.js'
export { parseSkillMarkdown, type ParsedSkill } from './parse.js'
export { skillRelativePath } from './paths.js'
export { scanSkillRoot, type ScannedSkill, type SkillScan, type SkippedSkill } from './scan.js'
