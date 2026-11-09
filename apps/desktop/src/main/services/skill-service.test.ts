import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@cairn/protocol'
import { createMemoryStorage } from '@cairn/storage'
import { createSkillService, skillReadPath } from './skill-service.js'

const { strToU8, zipSync } = createRequire(
  fileURLToPath(new URL('../../../../../packages/skills/package.json', import.meta.url)),
)('fflate') as {
  strToU8: (text: string) => Uint8Array
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array
}

const markdown = (name: string, description = `${name} description.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`

function writeSkill(root: string, name: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown(name))
  for (const [file, content] of Object.entries(files)) {
    const dest = path.join(dir, ...file.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }
  return dir
}

describe('skillReadPath', () => {
  it('uses a workspace-relative path inside the workspace and an absolute path outside', () => {
    expect(skillReadPath('/work', '/work/.cairn/skills/demo', 'refs/guide.md')).toBe(
      '.cairn/skills/demo/refs/guide.md',
    )
    expect(skillReadPath('/work', '/data/skills/demo', 'refs/guide.md')).toBe(
      path.resolve('/data/skills/demo/refs/guide.md'),
    )
  })
})

describe('skill service', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function setup(pickSource?: (kind: 'directory' | 'zip') => Promise<string | undefined>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-skill-svc-'))
    roots.push(root)
    const builtin = path.join(root, 'builtin')
    const user = path.join(root, 'user')
    const projectPath = path.join(root, 'project')
    fs.mkdirSync(builtin)
    fs.mkdirSync(user)
    writeSkill(builtin, 'example')
    writeSkill(builtin, 'shared', { 'notes.md': 'builtin' })
    writeSkill(path.join(projectPath, '.agents', 'skills'), 'agents')
    writeSkill(path.join(projectPath, '.cairn', 'skills'), 'agents', { 'guide.md': 'cairn' })
    writeSkill(path.join(projectPath, '.cairn', 'skills'), 'local')
    const storage = createMemoryStorage()
    const project = storage.projects.create({
      projectId: 'p1',
      name: 'P',
      path: projectPath,
    })
    storage.sessions.create({
      sessionId: 's1',
      projectId: project.projectId,
      workspacePath: projectPath,
      title: 'S',
    })
    const skills = createSkillService({
      storage,
      builtinDir: builtin,
      userDir: user,
      ...(pickSource ? { pickSource } : {}),
    })
    return { storage, skills, builtin, user, projectPath, project }
  }

  it('lists builtin skills, and project skills unless the project switch is off', () => {
    const { skills, storage } = setup()
    expect(
      skills
        .list({})
        .skills.map((skill) => skill.name)
        .sort(),
    ).toEqual(['example', 'shared'])
    // 项目内技能默认读取；关掉开关后不再列出
    storage.projects.update('p1', { enableProjectSkills: false })
    expect(skills.list({ projectId: 'p1' }).skills.map((skill) => skill.source)).not.toContain(
      'project',
    )
    storage.projects.update('p1', { enableProjectSkills: true })
    const names = skills
      .list({ projectId: 'p1' })
      .skills.map((skill) => `${skill.source}:${skill.name}`)
    expect(names).toContain('project:local')
    expect(names).toContain('project:agents')
  })

  it('rejects an unknown project', () => {
    const { skills } = setup()
    expect(() => skills.list({ projectId: 'missing' })).toThrow(RpcError)
    try {
      skills.list({ projectId: 'missing' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'project.not_found' })
    }
  })

  it('lets a higher-priority enabled skill shadow the others, and stops when it is disabled', () => {
    const { skills, user, storage } = setup()
    writeSkill(user, 'shared', { 'notes.md': 'user' })
    storage.projects.update('p1', { enableProjectSkills: true })
    const listed = skills
      .list({ projectId: 'p1' })
      .skills.filter((skill) => skill.name === 'shared')
    const userCopy = listed.find((skill) => skill.source === 'user')
    const builtinCopy = listed.find((skill) => skill.source === 'builtin')
    expect(userCopy).toMatchObject({ shadowed: false, enabled: true })
    expect(builtinCopy).toMatchObject({ shadowed: true })

    skills.setEnabled({ name: 'shared', source: 'user', enabled: false })
    const after = skills.list({ projectId: 'p1' }).skills.filter((skill) => skill.name === 'shared')
    expect(after.find((skill) => skill.source === 'user')).toMatchObject({
      enabled: false,
      shadowed: false,
    })
    expect(after.find((skill) => skill.source === 'builtin')).toMatchObject({ shadowed: false })
  })

  it('prefers .cairn/skills over .agents/skills for the same name', () => {
    const { skills, storage } = setup()
    storage.projects.update('p1', { enableProjectSkills: true })
    const copies = skills
      .list({ projectId: 'p1' })
      .skills.filter((skill) => skill.name === 'agents')
    expect(copies).toHaveLength(2)
    expect(copies.find((skill) => !skill.shadowed)?.files.map((file) => file.path)).toEqual([
      'guide.md',
    ])
    expect(copies.filter((skill) => skill.shadowed)).toHaveLength(1)
  })

  it('gets a skill and pins it', () => {
    const { skills } = setup()
    expect(skills.get({ name: 'example', source: 'builtin' })).toMatchObject({
      body: 'Body of example.\n',
      pinned: false,
    })
    expect(skills.setEnabled({ name: 'example', source: 'builtin', pinned: true })).toMatchObject({
      pinned: true,
      enabled: true,
    })
    expect(skills.get({ name: 'example', source: 'builtin' }).pinned).toBe(true)
    expect(() => skills.get({ name: 'missing', source: 'user' })).toThrow(RpcError)
  })

  it('picks an install source through the injected picker, or reports a cancel', async () => {
    const picks: string[] = []
    const { skills } = setup(async (kind) => {
      picks.push(kind)
      return kind === 'zip' ? '/tmp/demo.zip' : undefined
    })
    await expect(skills.pickSource({ kind: 'directory' })).resolves.toEqual({})
    await expect(skills.pickSource({ kind: 'zip' })).resolves.toEqual({
      source: { kind: 'zip', path: '/tmp/demo.zip' },
    })
    expect(picks).toEqual(['directory', 'zip'])
    const noPicker = setup()
    await expect(noPicker.skills.pickSource({ kind: 'directory' })).resolves.toEqual({})
  })

  it('estimates the index and pinned tokens of a skill', () => {
    const { skills } = setup()
    const detail = skills.get({ name: 'example', source: 'builtin' })
    expect(detail.tokens.index).toBeGreaterThan(0)
    expect(detail.tokens.pinned).toBeGreaterThan(detail.tokens.index)
    const summary = skills.list({}).skills.find((skill) => skill.name === 'example')
    expect(summary?.tokens).toEqual(detail.tokens)
  })

  it('handles long and empty bodies and reports truncated file lists', () => {
    const { skills, builtin } = setup()
    const huge = path.join(builtin, 'huge')
    fs.mkdirSync(huge)
    fs.writeFileSync(
      path.join(huge, 'SKILL.md'),
      `---\nname: huge\ndescription: Huge skill.\n---\n${'x'.repeat(33 * 1024)}\n`,
    )
    const empty = path.join(builtin, 'empty')
    fs.mkdirSync(empty)
    fs.writeFileSync(
      path.join(empty, 'SKILL.md'),
      '---\nname: empty\ndescription: Empty skill.\n---\n',
    )
    const files: Record<string, string> = {}
    for (let i = 0; i < 201; i += 1) files[`n${i}.txt`] = 'x'
    writeSkill(builtin, 'many', files)

    const listed = skills.list({}).skills
    const hugeSkill = listed.find((skill) => skill.name === 'huge')!
    const emptySkill = listed.find((skill) => skill.name === 'empty')!
    expect(hugeSkill.tokens.pinned).toBeGreaterThan(hugeSkill.tokens.index)
    expect(emptySkill.tokens.pinned).toBe(emptySkill.tokens.index)
    expect(listed.find((skill) => skill.name === 'many')?.filesTruncated).toBe(true)
    expect(skills.get({ name: 'many', source: 'builtin' }).filesTruncated).toBe(true)
    expect(skills.catalog('s1').find((entry) => entry.name === 'many')?.filesTruncated).toBe(true)
  })

  it('previews an install without writing, then installs and refuses a duplicate', () => {
    const { skills, user, root } = (() => {
      const ctx = setup()
      return { ...ctx, root: path.dirname(ctx.user) }
    })()
    const source = writeSkill(path.join(root, 'incoming'), 'marker', { 'notes.md': 'hello' })
    const preview = skills.install({ source: { kind: 'directory', path: source } })
    expect(preview.installed).toBe(false)
    expect(preview.skill).toMatchObject({ name: 'marker', source: 'user', hasScripts: false })
    expect(fs.existsSync(path.join(user, 'marker'))).toBe(false)

    const installed = skills.install({ source: { kind: 'directory', path: source }, confirm: true })
    expect(installed.installed).toBe(true)
    expect(fs.readFileSync(path.join(user, 'marker', 'notes.md'), 'utf8')).toBe('hello')
    expect(() =>
      skills.install({ source: { kind: 'directory', path: source }, confirm: true }),
    ).toThrow(RpcError)
    try {
      skills.install({ source: { kind: 'directory', path: source } })
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills.duplicate' })
    }
  })

  it('downloads a marketplace zip and rejects non-ClawHub hosts', async () => {
    const { skills, user } = setup()
    const zip = zipSync({ 'market/SKILL.md': strToU8(markdown('market')) })
    const fetchMock = vi.fn(async () => new Response(zip, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await skills.installFromUrl({
      url: 'https://clawhub.ai/api/v1/download?slug=market',
    })
    expect(result.installed).toBe(true)
    expect(result.skill.name).toBe('market')
    expect(fs.existsSync(path.join(user, 'market', 'SKILL.md'))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(
      skills.installFromUrl({ url: 'https://example.com/market.zip' }),
    ).rejects.toMatchObject({ code: 'skills.invalid' })
  })

  it('rejects a zip that escapes the skill folder', () => {
    const { skills, user } = setup()
    const zip = path.join(path.dirname(user), 'bad.zip')
    fs.writeFileSync(
      zip,
      zipSync({
        'SKILL.md': strToU8(markdown('bad')),
        '../outside.txt': strToU8('nope'),
      }),
    )
    expect(() => skills.install({ source: { kind: 'zip', path: zip }, confirm: true })).toThrow(
      RpcError,
    )
    try {
      skills.install({ source: { kind: 'zip', path: zip } })
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills.traversal' })
    }
    expect(fs.existsSync(path.join(user, 'bad'))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(user), 'outside.txt'))).toBe(false)
  })

  it('uninstalls a user skill and refuses builtin and project skills', () => {
    const { skills, user, storage } = setup()
    writeSkill(user, 'shared')
    skills.setEnabled({ name: 'shared', source: 'user', pinned: true })
    expect(skills.uninstall({ name: 'shared' })).toEqual({})
    expect(fs.existsSync(path.join(user, 'shared'))).toBe(false)
    expect(storage.skillPrefs.get('global', 'user', 'shared')).toBeUndefined()

    expect(() => skills.uninstall({ name: 'example' })).toThrow(RpcError)
    try {
      skills.uninstall({ name: 'example' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills.not_uninstallable' })
    }
    storage.projects.update('p1', { enableProjectSkills: true })
    try {
      skills.uninstall({ name: 'local' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills.not_uninstallable' })
    }
    try {
      skills.uninstall({ name: 'missing' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills.not_found' })
    }
    try {
      skills.uninstall({ name: '../example' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills.not_found' })
    }
  })

  it('catalog paths are relative inside the workspace and absolute outside it', () => {
    const { skills, user, storage, projectPath } = setup()
    expect(skills.catalog('missing')).toEqual([])
    const source = writeSkill(path.join(path.dirname(user), 'incoming'), 'marker', {
      'notes.md': 'hello',
      'scripts/run.sh': 'echo hi\n',
    })
    skills.install({ source: { kind: 'directory', path: source }, confirm: true })
    storage.projects.update('p1', { enableProjectSkills: true })
    const catalog = skills.catalog('s1')
    const marker = catalog.find((skill) => skill.name === 'marker')
    expect(marker).toMatchObject({ source: 'user', pinned: false, hasScripts: true })
    expect(marker?.files.find((file) => file.path === 'notes.md')?.readPath).toBe(
      path.join(user, 'marker', 'notes.md'),
    )
    const local = catalog.find((skill) => skill.name === 'local')
    expect(local?.root.startsWith(projectPath)).toBe(true)
    expect(local?.files).toEqual([])
    expect(catalog.find((skill) => skill.name === 'agents')?.files[0]?.readPath).toBe(
      '.cairn/skills/agents/guide.md',
    )
    skills.setEnabled({ name: 'marker', source: 'user', enabled: false })
    expect(skills.catalog('s1').some((skill) => skill.name === 'marker')).toBe(false)
  })
})
