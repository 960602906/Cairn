import { describe, expect, it } from 'vitest'
import { composerCommandQuery, filterComposerCommands } from './composer-commands.js'

describe('composerCommandQuery', () => {
  it('opens for a single slash token at the start', () => {
    expect(composerCommandQuery('/')).toBe('')
    expect(composerCommandQuery('/mo')).toBe('mo')
    expect(composerCommandQuery('/MODEL')).toBe('MODEL')
  })

  it('stays closed outside the leading slash token', () => {
    expect(composerCommandQuery('')).toBeNull()
    expect(composerCommandQuery('  /mo')).toBeNull()
    expect(composerCommandQuery('hi /mo')).toBeNull()
    expect(composerCommandQuery('/mo del')).toBeNull()
    expect(composerCommandQuery('/mo\n')).toBeNull()
  })
})

describe('filterComposerCommands', () => {
  const commands = [
    { name: 'alpha', description: 'beta' },
    { name: 'beta-alpha', description: 'x' },
    { name: 'gamma', description: 'alpha' },
    { name: 'delta', description: 'nothing' },
  ]

  it('keeps registry order for an empty query', () => {
    expect(filterComposerCommands(commands, '').map((command) => command.name)).toEqual([
      'alpha',
      'beta-alpha',
      'gamma',
      'delta',
    ])
  })

  it('ranks name prefixes before name and description matches', () => {
    expect(filterComposerCommands(commands, 'alpha').map((command) => command.name)).toEqual([
      'alpha',
      'beta-alpha',
      'gamma',
    ])
  })

  it('matches case-insensitively and trims the query', () => {
    expect(filterComposerCommands(commands, '  GAMMA ').map((command) => command.name)).toEqual([
      'gamma',
    ])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterComposerCommands(commands, 'zzz')).toEqual([])
  })
})
