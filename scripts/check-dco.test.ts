import { describe, expect, it, vi } from 'vitest'
import { checkCommits, commitsInRange, hasSignoff, main, parseLog, signoffs } from './check-dco.mjs'

const SIGNED = 'feat: change\n\nSigned-off-by: Cairn Dev <dev@example.invalid>\n'

describe('signoffs', () => {
  it('extracts every Signed-off-by line', () => {
    expect(
      signoffs(
        'fix: change\n\nSigned-off-by: Cairn Dev <dev@example.invalid>\nSigned-off-by: Other <other@example.invalid>\n',
      ),
    ).toEqual([
      { name: 'Cairn Dev', email: 'dev@example.invalid' },
      { name: 'Other', email: 'other@example.invalid' },
    ])
    expect(signoffs('feat: change\n')).toEqual([])
  })

  it('requires the signer to match the commit author', () => {
    expect(
      hasSignoff({
        message: SIGNED,
        authorName: 'Cairn Dev',
        authorEmail: 'DEV@example.invalid',
      }),
    ).toBe(true)
    expect(
      hasSignoff({
        message: SIGNED,
        authorName: 'Someone Else',
        authorEmail: 'dev@example.invalid',
      }),
    ).toBe(false)
    expect(
      hasSignoff({
        message: SIGNED,
        authorName: 'Cairn Dev',
        authorEmail: 'other@example.invalid',
      }),
    ).toBe(false)
    expect(
      hasSignoff({
        message: 'feat: change\n',
        authorName: 'Cairn Dev',
        authorEmail: 'dev@example.invalid',
      }),
    ).toBe(false)
  })
})

describe('checkCommits', () => {
  it('reports every commit without a matching signoff', () => {
    const problems = checkCommits([
      {
        hash: '1234567890abcdef',
        authorName: 'Cairn Dev',
        authorEmail: 'dev@example.invalid',
        message: SIGNED,
      },
      {
        hash: 'fedcba0987654321',
        authorName: 'Cairn Dev',
        authorEmail: 'dev@example.invalid',
        message: 'fix: unsigned\n',
      },
    ])
    expect(problems).toEqual([
      'fedcba098765 fix: unsigned: missing Signed-off-by: Cairn Dev <dev@example.invalid>',
    ])

    expect(
      checkCommits([
        {
          hash: '0123456789abcdef',
          authorName: 'Cairn Dev',
          authorEmail: 'dev@example.invalid',
          message: 'single line without signoff',
        },
      ]),
    ).toEqual([
      '0123456789ab single line without signoff: missing Signed-off-by: Cairn Dev <dev@example.invalid>',
    ])
  })
})

describe('parseLog', () => {
  it('parses records with messages that contain newlines', () => {
    const output = [
      `abc\u001fCairn Dev\u001fdev@example.invalid\u001ffeat: one\n\nbody\n\u001e`,
      `def\u001fOther\u001fother@example.invalid\u001ffix: two\n\u001e`,
    ].join('')
    expect(parseLog(output)).toEqual([
      {
        hash: 'abc',
        authorName: 'Cairn Dev',
        authorEmail: 'dev@example.invalid',
        message: 'feat: one\n\nbody',
      },
      {
        hash: 'def',
        authorName: 'Other',
        authorEmail: 'other@example.invalid',
        message: 'fix: two',
      },
    ])
    expect(parseLog('')).toEqual([])
  })

  it('asks git for non-merge commits in the range', () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: `abc\u001fCairn Dev\u001fdev@example.invalid\u001ffeat: one\n\nSigned-off-by: Cairn Dev <dev@example.invalid>\n\u001e`,
      stderr: '',
    }))
    const commits = commitsInRange({ base: 'origin/main', head: 'HEAD', runner: runner as never })
    expect(runner).toHaveBeenCalledWith(
      'git',
      ['log', '--no-merges', expect.stringContaining('--format='), 'origin/main..HEAD'],
      expect.objectContaining({ encoding: 'utf8' }),
    )
    expect(commits).toHaveLength(1)

    const failing = vi.fn(() => ({ status: 128, stdout: '', stderr: 'bad revision' }))
    expect(() => commitsInRange({ base: 'nope', runner: failing as never })).toThrow(/bad revision/)

    const bare = vi.fn(() => ({ status: 1 }))
    expect(() => commitsInRange({ base: 'nope', runner: bare as never })).toThrow(/git log failed/)
    const empty = vi.fn(() => ({ status: 0 }))
    expect(commitsInRange({ base: 'origin/main', runner: empty as never })).toEqual([])
  })
})

describe('CLI', () => {
  it('passes when every commit is signed and fails otherwise', () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: `abc\u001fCairn Dev\u001fdev@example.invalid\u001ffeat: one\n\nSigned-off-by: Cairn Dev <dev@example.invalid>\n\u001e`,
      stderr: '',
    }))
    const log = vi.fn()
    expect(main({ argv: ['--base', 'origin/main'], runner: runner as never, log })).toBe(0)
    expect(log).toHaveBeenCalledWith('dco: 1 commits signed off')

    const unsigned = vi.fn(() => ({
      status: 0,
      stdout: `abc\u001fCairn Dev\u001fdev@example.invalid\u001ffeat: one\n\u001e`,
      stderr: '',
    }))
    const error = vi.fn()
    expect(main({ argv: ['--base', 'origin/main'], runner: unsigned as never, error })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('missing Signed-off-by'))
  })

  it('uses console loggers by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const empty = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
      expect(main({ argv: ['--base', 'origin/main'], runner: empty as never })).toBe(0)
      expect(log).toHaveBeenCalledWith('dco: 0 commits signed off')

      const failing = vi.fn(() => ({ status: 128, stdout: '', stderr: 'bad revision' }))
      expect(main({ argv: ['--base', 'origin/main'], runner: failing as never })).toBe(1)
      expect(error).toHaveBeenCalledWith('dco: git log failed: bad revision')
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  it('requires a base commit and reports git failures', () => {
    const error = vi.fn()
    expect(main({ argv: [], env: {}, error })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('usage:'))

    const failing = vi.fn(() => ({ status: 128, stdout: '', stderr: 'bad revision' }))
    expect(
      main({
        argv: ['--base', 'origin/main'],
        runner: failing as never,
        error,
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith('dco: git log failed: bad revision')

    expect(main({ argv: ['--base', '  '], env: {}, error })).toBe(1)
    const empty = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    expect(
      main({ argv: [], env: { GITHUB_BASE_SHA: 'origin/main' }, runner: empty as never }),
    ).toBe(0)
  })

  it('reports non-Error failures from the git runner', () => {
    const error = vi.fn()
    const runner = vi.fn(() => {
      throw 'git unavailable'
    })
    expect(main({ argv: ['--base', 'origin/main'], runner: runner as never, error })).toBe(1)
    expect(error).toHaveBeenCalledWith('dco: git unavailable')
  })
})
