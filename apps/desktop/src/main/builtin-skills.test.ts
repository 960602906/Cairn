import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseSkillMarkdown } from '@cairn/skills'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SMOKE_SKILL } from '../../scripts/builtin-skill.mjs'
import { resolveBuiltinSkillsDir } from './builtin-skills.js'

describe('resolveBuiltinSkillsDir', () => {
  it('uses the development resources directory outside an installed app', () => {
    expect(
      resolveBuiltinSkillsDir({
        packaged: false,
        moduleDir: path.join('app', 'out', 'main'),
        resourcesPath: path.join('app', 'resources'),
      }),
    ).toBe(path.join('app', 'out', 'main', '../../resources/skills'))
  })

  it('uses extraResources next to app.asar in an installed app', () => {
    expect(
      resolveBuiltinSkillsDir({
        packaged: true,
        moduleDir: path.join('app', 'resources', 'app.asar', 'out', 'main'),
        resourcesPath: path.join('app', 'resources'),
      }),
    ).toBe(path.join('app', 'resources', 'skills'))
  })
})

describe('built-in skills resources', () => {
  const skillsDir = resolveBuiltinSkillsDir({
    packaged: false,
    moduleDir: import.meta.dirname,
    resourcesPath: '',
  })

  it('ships exactly the built-in smoke skill and parses it', () => {
    expect(readdirSync(skillsDir).sort()).toEqual([BUILTIN_SMOKE_SKILL])
    const markdown = readFileSync(path.join(skillsDir, BUILTIN_SMOKE_SKILL, 'SKILL.md'))
    const skill = parseSkillMarkdown(markdown)
    expect(skill.name).toBe(BUILTIN_SMOKE_SKILL)
    expect(skill.description).toContain('Interview the user')
    expect(skill.body).toContain('# Grill me')
  })
})
