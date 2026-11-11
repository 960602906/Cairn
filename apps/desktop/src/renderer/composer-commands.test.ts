import { describe, expect, it } from 'vitest'
import {
  composerCommandQuery,
  filterComposerCommands,
  matchCommandArg,
  parseComposerCommand,
} from './composer-commands.js'

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

describe('parseComposerCommand', () => {
  const commands = [
    { name: 'plan', args: 'text' },
    { name: 'files', args: 'none' },
  ] as const

  it('reads the leading command and its trimmed arguments', () => {
    expect(parseComposerCommand('/plan', commands)).toEqual({ command: commands[0], args: '' })
    expect(parseComposerCommand('  /plan  重构\n输入框  ', commands)).toEqual({
      command: commands[0],
      args: '重构\n输入框',
    })
    expect(parseComposerCommand('/files', commands)).toEqual({ command: commands[1], args: '' })
  })

  it('leaves unknown names, extra text on no-argument commands and plain text alone', () => {
    expect(parseComposerCommand('/zzz 参数', commands)).toBeUndefined()
    expect(parseComposerCommand('/files 在哪', commands)).toBeUndefined()
    expect(parseComposerCommand('先 /plan', commands)).toBeUndefined()
    expect(parseComposerCommand('', commands)).toBeUndefined()
  })
})

describe('matchCommandArg', () => {
  const items = [
    { id: 'a', names: ['DeepSeek Chat', 'deepseek-chat'] },
    { id: 'b', names: ['DeepSeek Reasoner'] },
    { id: 'c', names: ['强'] },
  ]
  const match = (query: string) => matchCommandArg(query, items, (item) => item.names)?.id

  it('prefers an exact name, then a unique prefix, then a unique substring', () => {
    expect(match('强')).toBe('c')
    expect(match('deepseek-chat')).toBe('a')
    expect(match('deepseekchat')).toBe('a')
    expect(match('deepseek r')).toBe('b')
    expect(match('reason')).toBe('b')
  })

  it('returns nothing for an ambiguous, missing or empty query', () => {
    expect(match('deepseek')).toBeUndefined()
    expect(match('seek')).toBeUndefined()
    expect(match('gpt')).toBeUndefined()
    expect(match('  ')).toBeUndefined()
  })
})
