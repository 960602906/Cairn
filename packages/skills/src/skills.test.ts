import { strToU8, zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillError, SkillErrorCode } from './errors.js'
import {
  installSkill,
  isScript,
  parseSkillMarkdown,
  previewSkill,
  scanSkillRoot,
  skillPackage,
  skillRelativePath,
  SKILL_FILE_MAX_BYTES,
  SKILL_MAX_FILES,
} from './index.js'

const markdown = (extra = '') =>
  `---\nname: demo-skill\ndescription: A sample skill.\n${extra}---\nFollow the sample steps.\n`

const bytes = (text: string) => new TextEncoder().encode(text)

function catchSkill(fn: () => unknown): SkillError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(SkillError)
    return error as SkillError
  }
  throw new Error('expected a SkillError')
}

describe('parseSkillMarkdown', () => {
  it('保留正文、其余头部字段和内容哈希', () => {
    const raw = bytes(markdown('license: MIT\n'))
    const parsed = parseSkillMarkdown(raw)
    expect(parsed.name).toBe('demo-skill')
    expect(parsed.description).toBe('A sample skill.')
    expect(parsed.frontmatter).toMatchObject({ license: 'MIT', name: 'demo-skill' })
    expect(parsed.body).toBe('Follow the sample steps.\n')
    expect(parsed.sha256).toBe(createHash('sha256').update(raw).digest('hex'))
  })

  it('去掉 BOM，空正文也可以', () => {
    const text = '---\nname: demo-skill\ndescription: A sample skill.\n---'
    const parsed = parseSkillMarkdown(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(text)]))
    expect(parsed.body).toBe('')
    expect(parsed.markdown.startsWith('---')).toBe(true)
  })

  it('缺字段、坏的 YAML、非法名称和过长描述都拒绝', () => {
    expect(catchSkill(() => parseSkillMarkdown(bytes('hello'))).code).toBe(SkillErrorCode.Invalid)
    expect(
      catchSkill(() => parseSkillMarkdown(bytes('---\ndescription: only\n---\nbody\n'))).message,
    ).toContain('name')
    expect(
      catchSkill(() => parseSkillMarkdown(bytes('---\nname: demo-skill\n---\nbody\n'))).message,
    ).toContain('description')
    expect(
      catchSkill(() =>
        parseSkillMarkdown(bytes('---\nname: demo-skill\ndescription: "   "\n---\n')),
      ).message,
    ).toContain('description')
    expect(
      catchSkill(() =>
        parseSkillMarkdown(bytes('---\nname: Demo\ndescription: A sample skill.\n---\n')),
      ).message,
    ).toContain('lowercase')
    expect(
      catchSkill(() =>
        parseSkillMarkdown(bytes('---\nname: [1]\ndescription: A sample skill.\n---\n')),
      ).code,
    ).toBe(SkillErrorCode.Invalid)
    expect(catchSkill(() => parseSkillMarkdown(bytes('---\n: :\n---\n'))).code).toBe(
      SkillErrorCode.Invalid,
    )
    expect(
      catchSkill(() =>
        parseSkillMarkdown(bytes(`---\nname: demo-skill\ndescription: ${'x'.repeat(1025)}\n---\n`)),
      ).code,
    ).toBe(SkillErrorCode.Invalid)
    expect(catchSkill(() => parseSkillMarkdown(new Uint8Array(256 * 1024 + 1))).code).toBe(
      SkillErrorCode.TooLarge,
    )
    expect(catchSkill(() => parseSkillMarkdown(Uint8Array.from([0xff, 0xfe]))).message).toContain(
      'UTF-8',
    )
    expect(catchSkill(() => parseSkillMarkdown(bytes('---\n- a\n- b\n---\n'))).message).toContain(
      'mapping',
    )
    expect(
      catchSkill(() => parseSkillMarkdown(bytes('---\n2020-01-01T00:00:00Z\n---\n'))).message,
    ).toContain('mapping')
    expect(
      catchSkill(() =>
        parseSkillMarkdown(bytes(`---\nname: ${'a'.repeat(65)}\ndescription: ok\n---\n`)),
      ).code,
    ).toBe(SkillErrorCode.Invalid)
  })
})

describe('skillPackage', () => {
  it('拒绝缺少 SKILL.md、单个过大和文件过多', () => {
    expect(
      catchSkill(() => skillPackage(new Map([['readme.txt', bytes('hi')]]))).message,
    ).toContain('SKILL.md')
    const markdownBytes = bytes(markdown())
    expect(
      catchSkill(() =>
        skillPackage(
          new Map([
            ['SKILL.md', markdownBytes],
            ['big.bin', new Uint8Array(SKILL_FILE_MAX_BYTES + 1)],
          ]),
        ),
      ).code,
    ).toBe(SkillErrorCode.TooLarge)
    const many = new Map<string, Uint8Array>([['SKILL.md', markdownBytes]])
    for (let i = 0; i < SKILL_MAX_FILES; i += 1) many.set(`f${i}.txt`, bytes('x'))
    expect(catchSkill(() => skillPackage(many)).code).toBe(SkillErrorCode.TooLarge)
  })
})

describe('skillRelativePath', () => {
  it('拒绝绝对路径和向上跳出', () => {
    expect(skillRelativePath('refs/guide.md')).toBe('refs/guide.md')
    expect(skillRelativePath('a\\b.txt')).toBe('a/b.txt')
    expect(skillRelativePath('../outside.txt')).toBeUndefined()
    expect(skillRelativePath('/etc/passwd')).toBeUndefined()
    expect(skillRelativePath('foo/../../outside.txt')).toBeUndefined()
    expect(skillRelativePath('C:/windows/system.ini')).toBeUndefined()
    expect(skillRelativePath('a/\0/b')).toBeUndefined()
  })
})

describe('isScript', () => {
  it('按扩展名、scripts 目录和 shebang 判断', () => {
    expect(isScript('run.sh')).toBe(true)
    expect(isScript('scripts/notes.md')).toBe(true)
    expect(isScript('refs/guide.md')).toBe(false)
    expect(isScript('bin/tool', Uint8Array.from([0x23, 0x21]))).toBe(true)
  })
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-skill-'))
  roots.push(dir)
  return dir
}

function symlinkDirectory(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

function writeSkill(
  dir: string,
  text = markdown('license: MIT\n'),
  extra: Record<string, string> = {},
) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text)
  for (const [name, contents] of Object.entries(extra)) {
    const file = path.join(dir, ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
}

describe('扫描目录', () => {
  it('读出技能、附带文件和脚本，跳过坏文件与符号链接', () => {
    const root = tempDir()
    writeSkill(path.join(root, 'demo'), markdown('license: MIT\n'), {
      'refs/guide.md': 'guide',
      'scripts/notes.md': 'notes',
      'run.sh': 'echo hi',
    })
    fs.writeFileSync(path.join(root, 'demo', 'bin-tool'), '#!/bin/sh\necho\n')
    writeSkill(path.join(root, 'broken'), 'not a skill')
    symlinkDirectory(path.join(root, 'demo'), path.join(root, 'linked'))
    fs.writeFileSync(path.join(root, 'readme.txt'), 'ignore')
    const missing = scanSkillRoot(path.join(root, 'nope'))
    expect(missing).toEqual({ skills: [], duplicates: [], skipped: [] })

    const scan = scanSkillRoot(root)
    expect(scan.duplicates).toEqual([])
    expect(scan.skipped.map((item) => item.code)).toEqual([SkillErrorCode.Invalid])
    expect(scan.skills).toHaveLength(1)
    const skill = scan.skills[0]!
    expect(skill.skill.name).toBe('demo-skill')
    expect(skill.skill.frontmatter).toMatchObject({ license: 'MIT' })
    expect(skill.skill.hasScripts).toBe(true)
    expect(skill.skill.files.map((file) => [file.path, file.script])).toEqual([
      ['bin-tool', true],
      ['refs/guide.md', false],
      ['run.sh', true],
      ['scripts/notes.md', true],
    ])
  })

  it('同一目录里重名的技能都不收录', () => {
    const root = tempDir()
    writeSkill(path.join(root, 'one'))
    writeSkill(path.join(root, 'two'))
    const scan = scanSkillRoot(root)
    expect(scan.skills).toEqual([])
    expect(scan.duplicates).toEqual(['demo-skill'])
  })

  it('附带文件太多时截断列表，仍然能认出后面的脚本', () => {
    const root = tempDir()
    const extra: Record<string, string> = {}
    for (let i = 0; i < SKILL_MAX_FILES; i += 1)
      extra[`notes/n${String(i).padStart(3, '0')}.md`] = 'n'
    extra['scripts/later.sh'] = 'echo'
    writeSkill(path.join(root, 'demo'), markdown(), extra)
    const scan = scanSkillRoot(root)
    expect(scan.skills[0]?.skill.filesTruncated).toBe(true)
    expect(scan.skills[0]?.skill.files).toHaveLength(SKILL_MAX_FILES)
    expect(scan.skills[0]?.skill.hasScripts).toBe(true)
  })

  it('跳过不是普通文件的 SKILL.md，坏掉的根目录则抛出', () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'weird', 'SKILL.md'), { recursive: true })
    const scan = scanSkillRoot(root)
    expect(scan.skills).toEqual([])
    expect(scan.skipped).toHaveLength(1)
    const file = path.join(tempDir(), 'not-a-dir')
    fs.writeFileSync(file, 'x')
    expect(scanSkillRoot(file)).toEqual({ skills: [], duplicates: [], skipped: [] })
  })

  it('sorts skills and files, and skips ignored folders and folders without SKILL.md', () => {
    const root = tempDir()
    const named = (name: string) => `---\nname: ${name}\ndescription: A sample skill.\n---\nbody\n`
    writeSkill(path.join(root, 'zeta'), named('zeta-skill'), {
      'b.txt': 'b',
      'a.txt': 'a',
    })
    writeSkill(path.join(root, 'alpha'), named('alpha-skill'))
    fs.mkdirSync(path.join(root, 'zeta', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(root, 'zeta', 'node_modules', 'ignored.js'), 'x')
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plain', 'readme.txt'), 'x')
    writeSkill(path.join(root, 'zbroken'), 'not a skill')
    writeSkill(path.join(root, 'abroken'), 'not a skill')

    const scan = scanSkillRoot(root)
    expect(scan.skills.map((item) => item.skill.name)).toEqual(['alpha-skill', 'zeta-skill'])
    expect(scan.skills[1]?.skill.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    expect(scan.skipped).toHaveLength(2)
  })
})

describe('安装', () => {
  it('预览不写盘，确认后写入；再次安装同名技能失败', () => {
    const source = tempDir()
    const dest = tempDir()
    writeSkill(source, markdown(), { 'refs/guide.md': 'guide', 'run.py': 'print(1)\n' })
    const preview = previewSkill({ kind: 'directory', path: source })
    expect(preview.name).toBe('demo-skill')
    expect(preview.hasScripts).toBe(true)
    expect(fs.readdirSync(dest)).toEqual([])
    const installed = installSkill({ kind: 'directory', path: source }, dest)
    expect(installed.sha256).toBe(preview.sha256)
    expect(fs.readFileSync(path.join(dest, 'demo-skill', 'refs/guide.md'), 'utf8')).toBe('guide')
    expect(catchSkill(() => installSkill({ kind: 'directory', path: source }, dest)).code).toBe(
      SkillErrorCode.Duplicate,
    )
  })

  it('拒绝符号链接，并且不留下半截目录', () => {
    const source = tempDir()
    const dest = tempDir()
    writeSkill(source)
    symlinkDirectory(source, path.join(source, 'link-dir'))
    expect(catchSkill(() => installSkill({ kind: 'directory', path: source }, dest)).code).toBe(
      SkillErrorCode.Traversal,
    )
    expect(fs.readdirSync(dest)).toEqual([])
    expect(
      catchSkill(() => previewSkill({ kind: 'directory', path: path.join(source, 'missing') }))
        .code,
    ).toBe(SkillErrorCode.NotFound)
    const file = path.join(source, 'SKILL.md')
    expect(catchSkill(() => previewSkill({ kind: 'directory', path: file })).code).toBe(
      SkillErrorCode.Invalid,
    )
    symlinkDirectory(source, path.join(dest, 'linked-src'))
    expect(
      catchSkill(() => previewSkill({ kind: 'directory', path: path.join(dest, 'linked-src') }))
        .code,
    ).toBe(SkillErrorCode.Traversal)
  })

  it('zip 可以展开唯一的顶层目录，路径穿越整包拒绝', () => {
    const dest = tempDir()
    const zip = path.join(tempDir(), 'skill.zip')
    fs.writeFileSync(
      zip,
      zipSync({
        'demo/SKILL.md': strToU8(markdown()),
        'demo/refs/guide.md': strToU8('guide'),
      }),
    )
    const installed = installSkill({ kind: 'zip', path: zip }, dest)
    expect(installed.files.map((file) => file.path)).toEqual(['refs/guide.md'])
    expect(fs.readFileSync(path.join(dest, 'demo-skill', 'SKILL.md'), 'utf8')).toContain(
      'demo-skill',
    )

    for (const entry of ['../outside.txt', '/etc/passwd', 'foo/../../outside.txt', 'a/\0/b']) {
      const bad = path.join(tempDir(), 'bad.zip')
      fs.writeFileSync(
        bad,
        zipSync({
          'SKILL.md': strToU8(markdown()),
          [entry]: strToU8('nope'),
        }),
      )
      expect(catchSkill(() => previewSkill({ kind: 'zip', path: bad })).code).toBe(
        SkillErrorCode.Traversal,
      )
    }
    expect(fs.readdirSync(dest)).toEqual(['demo-skill'])
  })

  it('打不开的压缩包、缺少 SKILL.md 和过大的包分别报错', () => {
    const dir = tempDir()
    const bad = path.join(dir, 'bad.zip')
    fs.writeFileSync(bad, 'not a zip')
    expect(catchSkill(() => previewSkill({ kind: 'zip', path: bad })).code).toBe(
      SkillErrorCode.Invalid,
    )
    const empty = path.join(dir, 'empty.zip')
    fs.writeFileSync(empty, zipSync({ 'readme.txt': strToU8('hi') }))
    expect(catchSkill(() => previewSkill({ kind: 'zip', path: empty })).code).toBe(
      SkillErrorCode.Invalid,
    )
    expect(
      catchSkill(() => previewSkill({ kind: 'zip', path: path.join(dir, 'missing.zip') })).code,
    ).toBe(SkillErrorCode.NotFound)
    const huge = path.join(dir, 'huge.zip')
    fs.writeFileSync(huge, Buffer.alloc(8 * 1024 * 1024 + 1))
    expect(catchSkill(() => previewSkill({ kind: 'zip', path: huge })).code).toBe(
      SkillErrorCode.TooLarge,
    )
    expect(catchSkill(() => previewSkill({ kind: 'zip', path: dir })).code).toBe(
      SkillErrorCode.Invalid,
    )
    const nested = path.join(dir, 'nested.zip')
    fs.writeFileSync(nested, zipSync({ 'only/readme.txt': strToU8('hi') }))
    expect(catchSkill(() => previewSkill({ kind: 'zip', path: nested })).message).toContain(
      'SKILL.md',
    )
  })

  it('reads a zip with SKILL.md at the root, ignores directory entries and rejects multiple roots', () => {
    const dir = tempDir()
    const flat = path.join(dir, 'flat.zip')
    fs.writeFileSync(
      flat,
      zipSync({
        'SKILL.md': strToU8(markdown()),
        'folder/': new Uint8Array(),
        'refs/guide.md': strToU8('guide'),
      }),
    )
    const pkg = previewSkill({ kind: 'zip', path: flat })
    expect(pkg.name).toBe('demo-skill')
    expect(pkg.files.map((file) => file.path)).toEqual(['refs/guide.md'])

    const multiple = path.join(dir, 'multiple.zip')
    fs.writeFileSync(multiple, zipSync({ 'one/a.txt': strToU8('a'), 'two/b.txt': strToU8('b') }))
    expect(catchSkill(() => previewSkill({ kind: 'zip', path: multiple })).code).toBe(
      SkillErrorCode.Invalid,
    )

    const file = path.join(dir, 'source.txt')
    fs.writeFileSync(file, 'x')
    expect(
      catchSkill(() => previewSkill({ kind: 'directory', path: path.join(file, 'nested') })).code,
    ).toBe(SkillErrorCode.NotFound)
  })
})
