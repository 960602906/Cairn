/**
 * Skills 解析与安装的可预期失败（M3-07）。`code` 与界面文案、RPC 错误码相同。
 */
export const SkillErrorCode = {
  /** `SKILL.md` 缺少必填字段，或内容不是一份技能。 */
  Invalid: 'skills.invalid',
  /** 同名技能已经存在。 */
  Duplicate: 'skills.duplicate',
  /** zip 或目录里的路径逃出了技能目录。 */
  Traversal: 'skills.traversal',
  /** 技能或其中某个文件超过大小上限。 */
  TooLarge: 'skills.too_large',
  /** 要读取的文件夹或压缩包不存在。 */
  NotFound: 'skills.not_found',
} as const

export type SkillErrorCode = (typeof SkillErrorCode)[keyof typeof SkillErrorCode]

export class SkillError extends Error {
  readonly code: SkillErrorCode

  constructor(code: SkillErrorCode, message: string) {
    super(message)
    this.name = 'SkillError'
    this.code = code
  }
}
