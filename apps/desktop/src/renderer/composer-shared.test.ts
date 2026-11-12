// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@cairn/protocol'
import { availableCommands, commandPanel, parsePrompt } from './composer-shared.js'

const skill = (name: string, enabled = true): SkillSummary => ({
  name,
  description: `${name} description`,
  sha256: 'a'.repeat(64),
  source: 'user',
  enabled,
  pinned: false,
  tokens: { index: 5, pinned: 12 },
  shadowed: false,
  hasScripts: false,
  files: [],
})

const t = (key: string) => key

describe('availableCommands', () => {
  it('offers every command in a session when callbacks exist', () => {
    const commands = availableCommands(
      [],
      t,
      { onOpenPanel: () => {}, onNewChat: () => {}, onOpenSettings: () => {}, undoAvailable: true },
      true,
    )
    expect(commands.map((command) => command.id)).toContain('files')
    expect(commands.map((command) => command.id)).toContain('undo')
    expect(commands.find((command) => command.id === 'undo')?.unavailable).toBeUndefined()
  })

  it('keeps only plan and enabled skills on the new-session page', () => {
    const commands = availableCommands(
      [skill('review'), skill('disabled', false), { ...skill('shadowed'), shadowed: true }],
      t,
      {},
      false,
    )
    expect(commands.map((command) => command.name)).toEqual(['plan', 'review'])
    expect(commands.find((command) => command.name === 'plan')?.description).toBe(
      'composer.command.plan.hint',
    )
  })

  it('marks unavailable commands while a turn is running', () => {
    const commands = availableCommands(
      [],
      t,
      {
        active: true,
        modelMenuDisabled: true,
        undoAvailable: false,
        onOpenPanel: () => {},
        onNewChat: () => {},
        onOpenSettings: () => {},
      },
      true,
    )
    expect(commands.find((command) => command.id === 'compact')?.unavailable).toBe(
      'composer.command.unavailable.running',
    )
    expect(commands.find((command) => command.id === 'model')?.unavailable).toBe(
      'composer.command.unavailable.model',
    )
    // 运行中优先说明「运行中不可用」；没有可撤销轮次时才提示撤销不可用。
    expect(commands.find((command) => command.id === 'undo')?.unavailable).toBe(
      'composer.command.unavailable.running',
    )
    const idle = availableCommands(
      [],
      t,
      {
        undoAvailable: false,
        onOpenPanel: () => {},
        onNewChat: () => {},
        onOpenSettings: () => {},
      },
      true,
    )
    expect(idle.find((command) => command.id === 'undo')?.unavailable).toBe(
      'composer.command.unavailable.undo',
    )
  })
})

describe('commandPanel', () => {
  const commands = availableCommands([skill('review')], t, {}, false)

  it('ranks commands before skills for a query and ignores a dismissed draft', () => {
    const panel = commandPanel('/re', commands, null, 0)
    expect(panel.open).toBe(true)
    expect(panel.filtered.map((command) => command.name)).toEqual(['review'])
    const dismissed = commandPanel('/re', commands, '/re', 0)
    expect(dismissed.open).toBe(false)
    expect(dismissed.filtered).toEqual([])
  })

  it('closes after whitespace and clamps the highlighted index', () => {
    expect(commandPanel('/plan 任务', commands, null, 0).open).toBe(false)
    expect(commandPanel('/', commands, null, 99).activeIndex).toBe(1)
  })
})

describe('parsePrompt', () => {
  const commands = availableCommands([skill('review')], t, {}, false)

  it('toggles plan mode without creating a session', () => {
    expect(parsePrompt('/plan', commands, false)).toEqual({
      draft: '',
      plan: true,
      skills: [],
      toggleOnly: true,
    })
  })

  it('sends a plan task without the command prefix', () => {
    expect(parsePrompt('/plan 整理目录', commands, false)).toEqual({
      draft: '整理目录',
      plan: true,
      skills: [],
      toggleOnly: false,
    })
  })

  it('sends a skill task with the skill payload', () => {
    expect(parsePrompt('/review 看看改动', commands, false)).toEqual({
      draft: '看看改动',
      plan: false,
      skills: ['review'],
      toggleOnly: false,
    })
  })

  it('keeps unknown slash drafts as ordinary messages', () => {
    expect(parsePrompt('/unknown 做点事', commands, false)).toEqual({
      draft: '/unknown 做点事',
      plan: false,
      skills: [],
      toggleOnly: false,
    })
  })
})
