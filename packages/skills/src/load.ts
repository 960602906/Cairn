/**
 * 从本地文件夹或 zip 读出一份技能（M3-07）。
 * 只放进内存；写入用户目录由 `installSkill` 做，预览不会改磁盘。
 */
import { unzipSync } from 'fflate'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SkillError, SkillErrorCode } from './errors.js'
import { SKIPPED_DIRECTORIES, SKILL_INSTALL_MAX_BYTES } from './limits.js'
import { skillPackage, type SkillEntries, type SkillPackage } from './package.js'
import { requireSkillRelativePath } from './paths.js'

export type SkillSource =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'zip'; readonly path: string }

const missing = (error: unknown) => {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function unwrapSingleFolder(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (entries.has('SKILL.md')) return entries
  const prefixes = new Set([...entries.keys()].map((item) => item.split('/')[0] ?? ''))
  if (prefixes.size !== 1) {
    throw new SkillError(SkillErrorCode.Invalid, 'The skill archive must contain SKILL.md.')
  }
  const prefix = [...prefixes][0]
  if (!prefix) {
    throw new SkillError(SkillErrorCode.Invalid, 'The skill archive must contain SKILL.md.')
  }
  const stripped = new Map<string, Uint8Array>()
  for (const [item, bytes] of entries) {
    const rest = item.slice(prefix.length + 1)
    if (rest !== '') stripped.set(rest, bytes)
  }
  if (!stripped.has('SKILL.md')) {
    throw new SkillError(SkillErrorCode.Invalid, 'The skill archive must contain SKILL.md.')
  }
  return stripped
}

function entriesFromZip(file: string): Map<string, Uint8Array> {
  let compressed: Buffer
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) {
      throw new SkillError(SkillErrorCode.Invalid, 'The skill archive is not a file.')
    }
    if (stat.size > SKILL_INSTALL_MAX_BYTES) {
      throw new SkillError(
        SkillErrorCode.TooLarge,
        `The skill archive is larger than ${SKILL_INSTALL_MAX_BYTES} bytes.`,
      )
    }
    compressed = fs.readFileSync(file)
  } catch (error) {
    if (error instanceof SkillError) throw error
    if (missing(error)) {
      throw new SkillError(SkillErrorCode.NotFound, 'The skill archive does not exist.')
    }
    throw error
  }
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(new Uint8Array(compressed))
  } catch {
    throw new SkillError(SkillErrorCode.Invalid, 'The skill archive could not be read.')
  }
  const entries = new Map<string, Uint8Array>()
  for (const [entry, bytes] of Object.entries(unzipped)) {
    if (entry.endsWith('/')) continue
    const relative = requireSkillRelativePath(entry)
    entries.set(relative, bytes)
  }
  return unwrapSingleFolder(entries)
}

function entriesFromDirectory(root: string): Map<string, Uint8Array> {
  let real: string
  try {
    const stat = fs.lstatSync(root)
    if (stat.isSymbolicLink()) {
      throw new SkillError(
        SkillErrorCode.Traversal,
        'The skill folder is a symbolic link. Choose the real folder.',
      )
    }
    if (!stat.isDirectory()) {
      throw new SkillError(SkillErrorCode.Invalid, 'The skill source is not a folder.')
    }
    real = fs.realpathSync(root)
  } catch (error) {
    if (error instanceof SkillError) throw error
    if (missing(error)) {
      throw new SkillError(SkillErrorCode.NotFound, 'The skill folder does not exist.')
    }
    throw error
  }
  const entries = new Map<string, Uint8Array>()
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.' || entry.name === '..') continue
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new SkillError(
          SkillErrorCode.Traversal,
          `The skill folder contains a symbolic link (${child}).`,
        )
      }
      if (entry.isDirectory()) {
        walk(abs, child)
        continue
      }
      if (!entry.isFile()) continue
      entries.set(child, fs.readFileSync(abs))
    }
  }
  walk(real, '')
  return entries
}

function loadEntries(source: SkillSource): SkillEntries {
  return source.kind === 'zip' ? entriesFromZip(source.path) : entriesFromDirectory(source.path)
}

/** 读出技能，不写入任何文件。 */
export function previewSkill(source: SkillSource): SkillPackage {
  return skillPackage(loadEntries(source))
}

/**
 * 安装到 `destRoot/<name>/`。目标已存在时报 `skills.duplicate`。
 * 写入先落在临时目录，成功后再改名；失败时删掉临时目录。
 */
export function installSkill(source: SkillSource, destRoot: string): SkillPackage {
  const entries = loadEntries(source)
  const pkg = skillPackage(entries)
  const dest = path.join(destRoot, pkg.name)
  if (fs.existsSync(dest)) {
    throw new SkillError(
      SkillErrorCode.Duplicate,
      `A skill named ${pkg.name} is already installed.`,
    )
  }
  fs.mkdirSync(destRoot, { recursive: true })
  const tmp = path.join(destRoot, `.${pkg.name}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.mkdirSync(tmp)
    for (const [relative, bytes] of entries) {
      const file = path.join(tmp, ...relative.split('/'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    fs.renameSync(tmp, dest)
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw error
  }
  return pkg
}
