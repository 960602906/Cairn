import { describe, expect, it } from 'vitest'
import { ToolError } from '@cairn/core'
import { createLoadSkillTool, type LoadableSkill } from './load-skill.js'

const skill = (patch: Partial<LoadableSkill> = {}): LoadableSkill => ({
  name: 'house',
  description: 'House style.',
  sha256: 'ab'.repeat(32),
  body: 'Always mention the marker.\n',
  hasScripts: true,
  files: [
    { path: 'refs/guide.md', script: false, readPath: '.cairn/skills/house/refs/guide.md' },
    { path: 'scripts/run.sh', script: true, readPath: '/skills/house/scripts/run.sh' },
  ],
  ...patch,
})

describe('load_skill', () => {
  it('returns the body, the file list, and the name with its hash', async () => {
    const tool = createLoadSkillTool(() => [skill({ filesTruncated: true })])
    const output = await tool.execute({ name: 'house' }, {} as never)
    const text = output.content[0]?.type === 'text' ? output.content[0].text : ''
    expect(text).toContain('# Skill: house')
    expect(text).toContain('House style.')
    expect(text).toContain('Always mention the marker.')
    expect(text).toContain('read_file path .cairn/skills/house/refs/guide.md')
    expect(text).toContain('run_command at /skills/house/scripts/run.sh')
    expect(text).toContain('Some extra files were omitted')
    expect(output.loadedSkill).toEqual({ name: 'house', sha256: 'ab'.repeat(32) })
  })

  it('says there are no extra files', async () => {
    const tool = createLoadSkillTool(() => [skill({ files: [], hasScripts: false })])
    const output = await tool.execute({ name: 'house' }, {} as never)
    const text = output.content[0]?.type === 'text' ? output.content[0].text : ''
    expect(text).toContain('No extra files.')
  })

  it('rejects a name that is not enabled', async () => {
    const tool = createLoadSkillTool(() => [skill()])
    await expect(tool.execute({ name: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'tool.load_skill.not_found',
    })
    await expect(tool.execute({ name: 'missing' }, {} as never)).rejects.toBeInstanceOf(ToolError)
  })
})
