/** 技能名称：小写字母、数字和连字符，与社区 `SKILL.md` 约定一致。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SKILL_NAME_MAX = 64
export const SKILL_DESCRIPTION_MAX = 1024

/** `SKILL.md` 本身的上限。更大的文件不进入上下文。 */
export const SKILL_MARKDOWN_MAX_BYTES = 256 * 1024
/** 安装时全部文件的未压缩大小上限。 */
export const SKILL_INSTALL_MAX_BYTES = 8 * 1024 * 1024
/** 单个附带文件的上限。 */
export const SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024
/** 安装与扫描时最多收录的文件数（不含被跳过的目录）。 */
export const SKILL_MAX_FILES = 200
/** 固定加载进系统提示词的正文上限（字符）。其余仍可通过 `load_skill` 读取。 */
export const SKILL_PIN_MAX_CHARS = 32 * 1024

/** 这些目录不随技能安装，也不算进文件列表。 */
export const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ksh',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.py',
  '.pyw',
  '.rb',
  '.pl',
  '.php',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.command',
  '.exe',
])

/** 附带文件是不是脚本：扩展名、放在 `scripts/` 下，或文件头是 shebang。 */
export function isScript(relativePath: string, head?: Uint8Array): boolean {
  const parts = relativePath.split('/')
  if (parts.includes('scripts')) return true
  const base = parts.at(-1) ?? ''
  const dot = base.lastIndexOf('.')
  if (dot > 0 && SCRIPT_EXTENSIONS.has(base.slice(dot).toLowerCase())) return true
  return head !== undefined && head.length >= 2 && head[0] === 0x23 && head[1] === 0x21
}
