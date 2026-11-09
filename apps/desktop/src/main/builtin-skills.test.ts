import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
