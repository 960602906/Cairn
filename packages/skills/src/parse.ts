/**
 * 解析 `SKILL.md`（M3-07，Runtime §21.2）。
 *
 * YAML 头部里 `name` 与 `description` 必填，其余字段原样保留。正文不改写。
 * 内容哈希是文件原始字节的 SHA-256，便于运行记录追溯。
 */
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { SkillError, SkillErrorCode } from './errors.js'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_MARKDOWN_MAX_BYTES,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
} from './limits.js'

export interface ParsedSkill {
  readonly name: string
  readonly description: string
  /** 头部的全部字段，包括 `name` 与 `description`。 */
  readonly frontmatter: Readonly<Record<string, unknown>>
  /** `---` 之后的正文，保留原文。 */
  readonly body: string
  /** 文件的原文（去掉 BOM 后的文本）。 */
  readonly markdown: string
  readonly sha256: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/** 解析一份 `SKILL.md`。字节超过上限、缺字段或名称不合法时抛出 `SkillError`。 */
export function parseSkillMarkdown(bytes: Uint8Array): ParsedSkill {
  if (bytes.byteLength > SKILL_MARKDOWN_MAX_BYTES) {
    throw new SkillError(
      SkillErrorCode.TooLarge,
      `SKILL.md is larger than ${SKILL_MARKDOWN_MAX_BYTES} bytes.`,
    )
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md is not valid UTF-8.')
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const match = FRONTMATTER.exec(text)
  if (!match) {
    throw new SkillError(
      SkillErrorCode.Invalid,
      'SKILL.md must start with YAML front matter (---) containing name and description.',
    )
  }
  let parsed: unknown
  try {
    parsed = parse(match[1] ?? '')
  } catch {
    throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md front matter is not valid YAML.')
  }
  if (!isPlain(parsed)) {
    throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md front matter must be a mapping.')
  }
  let frontmatter: Record<string, unknown>
  try {
    const json = jsonValue(parsed)
    if (!isPlain(json)) {
      throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md front matter must be a mapping.')
    }
    frontmatter = json
  } catch (error) {
    if (error instanceof SkillError) throw error
    throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md front matter is not plain data.')
  }
  const name = frontmatter['name']
  const description = frontmatter['description']
  if (typeof name !== 'string' || name.trim() === '') {
    throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md is missing a name.')
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new SkillError(SkillErrorCode.Invalid, 'SKILL.md is missing a description.')
  }
  const trimmedName = name.trim()
  const trimmedDescription = description.trim()
  if (
    trimmedName.length > SKILL_NAME_MAX ||
    !SKILL_NAME_PATTERN.test(trimmedName) ||
    trimmedName.includes('/') ||
    trimmedName.includes('\\')
  ) {
    throw new SkillError(
      SkillErrorCode.Invalid,
      'Skill name must be lowercase letters, digits and hyphens, at most 64 characters.',
    )
  }
  if (trimmedDescription.length > SKILL_DESCRIPTION_MAX) {
    throw new SkillError(
      SkillErrorCode.Invalid,
      `Skill description must be at most ${SKILL_DESCRIPTION_MAX} characters.`,
    )
  }
  return {
    name: trimmedName,
    description: trimmedDescription,
    frontmatter,
    body: match[2] ?? '',
    markdown: text,
    sha256,
  }
}
