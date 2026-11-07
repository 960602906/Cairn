/**
 * 扫描一个技能根目录（M3-07）：每个直接子目录若含有 `SKILL.md` 就是一份技能。
 * 根目录不存在时返回空结果。解析失败的目录记在 `skipped` 里，不让一份坏文件挡住其余技能。
 * 同一根目录里名称重复的技能都不启用，记在 `duplicates` 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SkillError, type SkillErrorCode } from './errors.js'
import { isScript, SKIPPED_DIRECTORIES, SKILL_FILE_MAX_BYTES, SKILL_MAX_FILES } from './limits.js'
import { parseSkillMarkdown } from './parse.js'
import type { SkillFile, SkillPackage } from './package.js'

export interface ScannedSkill {
  /** 技能目录的绝对路径。 */
  readonly directory: string
  readonly skill: SkillPackage
}

export interface SkippedSkill {
  readonly directory: string
  readonly code: SkillErrorCode
}

export interface SkillScan {
  readonly skills: readonly ScannedSkill[]
  readonly duplicates: readonly string[]
  readonly skipped: readonly SkippedSkill[]
}

const empty: SkillScan = { skills: [], duplicates: [], skipped: [] }

const missing = (error: unknown) => {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function listFiles(root: string): { files: SkillFile[]; hasScripts: boolean; truncated: boolean } {
  const files: SkillFile[] = []
  let hasScripts = false
  let truncated = false
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(abs, child)
        continue
      }
      if (!entry.isFile() || child === 'SKILL.md') continue
      const scriptByName = isScript(child)
      if (files.length >= SKILL_MAX_FILES) {
        truncated = true
        hasScripts = hasScripts || scriptByName
        continue
      }
      let stat: fs.Stats
      let head: Uint8Array | undefined
      try {
        stat = fs.statSync(abs)
        if (stat.size >= 2 && stat.size <= SKILL_FILE_MAX_BYTES) {
          const fd = fs.openSync(abs, 'r')
          try {
            const buf = Buffer.alloc(2)
            fs.readSync(fd, buf, 0, 2, 0)
            head = buf
          } finally {
            fs.closeSync(fd)
          }
        }
      } catch (error) {
        if (missing(error)) continue
        throw error
      }
      const script = scriptByName || isScript(child, head)
      if (script) hasScripts = true
      files.push({ path: child, bytes: stat.size, script })
    }
  }
  walk(root, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, hasScripts, truncated }
}

function scanDirectory(directory: string): SkillPackage {
  const file = path.join(directory, 'SKILL.md')
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SkillError('skills.invalid', 'SKILL.md must be a regular file.')
  }
  const parsed = parseSkillMarkdown(fs.readFileSync(file))
  const listed = listFiles(directory)
  return {
    ...parsed,
    files: listed.files,
    hasScripts: listed.hasScripts,
    filesTruncated: listed.truncated,
  }
}

/** 扫描 `root` 的直接子目录。`root` 不存在时返回空结果。 */
export function scanSkillRoot(root: string): SkillScan {
  let children: fs.Dirent[]
  try {
    children = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (missing(error)) return empty
    throw error
  }
  const found: ScannedSkill[] = []
  const skipped: SkippedSkill[] = []
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue
    const directory = path.join(root, child.name)
    const markdown = path.join(directory, 'SKILL.md')
    if (!fs.existsSync(markdown)) continue
    try {
      found.push({ directory, skill: scanDirectory(directory) })
    } catch (error) {
      if (error instanceof SkillError) {
        skipped.push({ directory, code: error.code })
        continue
      }
      throw error
    }
  }
  const byName = new Map<string, ScannedSkill[]>()
  for (const item of found) {
    const list = byName.get(item.skill.name) ?? []
    list.push(item)
    byName.set(item.skill.name, list)
  }
  const skills: ScannedSkill[] = []
  const duplicates: string[] = []
  for (const [name, group] of byName) {
    if (group.length > 1) duplicates.push(name)
    else if (group[0]) skills.push(group[0])
  }
  duplicates.sort()
  skills.sort((a, b) => (a.skill.name < b.skill.name ? -1 : 1))
  skipped.sort((a, b) => (a.directory < b.directory ? -1 : 1))
  return { skills, duplicates, skipped }
}
