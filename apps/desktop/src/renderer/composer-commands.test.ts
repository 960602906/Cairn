import { describe, expect, it } from 'vitest'
import {
  COMPOSER_COMMANDS,
  composerCommandQuery,
  filterComposerCommands,
  goalErrorNoticeKey,
  matchCommandArg,
  parseComposerCommand,
  parseGoalCommand,
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

describe('parseGoalCommand (ADR-0047)', () => {
  it('opens status without arguments and recognizes the control words exactly', () => {
    expect(parseGoalCommand('')).toEqual({ action: 'status' })
    expect(parseGoalCommand('  status ')).toEqual({ action: 'status' })
    expect(parseGoalCommand('pause')).toEqual({ action: 'pause' })
    expect(parseGoalCommand('resume')).toEqual({ action: 'resume' })
    expect(parseGoalCommand('clear')).toEqual({ action: 'clear' })
  })

  it('treats `set` as an empty condition and strips the prefix only for `set `', () => {
    expect(parseGoalCommand('set')).toEqual({ action: 'set', condition: '' })
    expect(parseGoalCommand('set   测试全部通过 ')).toEqual({
      action: 'set',
      condition: '测试全部通过',
    })
    expect(parseGoalCommand('set\n第二行')).toEqual({ action: 'set', condition: 'set\n第二行' })
  })

  it('keeps other text as the condition, including words that look like controls', () => {
    expect(parseGoalCommand('测试全部通过')).toEqual({ action: 'set', condition: '测试全部通过' })
    expect(parseGoalCommand('clear the cache')).toEqual({
      action: 'set',
      condition: 'clear the cache',
    })
    expect(parseGoalCommand('Clear')).toEqual({ action: 'set', condition: 'Clear' })
    expect(parseGoalCommand('resume the migration')).toEqual({
      action: 'set',
      condition: 'resume the migration',
    })
  })

  it('registers /goal with a text argument and maps failures to notices', () => {
    const goal = COMPOSER_COMMANDS.find((command) => command.id === 'goal')
    expect(goal).toMatchObject({
      name: 'goal',
      args: 'text',
      descriptionKey: 'composer.command.goal.hint',
    })
    expect(goalErrorNoticeKey('goal.exists')).toBe('composer.command.goal.exists')
    expect(goalErrorNoticeKey('run.busy')).toBe('composer.command.goal.busy')
    expect(goalErrorNoticeKey('goal.plan_pending')).toBe('composer.command.goal.planPending')
    expect(goalErrorNoticeKey('goal.not_available')).toBe('composer.command.goal.unavailable')
    expect(goalErrorNoticeKey('goal.not_found')).toBe('composer.command.goal.none')
    expect(goalErrorNoticeKey('storage.not_found')).toBe('composer.command.goal.failed')
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
