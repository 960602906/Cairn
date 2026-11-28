import fs from 'node:fs'
import type * as fsType from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  errors: new Map<string, Error>(),
  readdir: new Map<string, () => unknown[]>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof fsType
  const base = (actual as unknown as { default?: typeof fsType }).default ?? actual
  const error = (operation: string, target: string) => state.errors.get(`${operation}:${target}`)
  const wrapped = {
    ...base,
    readdirSync: (target: fs.PathLike, options?: unknown) => {
      const override = state.readdir.get(String(target))
      if (override) return override()
      const failure = error('readdir', String(target))
      if (failure) throw failure
      return base.readdirSync(target, options as never)
    },
    statSync: (target: fs.PathLike, options?: unknown) => {
      const failure = error('stat', String(target))
      if (failure) throw failure
      return base.statSync(target, options as never)
    },
    lstatSync: (target: fs.PathLike, options?: unknown) => {
      const failure = error('lstat', String(target))
      if (failure) throw failure
      return base.lstatSync(target, options as never)
    },
    readFileSync: (target: fs.PathLike, options?: unknown) => {
      const failure = error('readFile', String(target))
      if (failure) throw failure
      return base.readFileSync(target, options as never)
    },
  }
  return { ...actual, default: wrapped }
})

const { previewSkill, scanSkillRoot } = await import('./index.js')

const markdown = '---\nname: demo-skill\ndescription: A sample skill.\n---\nbody\n'
const roots: string[] = []

afterEach(() => {
  state.errors.clear()
  state.readdir.clear()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-skill-io-'))
  roots.push(dir)
  return dir
}

function writeSkill(directory: string, text = markdown) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), text)
}

const failure = (code: string) => Object.assign(new Error(code), { code })

const dirent = (name: string, kind: 'file' | 'dir' | 'other') => ({
  name,
  isSymbolicLink: () => false,
  isDirectory: () => kind === 'dir',
  isFile: () => kind === 'file',
})

describe('load：文件系统错误与特殊目录项', () => {
  it('ENOTDIR 视为不存在', () => {
    const root = tempDir()
    state.errors.set(`lstat:${root}`, failure('ENOTDIR'))
    expect(() => previewSkill({ kind: 'directory', path: root })).toThrow(/does not exist/)
  })

  it('跳过 .、..、node_modules 和非普通文件', () => {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'SKILL.md'), markdown)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    // load 会先 realpath；macOS 上 /var → /private/var，mock 必须挂在解析后的路径上
    const real = fs.realpathSync(root)
    const listing = () => [
      dirent('.', 'dir'),
      dirent('..', 'dir'),
      dirent('node_modules', 'dir'),
      dirent('pipe', 'other'),
      dirent('SKILL.md', 'file'),
      dirent('a.txt', 'file'),
    ]
    state.readdir.set(root, listing)
    state.readdir.set(real, listing)
    const preview = previewSkill({ kind: 'directory', path: root })
    expect(preview.files.map((file) => file.path)).toEqual(['a.txt'])
  })
})

describe('scan：文件系统错误', () => {
  it('技能目录不可读时，ENOENT 跳过、其他错误抛出', () => {
    const root = tempDir()
    const skill = path.join(root, 'demo')
    writeSkill(skill)

    state.errors.set(`readdir:${skill}`, failure('ENOENT'))
    expect(scanSkillRoot(root).skills[0]?.skill.files).toEqual([])

    state.errors.set(`readdir:${skill}`, failure('EACCES'))
    expect(() => scanSkillRoot(root)).toThrow(/EACCES/)
  })

  it('读取附带文件元数据失败时，ENOENT 跳过、其他错误抛出', () => {
    const root = tempDir()
    const skill = path.join(root, 'demo')
    writeSkill(skill)
    const file = path.join(skill, 'a.txt')
    fs.writeFileSync(file, 'a')

    state.errors.set(`stat:${file}`, failure('ENOENT'))
    expect(scanSkillRoot(root).skills[0]?.skill.files).toEqual([])

    state.errors.set(`stat:${file}`, failure('EACCES'))
    expect(() => scanSkillRoot(root)).toThrow(/EACCES/)
  })

  it('根目录读取失败时，ENOENT 返回空结果、其他错误抛出', () => {
    const root = tempDir()
    state.errors.set(`readdir:${root}`, failure('ENOENT'))
    expect(scanSkillRoot(root)).toEqual({ skills: [], duplicates: [], skipped: [] })
    state.errors.set(`readdir:${root}`, failure('EACCES'))
    expect(() => scanSkillRoot(root)).toThrow(/EACCES/)
  })

  it('SKILL.md 读取失败（非 SkillError）向上抛出', () => {
    const root = tempDir()
    writeSkill(path.join(root, 'demo'))
    state.errors.set(`readFile:${path.join(root, 'demo', 'SKILL.md')}`, failure('EACCES'))
    expect(() => scanSkillRoot(root)).toThrow(/EACCES/)
  })

  it('目录项顺序相反时仍按名称排序技能与跳过项', () => {
    const root = tempDir()
    writeSkill(path.join(root, 'alpha'), '---\nname: alpha-skill\ndescription: a\n---\n')
    writeSkill(path.join(root, 'zeta'), '---\nname: zeta-skill\ndescription: z\n---\n')
    writeSkill(path.join(root, 'abroken'), 'not a skill')
    writeSkill(path.join(root, 'zbroken'), 'not a skill')
    const actual = fs.readdirSync(root, { withFileTypes: true }) as fs.Dirent[]
    state.readdir.set(root, () => [...actual].reverse())
    const scan = scanSkillRoot(root)
    expect(scan.skills.map((item) => item.skill.name)).toEqual(['alpha-skill', 'zeta-skill'])
    expect(scan.skipped.map((item) => path.basename(item.directory))).toEqual([
      'abroken',
      'zbroken',
    ])
  })
})
